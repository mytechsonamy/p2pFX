import { formatDecimal, formatPrice, parsePrice, findPair, isMarketOpen, type Side } from '@p2p/shared';
import { OrderBook, matchIncoming, type BookOrder, type MatchCandidate, type MatchDecision } from '@p2p/matching';
import { fromSnapshot, priceSide } from '@p2p/pricing';
import { CoreBankingError, type CoreBankingAdapter } from '@p2p/core-adapter';
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import { tx, type Db } from '../db/pool.js';
import { ApiError } from '../errors.js';
import type { ConfigService } from '../config-service.js';
import type { EventBus } from '../events.js';
import { SettlementService } from '../settlement.js';
import { LIVE_STATUSES, loadOrder, loadOrders, orderView, remainingOf, requirementFor, type OrderRow } from '../orders.js';
import { audit } from '../audit.js';
import { fillViewFor, tradeView, type FillRow } from '../fills.js';

const BOOK_DEPTH = 20;
/** Advisory lock held by the one API instance that runs matching against a database. */
const MATCHING_LOCK = 727276;

/** The fill transaction found the order already filled further than the book knew: the book was stale. */
class StaleBookError extends Error {}

/** Serialises all work for one pair: matching, cancels and expiries never interleave. */
class PairWorker {
  readonly book = new OrderBook();
  /** Rows of orders resting in the book. */
  readonly resting = new Map<string, OrderRow>();
  private tail: Promise<unknown> = Promise.resolve();

  constructor(readonly pair: string) {}

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => {});
    return next;
  }
}

export interface MatchSummary {
  fills: string[];
}

/**
 * Runs one in-process matching worker per currency pair and turns matches into
 * fills: holds (in no_block mode), persistence, settlement, hold maintenance,
 * events and customer notifications.
 */
export class Exchange {
  private readonly workers = new Map<string, PairWorker>();
  private lock?: pg.PoolClient;
  /** False until this instance holds the matching lock, and again if it loses it. */
  private active = false;

  constructor(
    private readonly db: Db,
    private readonly core: CoreBankingAdapter,
    private readonly config: ConfigService,
    private readonly settlement: SettlementService,
    private readonly events: EventBus,
    private readonly log: FastifyBaseLogger,
    private readonly clock: () => Date = () => new Date(),
  ) {}

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
    this.active = true;

    const interrupted = await loadOrders(this.db, `o.status = 'NEW'`, []);
    for (const o of interrupted) {
      await this.db.query(`update orders set status = 'REJECTED', cancel_reason = 'ENTRY_INTERRUPTED', updated_at = now() where id = $1 and status = 'NEW'`, [o.id]);
      // The hold may exist in core banking without its id ever reaching the database: find it by reference.
      const holds = new Set(o.hold_id ? [o.hold_id] : []);
      for (const h of await this.core.findHolds(`order:${o.id}`).catch(() => [])) holds.add(h);
      for (const h of holds) await this.releaseHold(h);
    }
    await this.settlement.resumePending();
    const due = await loadOrders(this.db, `o.status = any($1) and o.expires_at <= $2 order by o.seq`, [['OPEN', 'PARTIAL', 'QUEUED'], this.clock()]);
    for (const o of due) await this.closeOrder(o, 'EXPIRED', 'EXPIRED');
    const live = await loadOrders(this.db, `o.status = any($1) order by o.seq`, [LIVE_STATUSES]);
    for (const o of live) await this.submit(o.id);
  }

  /** True while this instance holds the matching lock. */
  get running() {
    return this.active;
  }

  /** Releases the matching lock (shutdown). */
  async stop() {
    this.active = false;
    if (!this.lock) return;
    await this.lock.query('select pg_advisory_unlock($1)', [MATCHING_LOCK]).catch(() => {});
    this.lock.release();
    this.lock = undefined;
  }

  /** Matches a newly accepted order and rests what is left. */
  submit(orderId: string, pair?: string): Promise<MatchSummary> {
    return (async () => {
      if (!this.active) throw new ApiError(503, 'MATCHING_UNAVAILABLE', 'matching is not running on this instance');
      const p = pair ?? (await loadOrder(this.db, orderId))?.pair;
      if (!p) throw new Error(`order ${orderId} not found`);
      return this.worker(p).run(() => this.process(this.worker(p), orderId));
    })();
  }

  /** Cancels (or expires) a live or queued order and releases its hold. Returns the updated row. */
  async cancel(orderId: string, reason: 'USER' | 'EXPIRED'): Promise<OrderRow | undefined> {
    const row = await loadOrder(this.db, orderId);
    if (!row) return undefined;
    const w = this.worker(row.pair);
    return w.run(async () => {
      const current = await loadOrder(this.db, orderId);
      if (!current || !['OPEN', 'PARTIAL', 'QUEUED'].includes(current.status)) return current;
      w.book.remove(orderId);
      w.resting.delete(orderId);
      const updated = await this.closeOrder(current, reason === 'EXPIRED' ? 'EXPIRED' : 'CANCELLED', reason);
      await this.publishBook(w);
      return updated;
    });
  }

  depth(pair: string) {
    const w = this.workers.get(pair);
    const cfg = findPair(this.config.get().data, pair);
    const decimals = cfg?.baseDecimals ?? 2;
    const view = (side: Side) =>
      (w?.book.depth(side, BOOK_DEPTH) ?? []).map((l) => ({ price: formatPrice(l.price), qty: formatDecimal(l.qty, decimals), count: l.count }));
    return { pair, bids: view('BUY'), asks: view('SELL') };
  }

  /** Waits for all queued work on every pair (tests, shutdown). */
  async idle() {
    await Promise.all([...this.workers.values()].map((w) => w.run(async () => {})));
  }

  // ---- matching ----

  private async process(w: PairWorker, orderId: string): Promise<MatchSummary> {
    const taker = await loadOrder(this.db, orderId);
    if (!taker || !LIVE_STATUSES.includes(taker.status) || w.book.has(orderId)) return { fills: [] };

    const fills: string[] = [];
    const skipped: string[] = [];
    let current = taker;
    const now = this.clock();
    if (taker.expires_at <= now) {
      await this.closeOrder(taker, 'EXPIRED', 'EXPIRED');
      return { fills };
    }
    // Outside trading hours nothing matches; the order rests until the market opens.
    if (!isMarketOpen(now, this.config.get().data.tradingHours)) {
      this.rest(w, taker);
      await this.publishBook(w);
      return { fills };
    }

    const takerBook = bookOrder(taker);
    try {
      const result = await matchIncoming(w.book, takerBook, async (c) => {
        const maker = w.resting.get(c.maker.id)!;
        // A maker past its validity is expired here, not traded, even if the scheduler has not reached it yet.
        if (maker.expires_at <= this.clock()) {
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
      });

      if (result.takerCancelled) {
        current = (await loadOrder(this.db, orderId))!;
        await this.closeOrder(current, 'CANCELLED', result.takerCancelled);
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
    await this.publishBook(w);
    return { fills };
  }

  /** Puts orders back in the book exactly as the database has them (live with something left, or gone). */
  private async resync(w: PairWorker, ids: string[]) {
    for (const id of new Set(ids)) {
      const row = await loadOrder(this.db, id);
      w.book.remove(id);
      w.resting.delete(id);
      if (row && LIVE_STATUSES.includes(row.status) && remainingOf(row) > 0n) this.rest(w, row);
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
    const releasePlaced = async () => {
      for (const h of placed) await this.releaseHold(h);
    };
    const buy = taker.side === 'BUY' ? taker : maker;
    const sell = taker.side === 'SELL' ? taker : maker;
    const buyer = priceSide(c.qty, c.price, fromSnapshot(buy.pricing));
    const seller = priceSide(c.qty, c.price, fromSnapshot(sell.pricing));

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
    let committed: { fillId: string; fill: FillRow; updated: Record<string, OrderRow> };
    try {
      committed = await tx(this.db, async (client) => {
        const { rows } = await client.query(
          `insert into fills (pair, maker_order_id, taker_order_id, buy_order_id, sell_order_id, book_price, qty, notional,
             buyer_effective_price, seller_effective_price, buyer_commission, seller_commission, buyer_tax, seller_tax,
             buyer_total, seller_total, config_version)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning *`,
          [
            w.pair, maker.id, taker.id, buy.id, sell.id, formatPrice(c.price, 8), c.qty, buyer.notional,
            formatPrice(buyer.effectivePrice, 8), formatPrice(seller.effectivePrice, 8),
            buyer.commission, seller.commission, buyer.tax, seller.tax, buyer.total, seller.total, cfg.version,
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
        await audit(client, 'system', 'fill', { fillId: fill.id, pair: w.pair, buy: buy.id, sell: sell.id, qty: c.qty, price: formatPrice(c.price) });
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

    // The fill is committed: from here on nothing may undo it in the book. Failures are logged and left to
    // recovery (PENDING legs are resumed by the scheduler and at startup), never thrown into matching.
    let outcome: string = 'PENDING';
    try {
      outcome = await this.settlement.settle(fillId);
    } catch (err) {
      this.log.error({ err, fillId }, 'settlement interrupted; it resumes from the pending legs');
    }

    // Hold maintenance after settlement captured the fill amounts.
    try {
      await releasePlaced();
      for (const o of Object.values(updated)) {
        if (o.balance_mode !== 'block' || !o.hold_id) continue;
        if (o.status === 'FILLED') await this.releaseHold(o.hold_id);
        else if (o.side === 'BUY') await this.adjustHold(o.hold_id, requirementFor(o, remainingOf(o)));
      }
    } catch (err) {
      this.log.error({ err, fillId }, 'hold maintenance failed after a fill');
    }

    await this.announceFill(fill, updated[buy.id], updated[sell.id], outcome).catch((err) =>
      this.log.error({ err, fillId }, 'announcing a fill failed; clients pick it up on their next load'),
    );
    return { action: 'filled', fillId, taker: updated[taker.id], maker: updated[maker.id] };
  }

  // ---- helpers ----

  private async closeOrder(o: OrderRow, status: 'CANCELLED' | 'EXPIRED', reason: string): Promise<OrderRow> {
    await this.db.query(`update orders set status = $2, cancel_reason = $3, updated_at = now() where id = $1 and status in ('NEW', 'QUEUED', 'OPEN', 'PARTIAL')`, [
      o.id,
      status,
      reason,
    ]);
    if (o.hold_id) await this.releaseHold(o.hold_id);
    await audit(this.db, 'system', `order.${status.toLowerCase()}`, { orderId: o.id, reason });
    const updated = (await loadOrder(this.db, o.id))!;
    await this.publishOrder(updated).catch((err) => this.log.warn({ err }, 'order publish failed'));
    const title = status === 'EXPIRED' ? 'Emrinizin süresi doldu' : 'Emriniz iptal edildi';
    const why: Record<string, string> = {
      USER: 'İsteğiniz üzerine iptal edildi.',
      EXPIRED: 'Geçerlilik süresi sona erdi.',
      SELF_MATCH: 'Kendi emrinizle eşleşeceği için iptal edildi.',
      INSUFFICIENT_BALANCE: 'Eşleşme anında bakiyeniz yetersiz olduğu için iptal edildi.',
      CORE_UNAVAILABLE: 'Bankacılık sistemine ulaşılamadığı için iptal edildi.',
      STALE: 'Teknik bir tutarsızlık nedeniyle iptal edildi; lütfen emrinizi yeniden girin.',
    };
    await this.notify(o.customer_ref, { type: `order.${status.toLowerCase()}`, title, body: why[reason] ?? reason, data: { orderId: o.id } });
    return updated;
  }

  private async announceFill(fill: FillRow, buy: OrderRow, sell: OrderRow, settlement: string) {
    const config = this.config.get().data;
    await this.events.publish({ type: 'trade', pair: fill.pair, trade: tradeView(fill, config) });
    const settled = settlement === 'SETTLED';
    for (const o of [buy, sell]) {
      await this.publishOrder(o);
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

  /** Releases a hold; if core banking does not confirm it, a hold task retries it until it does. */
  private async releaseHold(holdId: string) {
    await this.core.releaseHold(holdId).catch((err) => this.holdTask(holdId, 'RELEASE', null, err));
  }

  private async adjustHold(holdId: string, amount: bigint) {
    await this.core.adjustHold(holdId, amount).catch((err) => this.holdTask(holdId, 'ADJUST', amount, err));
  }

  private async holdTask(holdId: string, action: 'RELEASE' | 'ADJUST', amount: bigint | null, err: unknown) {
    this.log.warn({ err, holdId, action }, 'hold change failed; queued for retry');
    await this.db
      .query('insert into hold_tasks (hold_id, action, amount, last_error) values ($1, $2, $3, $4)', [holdId, action, amount, (err as Error)?.message ?? String(err)])
      .catch((e) => this.log.error({ err: e, holdId, action }, 'could not queue the hold change'));
  }

  /** Retries queued hold changes: per hold, a pending release wins over adjustments, else the latest adjustment. */
  async retryHoldTasks() {
    const { rows } = await this.db.query('select * from hold_tasks where not done order by id');
    const byHold = new Map<string, Record<string, any>[]>();
    for (const r of rows) byHold.set(r.hold_id, [...(byHold.get(r.hold_id) ?? []), r]);
    for (const [holdId, tasks] of byHold) {
      const release = tasks.some((t) => t.action === 'RELEASE');
      const ids = tasks.map((t) => t.id);
      try {
        if (release) await this.core.releaseHold(holdId);
        else await this.core.adjustHold(holdId, BigInt(tasks[tasks.length - 1].amount));
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

function bookOrder(o: OrderRow): BookOrder {
  return { id: o.id, ownerId: o.customer_id, side: o.side, price: parsePrice(o.book_price), remaining: remainingOf(o), seq: o.seq };
}
