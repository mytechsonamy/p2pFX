import { formatDecimal, formatPrice, parsePrice, findPair, isMarketOpen, type Side } from '@p2p/shared';
import { OrderBook, matchIncoming, type BookOrder, type MatchCandidate, type MatchDecision } from '@p2p/matching';
import { fromSnapshot, pricingParams, priceSide, toSnapshot, withoutCommission, type PricingSnapshot } from '@p2p/pricing';
import { CoreBankingError, type CoreBankingAdapter } from '@p2p/core-adapter';
import { hostname } from 'node:os';
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import { tx, type Db, type Queryable } from '../db/pool.js';
import { ApiError } from '../errors.js';
import type { ConfigService } from '../config-service.js';
import type { EventBus } from '../events.js';
import { SettlementService, type SettlementOutcome } from '../settlement.js';
import { LIVE_STATUSES, loadOrder, loadOrders, orderView, remainingOf, requirementFor, type OrderRow } from '../orders.js';
import { audit } from '../audit.js';
import { fillViewFor, tradeView, type FillRow } from '../fills.js';
import { appendEvent, BANK_PRINCIPAL_ID, type LiquiditySource } from '../event-store.js';
import { haltReason } from '../order-entry.js';

const BOOK_DEPTH = 20;
/** Advisory lock held by the one API instance that runs matching against a database. */
const MATCHING_LOCK = 727276;

/**
 * Settlement leg statuses whose customer funds are still owed: not posted yet (PENDING), maybe posted (UNKNOWN_OUTCOME,
 * until a lookup settles it) or failed and waiting for the operations retry, which posts it again from the same holds
 * (FAILED_NEEDS_REVIEW). A hold covering such a leg stays. Only a captured leg (SETTLED, and REVERSAL_PENDING / REVERSED,
 * which were captured before) lets it go.
 */
const OWED_LEG_STATUSES = ['PENDING', 'UNKNOWN_OUTCOME', 'FAILED_NEEDS_REVIEW'];

/** The fill transaction found the order already filled further than the book knew: the book was stale. */
class StaleBookError extends Error {}

/** Serialises all work for one pair: matching, cancels, expiries and bank liquidity generations never interleave. */
class PairWorker {
  readonly book = new OrderBook();
  /** Rows of orders resting in the book. */
  readonly resting = new Map<string, OrderRow>();
  /** Last generation applied per bank liquidity strategy (source:strategy). */
  readonly generations = new Map<string, bigint>();
  private tail: Promise<unknown> = Promise.resolve();

  constructor(readonly pair: string) {}

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => {});
    return next;
  }
}

/** A customer's change to their order, validated by order entry. */
export interface OrderAmendment {
  /** New limit price (PRICE_SCALE units). */
  price: bigint;
  /** New total quantity (filled + remaining), base minor units. */
  qty: bigint;
  /** Pricing of the configuration in force now: the customer confirmed it with the change. */
  pricing: PricingSnapshot;
  configVersion: number;
  /** New qty × price, quote minor units. */
  notional: bigint;
  /** Re-checks the customer's daily limit inside the transaction that changes the order. */
  reserve: (client: pg.PoolClient, current: OrderRow) => Promise<void>;
}

const unprocessableQty = (message: string) => new ApiError(422, 'INVALID_QTY', message);

export interface MatchSummary {
  fills: string[];
}

/** A price level the bank's ladder or bot wants resting in the book. */
export interface LiquidityLevel {
  side: Side;
  price: bigint;
  qty: bigint;
}

/**
 * One generation of bank liquidity for a pair: it replaces every live order of the same source and strategy in a
 * single sequencer step. `levels` empty withdraws the strategy from the pair.
 */
export interface LiquidityCommand {
  pair: string;
  source: Exclude<LiquiditySource, 'CUSTOMER'>;
  strategyId: string;
  /** The bank's trading account in core banking (its orders are booked there). */
  account: { customerId: string; fxAccountId: string; tryAccountId: string };
  levels: LiquidityLevel[];
  /** From `nextGenerationId()`: a generation older than the last one applied is dropped (duplicate or reordered). */
  generationId: bigint;
  /** Why the old orders go: replaced by this generation, or withdrawn (source off, stale feed, halt). */
  reason?: 'REPLACED' | 'WITHDRAWN';
}

export interface GenerationResult {
  applied: boolean;
  generationId: string;
  placed: number;
  removed: number;
  /** Levels cut to keep the bank's inventory within its limit, or outside the price band. */
  skipped: number;
  fills: string[];
}

export interface ExchangeHooks {
  /** LP and Direct prices at the moment of a fill, stored with it as price evidence. */
  evidence?: (pair: string) => Record<string, unknown> | undefined;
  /**
   * How much more the bank may buy (bankSide BUY) or sell of the pair's base, given the base quantity its other
   * liquidity already rests on that side. Undefined: no limit.
   */
  headroom?: (pair: string, bankSide: Side, restingElsewhere: bigint) => bigint | undefined;
  /**
   * Reserves the bank's inventory for a principal execution of `delta` (base minor units, + = the bank buys) before
   * the fill awaits anything, against the same reservations Direct uses; undefined when the hard cap does not allow
   * it. The fill commits the reservation once its transaction commits, and releases it on any other ending.
   */
  reserveExecution?: (pair: string, delta: bigint) => { commit(): void; release(): void } | undefined;
}

/**
 * Runs one in-process matching worker (sequencer) per currency pair and turns matches into fills: holds (in
 * no_block mode), persistence with fee records, principal executions and events, settlement dispatch, hold
 * maintenance, stream events and customer notifications. Bank liquidity (ladder, bot) enters as atomic
 * generations; customer orders are sequenced before or after a generation, never in the middle of one.
 */
export class Exchange {
  private readonly workers = new Map<string, PairWorker>();
  private lock?: pg.PoolClient;
  /** False until this instance holds the matching lock, and again if it loses it. */
  private active = false;
  /** The leadership epoch this instance took with the lock; every matching write checks it (see fence). */
  private epoch?: bigint;
  /** Fills whose legs wait to be posted (ASYNC dispatch), in commit order. */
  private readonly settleQueue: string[] = [];
  private draining?: Promise<void>;

  constructor(
    private readonly db: Db,
    private readonly core: CoreBankingAdapter,
    private readonly config: ConfigService,
    private readonly settlement: SettlementService,
    private readonly events: EventBus,
    private readonly log: FastifyBaseLogger,
    private readonly clock: () => Date = () => new Date(),
    private readonly hooks: ExchangeHooks = {},
  ) {
    settlement.onSettled = (fillId, outcome) => this.afterSettlement(fillId, outcome);
  }

  private worker(pair: string) {
    let w = this.workers.get(pair);
    if (!w) {
      w = new PairWorker(pair);
      this.workers.set(pair, w);
    }
    return w;
  }

  /**
   * Takes the matching lock (only one instance may match against a database: each keeps its own book), then
   * recovers state after a restart: orders interrupted during entry are rejected, pending settlements are
   * finished, orders whose validity ran out while the engine was down are expired, and live orders are
   * replayed in arrival order (so anything that should have matched does).
   */
  async start() {
    const lock = await this.db.connect();
    const { rows } = await lock.query('select pg_try_advisory_lock($1) as ok', [MATCHING_LOCK]);
    if (!rows[0].ok) {
      lock.release();
      throw new Error('another API instance is already running matching against this database; run a single matching instance');
    }
    lock.on('error', (err) => {
      // Losing the connection loses the lock: stop matching rather than risk two engines.
      this.active = false;
      this.log.fatal({ err }, 'matching lock connection lost; matching stopped on this instance');
    });
    this.lock = lock;
    const { rows: led } = await this.db.query(
      `update matching_leader set epoch = epoch + 1, holder = $1, since = now() where id = 1 returning epoch`,
      [`${process.pid}@${hostname()}`],
    );
    this.epoch = BigInt(led[0].epoch);
    this.active = true;

    const interrupted = await loadOrders(this.db, `o.status = 'NEW'`, []);
    for (const o of interrupted) {
      await this.db.query(`update orders set status = 'REJECTED', cancel_reason = 'ENTRY_INTERRUPTED', updated_at = now() where id = $1 and status = 'NEW'`, [o.id]);
      // The hold may exist in core banking without its id ever reaching the database: find it by reference.
      if (o.hold_id) await this.releaseHold(o.hold_id);
      await this.releaseHoldsByRef(`order:${o.id}`);
    }
    await this.settlement.resumePending();
    const due = await loadOrders(this.db, `o.status = any($1) and o.expires_at <= $2 order by o.seq`, [['OPEN', 'PARTIAL', 'QUEUED'], this.clock()]);
    for (const o of due) await this.closeOrder(o, 'EXPIRED', 'EXPIRED');
    // A market order lives for one pass: one interrupted by the restart is not replayed.
    const markets = await loadOrders(this.db, `o.status = any($1) and o.order_type = 'MARKET'`, [LIVE_STATUSES]);
    for (const o of markets) await this.closeOrder(o, 'CANCELLED', 'NO_LIQUIDITY');
    const live = await loadOrders(this.db, `o.status = any($1) order by o.seq`, [LIVE_STATUSES]);
    for (const o of live) await this.submit(o.id);
  }

  /** True while this instance holds the matching lock. */
  get running() {
    return this.active;
  }

  /** At the start of every queued command: work queued before leadership was lost never runs. */
  private assertLeader() {
    if (!this.active) throw new ApiError(503, 'MATCHING_UNAVAILABLE', 'matching is not running on this instance');
  }

  /**
   * Inside each matching write's transaction: the leadership epoch must still be ours. A takeover bumps it (waiting for
   * writes holding the row), so a former leader whose lock connection dropped cannot commit anything after that,
   * whatever its in-memory flag says. On a mismatch this instance stops matching.
   */
  private async fence(client: Queryable) {
    const { rows } = await client.query('select epoch from matching_leader where id = 1 for share');
    if (this.epoch === undefined || BigInt(rows[0].epoch) !== this.epoch) {
      this.active = false;
      this.log.fatal({ ours: this.epoch?.toString(), current: rows[0]?.epoch }, 'matching leadership lost to another instance; matching stopped');
      throw new ApiError(503, 'MATCHING_UNAVAILABLE', 'matching leadership moved to another instance');
    }
  }

  /** Releases the matching lock (shutdown). */
  async stop() {
    this.active = false;
    if (!this.lock) return;
    await this.lock.query('select pg_advisory_unlock($1)', [MATCHING_LOCK]).catch(() => {});
    this.lock.release();
    this.lock = undefined;
  }

  /** Matches a newly accepted order and rests what is left (a market order's remainder is cancelled). */
  submit(orderId: string, pair?: string): Promise<MatchSummary> {
    return (async () => {
      if (!this.active) throw new ApiError(503, 'MATCHING_UNAVAILABLE', 'matching is not running on this instance');
      const p = pair ?? (await loadOrder(this.db, orderId))?.pair;
      if (!p) throw new Error(`order ${orderId} not found`);
      return this.worker(p).run(() => {
        this.assertLeader();
        return this.process(this.worker(p), orderId);
      });
    })();
  }

  /** Cancels (or expires) a live or queued order and releases its hold. Returns the updated row. */
  async cancel(orderId: string, reason: 'USER' | 'EXPIRED' | 'OPS_CANCEL'): Promise<OrderRow | undefined> {
    // Only the instance that holds the book may take an order out of it.
    if (!this.active) throw new ApiError(503, 'MATCHING_UNAVAILABLE', 'matching is not running on this instance');
    const row = await loadOrder(this.db, orderId);
    if (!row) return undefined;
    const w = this.worker(row.pair);
    return w.run(async () => {
      this.assertLeader();
      const current = await loadOrder(this.db, orderId);
      if (!current || !['OPEN', 'PARTIAL', 'QUEUED'].includes(current.status)) return current;
      w.book.remove(orderId);
      w.resting.delete(orderId);
      const updated = await this.closeOrder(current, reason === 'EXPIRED' ? 'EXPIRED' : 'CANCELLED', reason);
      await this.publishBook(w);
      return updated;
    });
  }

  /**
   * Changes a customer's live or queued limit order (price and/or total quantity) in one sequencer step, so the order is
   * never out of the book without its replacement. Keeping the price and lowering the quantity keeps time priority;
   * any other change takes a new sequence number and is matched again at once, like a new arrival.
   *
   * A block-mode hold that must grow is grown first: if core banking refuses, nothing changes. The new pricing (the
   * configuration in force now) and the daily limit are written in the transaction that changes the order.
   */
  async amend(orderId: string, change: OrderAmendment): Promise<OrderRow> {
    if (!this.active) throw new ApiError(503, 'MATCHING_UNAVAILABLE', 'matching is not running on this instance');
    const row = await loadOrder(this.db, orderId);
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'order not found');
    const w = this.worker(row.pair);
    return w.run(async () => {
      this.assertLeader();
      const current = (await loadOrder(this.db, orderId))!;
      if (!['OPEN', 'PARTIAL', 'QUEUED'].includes(current.status)) throw new ApiError(409, 'ORDER_NOT_AMENDABLE', `order is ${current.status}`);
      const oldPrice = parsePrice(current.book_price);
      if (oldPrice === change.price && current.qty === change.qty) return current;
      if (change.qty <= current.filled_qty) {
        throw unprocessableQty(`quantity must be more than the ${formatDecimal(current.filled_qty, current.pricing.baseDecimals)} already filled`);
      }
      const keepPriority = change.price === oldPrice && change.qty <= current.qty;
      const amended: OrderRow = { ...current, book_price: formatPrice(change.price, 8), qty: change.qty, pricing: change.pricing };

      // Block mode: the hold must cover the amended remainder (and fills still owed) before the order changes.
      let grown: { holdId: string; back: bigint } | undefined;
      if (current.hold_id) {
        if (await this.inDoubt(current)) {
          throw new ApiError(409, 'AMEND_UNAVAILABLE', 'a trade of this order is still being confirmed; try again shortly');
        }
        const before = await this.holdTarget(current);
        const after = await this.holdTarget(amended);
        if (after > before) {
          try {
            await this.core.adjustHold(current.hold_id, after);
          } catch (err) {
            if (err instanceof CoreBankingError && err.code === 'INSUFFICIENT_FUNDS') {
              throw new ApiError(422, 'INSUFFICIENT_BALANCE', 'insufficient balance for the amended order');
            }
            // The hold may or may not have grown: a hold task puts it back to what the unchanged order needs.
            await this.holdTask(current.hold_id, 'ADJUST', before, err);
            throw new ApiError(503, 'CORE_UNAVAILABLE', 'core banking unavailable');
          }
          await this.supersede(current.hold_id, 'ADJUST');
          grown = { holdId: current.hold_id, back: before };
        }
      }

      try {
        await tx(this.db, async (client) => {
          await this.fence(client);
          await change.reserve(client, current);
          const res = await client.query(
            `update orders set book_price = $2, qty = $3, pricing = $4, config_version = $5, notional = $6, amended_at = now(), updated_at = now(),
                seq = case when $7 then seq else nextval(pg_get_serial_sequence('orders', 'seq')) end
              where id = $1 and status in ('OPEN', 'PARTIAL', 'QUEUED') and filled_qty = $8`,
            [orderId, formatPrice(change.price, 8), change.qty, change.pricing, change.configVersion, change.notional, keepPriority, current.filled_qty],
          );
          if (res.rowCount !== 1) throw new ApiError(409, 'ORDER_CHANGED', 'the order changed meanwhile; review it and try again');
          await appendEvent(client, {
            type: 'OrderAmended', aggregateType: 'order', aggregateId: orderId, pair: current.pair, correlationId: current.idempotency_key,
            configVersion: change.configVersion,
            payload: {
              from: { price: formatPrice(oldPrice), qty: current.qty.toString() },
              to: { price: formatPrice(change.price), qty: change.qty.toString() },
              keepPriority,
            },
          });
        });
      } catch (err) {
        if (grown) await this.adjustHold(grown.holdId, grown.back);
        throw err;
      }

      w.book.remove(orderId);
      w.resting.delete(orderId);
      let updated = (await loadOrder(this.db, orderId))!;
      if (LIVE_STATUSES.includes(updated.status)) {
        if (keepPriority) this.rest(w, updated);
        else await this.process(w, orderId, false);
        updated = (await loadOrder(this.db, orderId))!;
      }
      // A smaller order gives back what its hold no longer needs (fills above already kept it in step).
      if (updated.hold_id && !grown) await this.maintainHold(updated);
      await audit(this.db, updated.customer_ref, 'order.amended', {
        orderId, from: { price: formatPrice(oldPrice), qty: current.qty.toString() }, to: { price: formatPrice(change.price), qty: change.qty.toString() }, keepPriority,
      });
      await this.publishBook(w);
      await this.publishOrder(updated).catch((err) => this.log.warn({ err }, 'order publish failed'));
      return updated;
    });
  }

  /**
   * Operations (kill switch): cancels every live or queued order in scope, each in its pair's sequencer. Bank
   * liquidity of a source that stays switched on is entered again on its next generation.
   */
  async cancelOrders(scope: { pair?: string; source?: LiquiditySource }): Promise<number> {
    const rows = await loadOrders(
      this.db,
      `o.status in ('OPEN', 'PARTIAL', 'QUEUED') and ($1::text is null or o.pair = $1) and ($2::text is null or o.source = $2) order by o.seq`,
      [scope.pair ?? null, scope.source ?? null],
    );
    let n = 0;
    for (const r of rows) if ((await this.cancel(r.id, 'OPS_CANCEL'))?.status === 'CANCELLED') n++;
    return n;
  }

  depth(pair: string) {
    const w = this.workers.get(pair);
    const config = this.config.get().data;
    const cfg = findPair(config, pair);
    const decimals = cfg?.baseDecimals ?? 2;
    const disclose = config.sourceDisclosure;
    const view = (side: Side) =>
      (w?.book.depth(side, BOOK_DEPTH, disclose) ?? []).map((l) => {
        const level: { price: string; qty: string; count: number; bankQty?: string } = { price: formatPrice(l.price), qty: formatDecimal(l.qty, decimals), count: l.count };
        if (disclose) level.bankQty = formatDecimal((l.bySource?.BANK_MM ?? 0n) + (l.bySource?.BOT_MM ?? 0n), decimals);
        return level;
      });
    return { pair, bids: view('BUY'), asks: view('SELL') };
  }

  /** Raw price levels of one side, best first (market order estimates). */
  levels(pair: string, side: Side) {
    return this.workers.get(pair)?.book.depth(side, BOOK_DEPTH) ?? [];
  }

  /** Base quantity the bank (ladder and bot together, or one of them) rests on a side of a pair right now. */
  bankResting(pair: string, side: Side, except?: { source: string; strategyId: string }): bigint {
    const w = this.workers.get(pair);
    if (!w) return 0n;
    let sum = 0n;
    for (const o of w.book.orders()) {
      if (o.principalId !== BANK_PRINCIPAL_ID || o.side !== side) continue;
      const row = w.resting.get(o.id);
      if (except && row && row.source === except.source && row.strategy_id === except.strategyId) continue;
      sum += o.remaining;
    }
    return sum;
  }

  /** Best price resting on a side, leaving out one strategy's own orders. */
  bestPrice(pair: string, side: Side, except?: { source: string; strategyId: string }): bigint | undefined {
    const w = this.workers.get(pair);
    if (!w) return undefined;
    let best: bigint | undefined;
    for (const o of w.book.orders()) {
      if (o.side !== side) continue;
      const row = w.resting.get(o.id);
      if (except && row && row.source === except.source && row.strategy_id === except.strategyId) continue;
      if (best === undefined || (side === 'BUY' ? o.price > best : o.price < best)) best = o.price;
    }
    return best;
  }

  /** Strategies of a source with live orders on a pair (from the book). */
  strategies(pair: string, source: string): string[] {
    const w = this.workers.get(pair);
    if (!w) return [];
    return [...new Set([...w.resting.values()].filter((r) => r.source === source && r.strategy_id).map((r) => r.strategy_id as string))];
  }

  /** The live orders of one bank liquidity strategy on a pair (from the book). */
  liquidity(pair: string, source: string, strategyId: string) {
    const w = this.workers.get(pair);
    if (!w) return [];
    return [...w.resting.values()]
      .filter((r) => r.source === source && r.strategy_id === strategyId)
      .map((r) => ({ id: r.id, side: r.side, price: parsePrice(r.book_price), qty: r.qty, remaining: remainingOf(r) }));
  }

  /** Waits for all queued work on every pair, and for dispatched settlements (tests, shutdown). */
  async idle() {
    await Promise.all([...this.workers.values()].map((w) => w.run(async () => {})));
    while (this.draining) await this.draining;
  }

  /** A new generation id for a bank liquidity command (monotonic across the deployment). */
  async nextGenerationId(): Promise<bigint> {
    const { rows } = await this.db.query(`select nextval('liquidity_generation_seq') as id`);
    return BigInt(rows[0].id);
  }

  // ---- bank liquidity ----

  /**
   * Replaces one bank liquidity strategy's orders on a pair in a single sequencer step: its live orders are taken
   * out, the new levels go in in a deterministic order (asks then bids, best price first, as given), any level that
   * crosses the book trades at the resting order's price, and one book update is published. A command that fails
   * before its transaction commits changes nothing (no half-applied ladder). Levels are cut where they would take
   * the bank's inventory past its limit, or fall outside the price band.
   */
  replaceLiquidity(cmd: LiquidityCommand): Promise<GenerationResult> {
    if (!this.active) return Promise.reject(new ApiError(503, 'MATCHING_UNAVAILABLE', 'matching is not running on this instance'));
    const w = this.worker(cmd.pair);
    return w.run(async () => {
      this.assertLeader();
      const key = `${cmd.source}:${cmd.strategyId}`;
      const result: GenerationResult = { applied: false, generationId: cmd.generationId.toString(), placed: 0, removed: 0, skipped: 0, fills: [] };
      const last = w.generations.get(key);
      if (last !== undefined && cmd.generationId <= last) return result;

      const { data: config, version } = this.config.get();
      const pair = findPair(config, cmd.pair);
      const channelOn = cmd.source === 'BANK_MM' ? config.channels.bankMarketMaker : config.channels.botMarketMaker;
      const wanted = pair && pair.enabled && channelOn && !haltReason(config, cmd.pair, 'bank') ? cmd.levels : [];
      const levels = await this.admissible(cmd, wanted, result);

      const old = [...w.resting.values()].filter((r) => r.source === cmd.source && r.strategy_id === cmd.strategyId);
      const now = this.clock();
      const expiresAt = new Date(now.getTime() + config.validity.maxValidityDays * 86_400_000);
      const inserted: string[] = [];
      await tx(this.db, async (client) => {
        await this.fence(client);
        if (old.length) {
          await client.query(
            `update orders set status = 'CANCELLED', cancel_reason = $2, updated_at = now() where id = any($1) and status in ('OPEN', 'PARTIAL')`,
            [old.map((o) => o.id), cmd.reason ?? 'REPLACED'],
          );
        }
        for (const [i, l] of levels.entries()) {
          const params = withoutCommission({ ...pricingParams(config, pair!, l.side), taxRate: 0n });
          const notional = priceSide(l.qty, l.price, params).notional;
          const { rows } = await client.query(
            `insert into orders (customer_id, principal_id, source, strategy_id, generation_id, order_type, pair, side, book_price, qty, validity,
               expires_at, fx_account_id, try_account_id, status, pricing, config_version, balance_mode, notional, idempotency_key, request_hash)
             values ($1, $2, $3, $4, $5, 'LIMIT', $6, $7, $8, $9, 'GTC', $10, $11, $12, 'OPEN', $13, $14, 'no_block', $15, $16, 'generation')
             returning id`,
            [
              cmd.account.customerId, BANK_PRINCIPAL_ID, cmd.source, cmd.strategyId, cmd.generationId.toString(), cmd.pair, l.side, formatPrice(l.price, 8),
              l.qty, expiresAt, cmd.account.fxAccountId, cmd.account.tryAccountId, toSnapshot(params), version, notional, `gen:${cmd.generationId}:${i}`,
            ],
          );
          inserted.push(rows[0].id);
        }
        await appendEvent(client, {
          type: 'LiquidityGenerationReplaced', aggregateType: 'generation', aggregateId: `${cmd.pair}:${key}`, pair: cmd.pair,
          correlationId: `gen:${cmd.generationId}`, configVersion: version,
          payload: {
            source: cmd.source, strategyId: cmd.strategyId, generationId: cmd.generationId.toString(), reason: cmd.reason ?? 'REPLACED',
            removed: old.map((o) => o.id), added: levels.map((l, i) => ({ id: inserted[i], side: l.side, price: formatPrice(l.price), qty: l.qty.toString() })),
          },
        });
      });

      // Committed: the watermark moves only now, so a command whose transaction failed can be sent again as it was.
      w.generations.set(key, cmd.generationId);
      // Swap in the book. If anything fails from here on, the generation is withdrawn as a whole (see below), so the
      // database and the book never disagree about which of its orders are live.
      try {
        for (const o of old) {
          w.book.remove(o.id);
          w.resting.delete(o.id);
          if (o.hold_id) await this.releaseHold(o.hold_id);
        }
        result.removed = old.length;
        for (const id of inserted) {
          const r = await this.process(w, id, false);
          result.fills.push(...r.fills);
          result.placed++;
        }
        result.applied = true;
      } catch (err) {
        this.log.error({ err, pair: cmd.pair, generationId: cmd.generationId.toString() }, 'bank liquidity generation failed after commit; withdrawing it');
        await this.withdrawGeneration(w, inserted, old.map((o) => o.id));
        throw err;
      } finally {
        await this.publishBook(w);
      }
      return result;
    });
  }

  /**
   * Recovery of a generation that failed after its transaction committed: every one of its orders still live in the
   * database is cancelled (bank liquidity comes back with the next generation), and the book is rebuilt from the
   * database for all of them, the orders they replaced and everything resting, so the book matches the database.
   */
  private async withdrawGeneration(w: PairWorker, inserted: string[], replaced: string[]) {
    const ids = [...inserted, ...replaced, ...w.book.orders().map((o) => o.id)];
    try {
      for (const id of inserted) {
        w.book.remove(id);
        w.resting.delete(id);
        const row = await loadOrder(this.db, id);
        if (row && LIVE_STATUSES.includes(row.status)) await this.closeOrder(row, 'CANCELLED', 'GENERATION_FAILED');
      }
    } catch (err) {
      this.log.error({ err, pair: w.pair }, 'withdrawing a failed generation failed; startup recovery replays the database');
    }
    await this.resync(w, ids).catch((err) => this.log.error({ err, pair: w.pair }, 'book resync after a failed generation failed'));
  }

  /** The levels of a command that may go in: inside the price band and within the bank's inventory headroom. */
  private async admissible(cmd: LiquidityCommand, levels: LiquidityLevel[], result: GenerationResult): Promise<LiquidityLevel[]> {
    if (!levels.length) return [];
    const pair = findPair(this.config.get().data, cmd.pair)!;
    let ref: bigint | undefined;
    try {
      ref = parsePrice((await this.core.getReferenceRate(cmd.pair)).rate);
    } catch {
      // Without a reference rate the band cannot be checked: no bank liquidity goes in.
      result.skipped += levels.length;
      return [];
    }
    const band = parsePrice(pair.priceBandPct);
    const tick = parsePrice(pair.tickSize);
    const left: Record<Side, bigint | undefined> = { BUY: undefined, SELL: undefined };
    for (const side of ['BUY', 'SELL'] as const) {
      left[side] = this.hooks.headroom?.(cmd.pair, side, this.bankResting(cmd.pair, side, { source: cmd.source, strategyId: cmd.strategyId }));
    }
    const out: LiquidityLevel[] = [];
    for (const l of levels) {
      const diff = l.price > ref ? l.price - ref : ref - l.price;
      if (l.qty <= 0n || l.price <= 0n || l.price % tick !== 0n || diff * 100n * 10n ** 8n > band * ref) {
        result.skipped++;
        continue;
      }
      const room = left[l.side];
      if (room !== undefined) {
        // The bank's orders on a side together never exceed what it may still buy (or sell): a full fill of every
        // level keeps the position within the limit.
        if (room <= 0n) {
          result.skipped++;
          continue;
        }
        const qty = l.qty < room ? l.qty : room;
        left[l.side] = room - qty;
        out.push({ ...l, qty });
        continue;
      }
      out.push(l);
    }
    return out;
  }

  // ---- matching ----

  private async process(w: PairWorker, orderId: string, publish = true): Promise<MatchSummary> {
    const taker = await loadOrder(this.db, orderId);
    if (!taker || !LIVE_STATUSES.includes(taker.status) || w.book.has(orderId)) return { fills: [] };

    const fills: string[] = [];
    const skipped: string[] = [];
    let current = taker;
    const now = this.clock();
    const market = taker.order_type === 'MARKET';
    if (taker.expires_at <= now) {
      await this.closeOrder(taker, 'EXPIRED', 'EXPIRED');
      return { fills };
    }
    // Outside trading hours nothing matches; a limit order rests until the market opens.
    if (!isMarketOpen(now, this.config.get().data.tradingHours)) {
      if (market) await this.closeOrder(taker, 'CANCELLED', 'MARKET_CLOSED');
      else this.rest(w, taker);
      if (publish) await this.publishBook(w);
      return { fills };
    }

    const takerBook = bookOrder(taker);
    try {
      const result = await matchIncoming(
        w.book,
        takerBook,
        async (c) => {
          // Every fill is a new decision: the taker's validity and the session are checked again, not only on arrival
          // (an earlier fill's settlement can take long enough for either to run out).
          const at = this.clock();
          if (current.expires_at <= at) return { action: 'cancelTaker', reason: 'EXPIRED' };
          if (!isMarketOpen(at, this.config.get().data.tradingHours)) return market ? { action: 'cancelTaker', reason: 'MARKET_CLOSED' } : { action: 'stop' };
          const maker = w.resting.get(c.maker.id)!;
          // A maker past its validity is expired here, not traded, even if the scheduler has not reached it yet.
          if (maker.expires_at <= at) {
            w.resting.delete(maker.id);
            await this.closeOrder(maker, 'EXPIRED', 'EXPIRED');
            return { action: 'cancelMaker', reason: 'EXPIRED' };
          }
          const outcome = await this.tryFill(w, current, maker, c);
          if (outcome.action === 'filled') {
            fills.push(outcome.fillId);
            current = outcome.taker;
            const updatedMaker = outcome.maker;
            if (updatedMaker.status === 'FILLED') w.resting.delete(maker.id);
            else w.resting.set(maker.id, updatedMaker);
            return { action: 'filled' };
          }
          if (outcome.action === 'skipMaker') {
            w.resting.delete(maker.id);
            skipped.push(maker.id);
            return outcome;
          }
          if (outcome.action === 'cancelMaker') {
            w.resting.delete(maker.id);
            await this.closeOrder(maker, outcome.reason === 'EXPIRED' ? 'EXPIRED' : 'CANCELLED', outcome.reason);
          }
          return outcome;
        },
        { selfTrade: this.config.get().data.selfTradePrevention, rest: !market },
      );

      // Makers self trade prevention took out (CANCEL_MAKER).
      for (const m of result.cancelledMakers.filter((m) => m.reason === 'SELF_MATCH')) {
        const row = w.resting.get(m.id);
        w.resting.delete(m.id);
        if (row) await this.closeOrder(row, 'CANCELLED', 'SELF_MATCH');
      }
      if (result.takerCancelled) {
        current = (await loadOrder(this.db, orderId))!;
        await this.closeOrder(current, result.takerCancelled === 'EXPIRED' ? 'EXPIRED' : 'CANCELLED', result.takerCancelled);
      } else if (result.rested) {
        w.resting.set(orderId, current);
      }
    } catch (err) {
      // Something failed before a fill committed (the fill transaction rolls back as a whole). The book may
      // have half-applied the match, so it is rebuilt from the database for the orders involved.
      this.log.error({ err, orderId }, 'matching failed; resyncing the book from the database');
      await this.resync(w, [orderId, ...w.book.orders().map((o) => o.id)]);
      await this.publishBook(w);
      throw err;
    }
    // Makers the book had a stale view of are put back with their real remaining quantity.
    if (skipped.length) await this.resync(w, skipped);
    if (publish) await this.publishBook(w);
    return { fills };
  }

  /** Puts orders back in the book exactly as the database has them (live with something left, or gone). */
  private async resync(w: PairWorker, ids: string[]) {
    for (const id of new Set(ids)) {
      const row = await loadOrder(this.db, id);
      w.book.remove(id);
      w.resting.delete(id);
      if (row && LIVE_STATUSES.includes(row.status) && remainingOf(row) > 0n && row.order_type !== 'MARKET') this.rest(w, row);
    }
  }

  private rest(w: PairWorker, o: OrderRow) {
    if (w.book.has(o.id) || remainingOf(o) <= 0n) return;
    w.book.add(bookOrder(o));
    w.resting.set(o.id, o);
  }

  /**
   * Executes one candidate match. In no_block mode it first places holds on both
   * sides; an order whose hold fails is cancelled with INSUFFICIENT_BALANCE.
   */
  private async tryFill(
    w: PairWorker,
    taker: OrderRow,
    maker: OrderRow,
    c: MatchCandidate,
  ): Promise<
    | { action: 'filled'; fillId: string; taker: OrderRow; maker: OrderRow }
    | Exclude<MatchDecision, { action: 'filled' }>
  > {
    const buy = taker.side === 'BUY' ? taker : maker;
    const sell = taker.side === 'SELL' ? taker : maker;
    // The bank's inventory cap holds at the fill too (the ladder was cut to it, but Direct deals move the position):
    // the capacity is reserved now, before the holds and the transaction are awaited, so a Direct deal or another
    // fill in that window cannot take the same headroom.
    const bankOrder = buy.principal_id === BANK_PRINCIPAL_ID ? buy : sell.principal_id === BANK_PRINCIPAL_ID ? sell : undefined;
    const bankOnly = buy.principal_id === BANK_PRINCIPAL_ID && sell.principal_id === BANK_PRINCIPAL_ID;
    let reservation: { commit(): void; release(): void } | undefined;
    if (bankOrder && !bankOnly && this.hooks.reserveExecution) {
      reservation = this.hooks.reserveExecution(w.pair, bankOrder === buy ? c.qty : -c.qty);
      if (!reservation) {
        return bankOrder.id === taker.id ? { action: 'cancelTaker', reason: 'INVENTORY_LIMIT' } : { action: 'cancelMaker', reason: 'INVENTORY_LIMIT' };
      }
    }
    try {
      return await this.fillWithReservation(w, taker, maker, c, buy, sell, reservation);
    } finally {
      // Any ending but a committed fill (no-op after commit).
      reservation?.release();
    }
  }

  private async fillWithReservation(
    w: PairWorker,
    taker: OrderRow,
    maker: OrderRow,
    c: MatchCandidate,
    buy: OrderRow,
    sell: OrderRow,
    reservation: { commit(): void } | undefined,
  ): Promise<
    | { action: 'filled'; fillId: string; taker: OrderRow; maker: OrderRow }
    | Exclude<MatchDecision, { action: 'filled' }>
  > {
    const releasePlaced = async () => {
      for (const h of placed) await this.releaseHold(h);
    };
    const buyParams = fromSnapshot(buy.pricing);
    const sellParams = fromSnapshot(sell.pricing);
    const buyer = priceSide(c.qty, c.price, buyParams);
    const seller = priceSide(c.qty, c.price, sellParams);

    // Holds for this fill: the order's own hold in block mode, a fresh one in no_block mode.
    const placed: string[] = [];
    const holdFor = async (o: OrderRow, accountId: string, amount: bigint) => {
      if (o.balance_mode === 'block') return o.hold_id ? [o.hold_id] : [];
      const { holdId } = await this.core.placeHold(accountId, amount, `order:${o.id}`);
      placed.push(holdId);
      return [holdId];
    };
    let sellHolds: string[];
    let buyHolds: string[];
    // Taker first: if the incoming order is short, it is the one cancelled and matching stops.
    const first = taker.side === 'SELL' ? 'sell' : 'buy';
    let stage: 'sell' | 'buy' = first;
    try {
      if (first === 'sell') {
        sellHolds = await holdFor(sell, sell.fx_account_id, c.qty);
        stage = 'buy';
        buyHolds = await holdFor(buy, buy.try_account_id, buyer.total);
      } else {
        buyHolds = await holdFor(buy, buy.try_account_id, buyer.total);
        stage = 'sell';
        sellHolds = await holdFor(sell, sell.fx_account_id, c.qty);
      }
    } catch (err) {
      for (const h of placed) await this.releaseHold(h);
      const short = stage === 'sell' ? sell : buy;
      const reason = err instanceof CoreBankingError && err.code === 'INSUFFICIENT_FUNDS' ? 'INSUFFICIENT_BALANCE' : 'CORE_UNAVAILABLE';
      if (reason === 'CORE_UNAVAILABLE') this.log.error({ err, orderId: short.id }, 'hold failed at match time');
      return short.id === taker.id ? { action: 'cancelTaker', reason } : { action: 'cancelMaker', reason };
    }

    const cfg = this.config.get();
    const bankBuys = buy.principal_id === BANK_PRINCIPAL_ID;
    const bankSells = sell.principal_id === BANK_PRINCIPAL_ID;
    const flow = buy.source === 'CUSTOMER' && sell.source === 'CUSTOMER' ? 'C2C' : 'C2B';
    let evidence: Record<string, unknown> | undefined;
    try {
      evidence = this.hooks.evidence?.(w.pair);
    } catch (err) {
      this.log.warn({ err, pair: w.pair }, 'price evidence unavailable');
    }
    const priceEvidence = {
      ...evidence,
      bookGeneration: { maker: maker.generation_id, taker: taker.generation_id },
      makerSource: maker.source,
      takerSource: taker.source,
    };
    let committed: { fillId: string; fill: FillRow; updated: Record<string, OrderRow> };
    try {
      committed = await tx(this.db, async (client) => {
        await this.fence(client);
        const { rows } = await client.query(
          `insert into fills (pair, maker_order_id, taker_order_id, buy_order_id, sell_order_id, book_price, qty, notional,
             buyer_effective_price, seller_effective_price, buyer_commission, seller_commission, buyer_tax, seller_tax,
             buyer_total, seller_total, config_version, buyer_principal_id, seller_principal_id, maker_source, taker_source, flow, price_evidence)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) returning *`,
          [
            w.pair, maker.id, taker.id, buy.id, sell.id, formatPrice(c.price, 8), c.qty, buyer.notional,
            formatPrice(buyer.effectivePrice, 8), formatPrice(seller.effectivePrice, 8),
            buyer.commission, seller.commission, buyer.tax, seller.tax, buyer.total, seller.total, cfg.version,
            buy.principal_id, sell.principal_id, maker.source, taker.source, flow, json(priceEvidence),
          ],
        );
        const fill = rows[0] as FillRow;
        const updated: Record<string, OrderRow> = {};
        for (const o of [taker, maker]) {
          // Guarded: an order the book thought had more left than it really has never trades past its quantity.
          const res = await client.query(
            `update orders set filled_qty = filled_qty + $2,
               status = case when filled_qty + $2 = qty then 'FILLED' else 'PARTIAL' end, updated_at = now()
             where id = $1 and status = any($3) and filled_qty + $2 <= qty`,
            [o.id, c.qty, LIVE_STATUSES],
          );
          if (res.rowCount !== 1) throw new StaleBookError(o.id);
          updated[o.id] = (await loadOrder(client, o.id))!;
        }
        for (const [leg, holds] of [['BANK_BUY', sellHolds], ['BANK_SELL', buyHolds]] as const) {
          await client.query(
            `insert into settlements (fill_id, leg, idempotency_key, hold_ids, status) values ($1, $2, $3, $4, 'PENDING')`,
            [fill.id, leg, SettlementService.idempotencyKey(fill.id, leg), holds],
          );
        }
        const fillEvent = await appendEvent(client, {
          type: 'FillCommitted', aggregateType: 'fill', aggregateId: fill.id, pair: w.pair, correlationId: fill.id, causationId: taker.id,
          configVersion: cfg.version,
          payload: { maker: maker.id, taker: taker.id, buy: buy.id, sell: sell.id, price: formatPrice(c.price), qty: c.qty.toString(), flow, makerSource: maker.source, takerSource: taker.source },
        });
        // Fee records: one per customer side, under the fee policy (configuration version) the customer confirmed.
        for (const [o, side, leg, s, p] of [
          [buy, 'BUY', 'BANK_SELL', buyer, buyParams],
          [sell, 'SELL', 'BANK_BUY', seller, sellParams],
        ] as const) {
          if (o.source !== 'CUSTOMER') continue;
          await client.query(
            `insert into fee_records (fill_id, side, leg, currency, fee_mode, fee_rate, fee_amount, policy_version) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [fill.id, side, leg, w.pair.slice(3), p.feeMode, formatPrice(p.feeMode === 'BPS' ? p.commissionRate : s.commissionPerUnit, 8), s.commission, o.config_version],
          );
        }
        // The bank is principal on one side (ladder or bot): a principal execution, the source of its position.
        if (bankBuys !== bankSells) {
          const bankOrder = bankBuys ? buy : sell;
          const delta = bankBuys ? c.qty : -c.qty;
          await client.query(
            `insert into principal_executions (channel, ref_id, pair, source, bank_side, qty, price, position_delta, reference, config_version)
             values ('BOARD', $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [fill.id, w.pair, bankOrder.source, bankBuys ? 'BUY' : 'SELL', c.qty, formatPrice(c.price, 8), delta, json(priceEvidence), cfg.version],
          );
          await appendEvent(client, {
            type: 'PrincipalExecutionCommitted', aggregateType: 'execution', aggregateId: fill.id, pair: w.pair, correlationId: fill.id, causationId: fillEvent,
            configVersion: cfg.version, payload: { channel: 'BOARD', source: bankOrder.source, bankSide: bankBuys ? 'BUY' : 'SELL', qty: c.qty.toString(), price: formatPrice(c.price), positionDelta: delta.toString() },
          });
        }
        await audit(client, 'system', 'fill', { fillId: fill.id, pair: w.pair, buy: buy.id, sell: sell.id, qty: c.qty, price: formatPrice(c.price), flow });
        return { fillId: fill.id as string, fill, updated };
      });
    } catch (err) {
      await releasePlaced();
      if (err instanceof StaleBookError) {
        this.log.error({ orderId: err.message, pair: w.pair }, 'book was stale for an order; resyncing it');
        if (err.message === taker.id) return { action: 'cancelTaker', reason: 'STALE' };
        return { action: 'skipMaker' };
      }
      throw err;
    }
    const { fillId, fill, updated } = committed;

    // The fill is committed and firm: from here on nothing may undo it in the book. The bank's reserved capacity
    // becomes position now (not when settlement finishes), and settlement is dispatched; failures are logged and left
    // to recovery.
    try {
      reservation?.commit();
    } catch (err) {
      this.log.error({ err, fillId }, 'position update after a fill failed');
    }
    await this.announceFill(fill, updated[buy.id], updated[sell.id]).catch((err) =>
      this.log.error({ err, fillId }, 'announcing a fill failed; clients pick it up on their next load'),
    );
    if (this.config.get().data.settlement.dispatch === 'INLINE') {
      try {
        await this.settlement.settle(fillId);
      } catch (err) {
        this.log.error({ err, fillId }, 'settlement interrupted; it resumes from the pending legs');
      }
    } else {
      this.dispatch(fillId);
    }
    return { action: 'filled', fillId, taker: updated[taker.id], maker: updated[maker.id] };
  }

  // ---- settlement dispatch (the fill's PENDING legs are its outbox) ----

  private dispatch(fillId: string) {
    this.settleQueue.push(fillId);
    if (!this.draining) {
      this.draining = this.drain().finally(() => {
        this.draining = undefined;
      });
    }
  }

  private async drain() {
    for (let id = this.settleQueue.shift(); id; id = this.settleQueue.shift()) {
      // A former leader sends nothing more to core banking: the legs stay PENDING for the new leader's recovery.
      if (!this.active) {
        this.settleQueue.length = 0;
        return;
      }
      try {
        await this.settlement.settle(id);
      } catch (err) {
        // The legs stay PENDING: the scheduler resumes them.
        this.log.error({ err, fillId: id }, 'settlement interrupted; it resumes from the pending legs');
      }
    }
  }

  /**
   * After each settlement run of a fill (dispatcher, scheduler, startup recovery or an operations retry): per-fill
   * holds of no_block orders are released once their leg is captured (never while it is pending, unknown or failed
   * and waiting for a retry), block-mode order holds are brought to what the orders still owe, and the customers hear
   * about a settlement status they have not been told yet.
   */
  async afterSettlement(fillId: string, outcome: SettlementOutcome) {
    try {
      const { rows } = await this.db.query('select * from fills where id = $1', [fillId]);
      const fill = rows[0] as FillRow | undefined;
      if (!fill) return;
      const buy = (await loadOrder(this.db, fill.buy_order_id))!;
      const sell = (await loadOrder(this.db, fill.sell_order_id))!;
      const { rows: legs } = await this.db.query('select leg, status, hold_ids from settlements where fill_id = $1', [fillId]);
      for (const leg of legs) {
        const o = leg.leg === 'BANK_BUY' ? sell : buy;
        if (o.balance_mode === 'block' || OWED_LEG_STATUSES.includes(leg.status)) continue;
        for (const h of leg.hold_ids as string[]) await this.releaseHold(h);
      }
      for (const o of [buy, sell]) if (o.balance_mode === 'block' && o.hold_id) await this.maintainHold(o);
      if (fill.notified_status !== outcome) {
        await tx(this.db, async (client) => {
          await client.query('update fills set notified_status = $2 where id = $1', [fillId, outcome]);
          await appendEvent(client, {
            type: 'SettlementUpdated', aggregateType: 'settlement', aggregateId: fillId, pair: fill.pair, correlationId: fillId,
            payload: { outcome, legs: legs.map((l) => l.leg) },
          });
        });
        await this.announceSettlement(fill, buy, sell, outcome);
      }
    } catch (err) {
      this.log.error({ err, fillId }, 'hold maintenance or announcement after settlement failed');
    }
  }

  /**
   * What a block-mode order's hold must still cover: the remaining quantity while the order is live, plus the fills
   * whose leg is still owed (pending, unknown or failed and waiting for a retry: core banking captures them from this
   * hold when it books them).
   */
  private async holdTarget(o: OrderRow): Promise<bigint> {
    const live = ['OPEN', 'PARTIAL', 'QUEUED'].includes(o.status);
    const open = live ? requirementFor(o, remainingOf(o)) : 0n;
    const leg = o.side === 'BUY' ? 'BANK_SELL' : 'BANK_BUY';
    const amount = o.side === 'BUY' ? 'f.buyer_total' : 'f.qty';
    const { rows } = await this.db.query(
      `select coalesce(sum(${amount}), 0)::bigint as pending from fills f join settlements s on s.fill_id = f.id and s.leg = $2
        where (f.buy_order_id = $1 or f.sell_order_id = $1) and s.status = any($3)`,
      [o.id, leg, OWED_LEG_STATUSES],
    );
    return open + BigInt(rows[0].pending);
  }

  /**
   * Whether a leg of the order's side has an unknown outcome: core banking may or may not have captured it from the
   * hold already, so the hold is left exactly as core banking has it until a lookup settles the leg (resizing it to
   * the target would hold the same funds twice if the leg was captured, and releasing it would free them if not).
   */
  private async inDoubt(o: OrderRow): Promise<boolean> {
    const { rows } = await this.db.query(
      `select 1 from fills f join settlements s on s.fill_id = f.id and s.leg = $2
        where (f.buy_order_id = $1 or f.sell_order_id = $1) and s.status = 'UNKNOWN_OUTCOME' limit 1`,
      [o.id, o.side === 'BUY' ? 'BANK_SELL' : 'BANK_BUY'],
    );
    return rows.length > 0;
  }

  private async maintainHold(o: OrderRow) {
    if (await this.inDoubt(o)) return;
    const target = await this.holdTarget(o);
    if (target === 0n) await this.releaseHold(o.hold_id!);
    else await this.adjustHold(o.hold_id!, target);
  }

  // ---- helpers ----

  private async closeOrder(o: OrderRow, status: 'CANCELLED' | 'EXPIRED', reason: string): Promise<OrderRow> {
    await tx(this.db, async (client) => {
      await this.fence(client);
      const res = await client.query(
        `update orders set status = $2, cancel_reason = $3, updated_at = now() where id = $1 and status in ('NEW', 'QUEUED', 'OPEN', 'PARTIAL')`,
        [o.id, status, reason],
      );
      if (res.rowCount) {
        await appendEvent(client, {
          type: 'OrderCancelled', aggregateType: 'order', aggregateId: o.id, pair: o.pair, correlationId: o.idempotency_key,
          payload: { status, reason, source: o.source, filledQty: o.filled_qty.toString() },
        });
      }
    });
    const updated = (await loadOrder(this.db, o.id))!;
    // A block-mode hold keeps covering fills not booked yet; the rest of it goes back to the customer.
    if (o.hold_id) await this.maintainHold(updated);
    await audit(this.db, 'system', `order.${status.toLowerCase()}`, { orderId: o.id, reason });
    if (o.source !== 'CUSTOMER') return updated;
    await this.publishOrder(updated).catch((err) => this.log.warn({ err }, 'order publish failed'));
    const partial = updated.filled_qty > 0n;
    const title = status === 'EXPIRED' ? 'Emrinizin süresi doldu' : partial ? 'Emrinizin kalanı iptal edildi' : 'Emriniz iptal edildi';
    const why: Record<string, string> = {
      USER: 'İsteğiniz üzerine iptal edildi.',
      EXPIRED: 'Geçerlilik süresi sona erdi.',
      SELF_MATCH: 'Kendi emrinizle eşleşeceği için iptal edildi.',
      INSUFFICIENT_BALANCE: 'Eşleşme anında bakiyeniz yetersiz olduğu için iptal edildi.',
      CORE_UNAVAILABLE: 'Bankacılık sistemine ulaşılamadığı için iptal edildi.',
      STALE: 'Teknik bir tutarsızlık nedeniyle iptal edildi; lütfen emrinizi yeniden girin.',
      NO_LIQUIDITY: 'Piyasa emrinin koruma fiyatı içinde karşılanamayan kısmı iptal edildi.',
      MARKET_CLOSED: 'Piyasa kapalı olduğu için piyasa emri işlenmedi.',
      OPS_CANCEL: 'Banka operasyonu tarafından iptal edildi.',
    };
    await this.notify(o.customer_ref, { type: `order.${status.toLowerCase()}`, title, body: why[reason] ?? reason, data: { orderId: o.id } });
    return updated;
  }

  /** At commit: the trade on the tape, both orders, and each customer's fill (settlement still pending). */
  private async announceFill(fill: FillRow, buy: OrderRow, sell: OrderRow) {
    const config = this.config.get().data;
    await this.events.publish({ type: 'trade', pair: fill.pair, trade: tradeView(fill, config) });
    for (const o of [buy, sell]) {
      if (o.source !== 'CUSTOMER') continue;
      await this.publishOrder(o);
      await this.events.publish({ type: 'fill', customerId: o.customer_id, fill: fillViewFor(fill, o.side, config, { status: 'PENDING', receipt_ref: null }) });
    }
  }

  /** After settlement: each customer's fill with its settlement status, and a notification. */
  private async announceSettlement(fill: FillRow, buy: OrderRow, sell: OrderRow, outcome: SettlementOutcome) {
    const config = this.config.get().data;
    const settled = outcome === 'SETTLED';
    for (const o of [buy, sell]) {
      if (o.source !== 'CUSTOMER') continue;
      const { rows } = await this.db.query('select status, receipt_ref from settlements where fill_id = $1 and leg = $2', [
        fill.id,
        o.side === 'BUY' ? 'BANK_SELL' : 'BANK_BUY',
      ]);
      const view = fillViewFor(fill, o.side, config, rows[0]);
      await this.events.publish({ type: 'fill', customerId: o.customer_id, fill: view });
      const what = o.side === 'BUY' ? 'Döviz alış emriniz' : 'Döviz satış emriniz';
      await this.notify(o.customer_ref, {
        type: 'fill',
        // "Gerçekleşti" only once the bank has booked the trade.
        title: settled ? `${what} gerçekleşti` : `${what} eşleşti, banka işlemi inceleniyor`,
        body: `${view.qty} ${fill.pair.slice(0, 3)} @ ${view.effectivePrice}`,
        data: { fillId: fill.id, orderId: o.id },
      });
    }
  }

  private async publishOrder(o: OrderRow) {
    await this.events.publish({ type: 'order', customerId: o.customer_id, order: orderView(o, this.config.get().data) });
  }

  private async publishBook(w: PairWorker) {
    await this.events.publish({ type: 'book', ...this.depth(w.pair) }).catch((err) => this.log.warn({ err, pair: w.pair }, 'book publish failed'));
  }

  private async notify(customerRef: string, event: { type: string; title: string; body: string; data?: unknown }) {
    await this.core.notify(customerRef, event).catch((err) => this.log.warn({ err }, 'notify failed'));
  }

  /**
   * Releases a hold; if core banking does not confirm it, a hold task retries it until it does. A confirmed
   * release supersedes every change still queued for the hold.
   */
  async releaseHold(holdId: string) {
    try {
      await this.core.releaseHold(holdId);
    } catch (err) {
      return this.holdTask(holdId, 'RELEASE', null, err);
    }
    await this.supersede(holdId);
  }

  /**
   * Releases every hold core banking has under a reference (a hold whose id never reached us: lost response,
   * crash). If the lookup or a release fails, a hold task repeats the whole cleanup until it succeeds.
   */
  async releaseHoldsByRef(ref: string) {
    try {
      for (const h of await this.core.findHolds(ref)) await this.releaseHold(h);
    } catch (err) {
      this.log.warn({ err, ref }, 'hold cleanup by reference failed; queued for retry');
      await this.db
        .query(`insert into hold_tasks (ref, action, last_error) values ($1, 'RELEASE_BY_REF', $2)`, [ref, (err as Error)?.message ?? String(err)])
        .catch((e) => this.log.error({ err: e, ref }, 'could not queue the hold cleanup'));
    }
  }

  private async adjustHold(holdId: string, amount: bigint) {
    try {
      await this.core.adjustHold(holdId, amount);
    } catch (err) {
      return this.holdTask(holdId, 'ADJUST', amount, err);
    }
    await this.supersede(holdId, 'ADJUST');
  }

  /** Marks queued changes of a hold done after a newer change was confirmed (all of them, or only adjustments). */
  private async supersede(holdId: string, action?: 'ADJUST') {
    await this.db
      .query(`update hold_tasks set done = true, last_error = 'superseded', updated_at = now() where hold_id = $1 and not done and ($2::text is null or action = $2)`, [
        holdId,
        action ?? null,
      ])
      .catch((err) => this.log.warn({ err, holdId }, 'could not mark queued hold changes superseded'));
  }

  private async holdTask(holdId: string, action: 'RELEASE' | 'ADJUST', amount: bigint | null, err: unknown) {
    this.log.warn({ err, holdId, action }, 'hold change failed; queued for retry');
    await this.db
      .query('insert into hold_tasks (hold_id, action, amount, last_error) values ($1, $2, $3, $4)', [holdId, action, amount, (err as Error)?.message ?? String(err)])
      .catch((e) => this.log.error({ err: e, holdId, action }, 'could not queue the hold change'));
  }

  /**
   * Retries queued hold changes. A queued amount is never replayed blindly: per hold, a pending release wins;
   * otherwise the target is worked out from the order's current state (what its remaining quantity and its fills
   * not booked yet need now; released when that is nothing).
   */
  async retryHoldTasks() {
    const { rows } = await this.db.query('select * from hold_tasks where not done order by id');
    for (const t of rows.filter((r) => r.action === 'RELEASE_BY_REF')) {
      try {
        for (const h of await this.core.findHolds(t.ref)) await this.core.releaseHold(h);
        await this.db.query('update hold_tasks set done = true, updated_at = now() where id = $1', [t.id]);
      } catch (err) {
        await this.db.query('update hold_tasks set attempts = attempts + 1, last_error = $2, updated_at = now() where id = $1', [t.id, (err as Error).message]);
      }
    }
    const byHold = new Map<string, Record<string, any>[]>();
    for (const r of rows.filter((r) => r.hold_id)) byHold.set(r.hold_id, [...(byHold.get(r.hold_id) ?? []), r]);
    for (const [holdId, tasks] of byHold) {
      const ids = tasks.map((t) => t.id);
      try {
        let release = tasks.some((t) => t.action === 'RELEASE');
        let target: bigint | undefined;
        if (!release) {
          const o = (await loadOrders(this.db, 'o.hold_id = $1', [holdId]))[0];
          // Left for a later run while a leg it covers is in doubt (see inDoubt).
          if (o && (await this.inDoubt(o))) continue;
          target = o ? await this.holdTarget(o) : 0n;
          if (target === 0n) release = true;
        }
        if (release) await this.core.releaseHold(holdId);
        else await this.core.adjustHold(holdId, target!);
        await this.db.query('update hold_tasks set done = true, updated_at = now() where id = any($1)', [ids]);
      } catch (err) {
        // A hold core banking no longer has is as good as released.
        const gone = err instanceof CoreBankingError && err.code === 'NOT_FOUND';
        await this.db.query('update hold_tasks set done = $2, attempts = attempts + 1, last_error = $3, updated_at = now() where id = any($1)', [
          ids,
          gone,
          (err as Error).message,
        ]);
      }
    }
  }
}

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

function bookOrder(o: OrderRow): BookOrder {
  return {
    id: o.id,
    principalId: o.principal_id,
    side: o.side,
    price: parsePrice(o.book_price),
    remaining: remainingOf(o),
    seq: o.seq,
    source: o.source,
  };
}

export type { Queryable };
