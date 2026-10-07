import { randomUUID } from 'node:crypto';
import { findPair, type HedgingConfig, formatDecimal, formatPrice, parseDecimal, parsePrice, valueOf, type PairConfig } from '@p2p/shared';
import { LiquidityError, type LiquidityAdapter } from '@p2p/core-adapter';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/pool.js';
import type { ConfigService } from '../config-service.js';
import { audit } from '../audit.js';
import { ApiError, badRequest } from '../errors.js';
import type { Aggregate, PriceEngine } from './price-engine.js';

interface Trade {
  /** The bank's side. */
  side: 'BUY' | 'SELL';
  qty: bigint;
  rate: bigint;
}

/** Capacity taken for one principal execution; it ends exactly once, by commit (into the position) or release. */
export interface Reservation {
  id: number;
  delta: bigint;
  commit(): void;
  release(): void;
  /**
   * The execution may or may not have happened (a hedge clip whose LP outcome is unknown): it moves into the
   * committed position (for netting, as the database counts it) and stays uncertain, so the cap's worst case also
   * covers it not having happened, until a reload shows it resolved.
   */
  commitUncertain(): void;
}

export interface Position {
  pair: string;
  currency: string;
  /** Base minor units; positive = long. */
  qty: bigint;
  /** PRICE_SCALE units; 0 when flat. */
  avgRate: bigint;
  /** Quote minor units. */
  realized: bigint;
}

/**
 * Average-cost position keeping. Adding to a position moves the average; reducing it realizes
 * (rate − average) × quantity; crossing through zero starts a new average at the trade rate.
 */
export function positionOf(pair: PairConfig, trades: Trade[]): Position {
  let qty = 0n;
  let avg = 0n;
  let realized = 0n;
  for (const t of trades) {
    const signed = t.side === 'BUY' ? t.qty : -t.qty;
    if (qty === 0n || (qty > 0n) === (signed > 0n)) {
      const abs = (qty < 0n ? -qty : qty) + t.qty;
      avg = ((qty < 0n ? -qty : qty) * avg + t.qty * t.rate) / abs;
      qty += signed;
      continue;
    }
    const open = qty < 0n ? -qty : qty;
    const closing = t.qty < open ? t.qty : open;
    const pnlPerUnit = qty > 0n ? t.rate - avg : avg - t.rate;
    realized += valueOf(closing, pair.baseDecimals, pnlPerUnit, pair.quoteDecimals, 'HALF_UP');
    qty += signed;
    if (qty === 0n) avg = 0n;
    else if ((qty > 0n) === (signed > 0n)) avg = t.rate;
  }
  return { pair: pair.symbol, currency: pair.base, qty, avgRate: avg, realized };
}

/**
 * How long a clip the LP does not know about may plausibly still turn up there. Past it the clip is escalated to
 * operations, not rejected: the LP's silence is not proof it never traded, so the clip keeps counting in the
 * position until the LP shows it or an operator who checked with the LP rejects it.
 */
const UNKNOWN_ESCALATE_MS = 30_000;

export interface Clip {
  lp: string;
  qty: bigint;
}

/** LPs from best to worst price for the bank's side (lowest ask to buy, highest bid to sell). */
export function lpsByPrice(agg: Pick<Aggregate, 'quotes'>, side: 'BUY' | 'SELL'): string[] {
  const price = (q: { bid: string; ask: string }) => parsePrice(side === 'BUY' ? q.ask : q.bid);
  return [...agg.quotes].sort((a, b) => (price(a) === price(b) ? 0 : (price(a) < price(b)) === (side === 'BUY') ? -1 : 1)).map((q) => q.lp);
}

/** Splits a hedge into clips of at most `maxClip` and assigns each an LP according to the split rule. */
export function planHedge(qty: bigint, maxClip: bigint | undefined, lps: string[], split: HedgingConfig['split']): Clip[] {
  if (lps.length === 0) return [];
  const clips: Clip[] = [];
  let left = qty;
  while (left > 0n) {
    const size = maxClip && maxClip > 0n && left > maxClip ? maxClip : left;
    clips.push({ lp: split === 'ACROSS_LPS' ? lps[clips.length % lps.length] : lps[0], qty: size });
    left -= size;
  }
  return clips;
}

/** How much an auto-hedge trades: down to `targetPct` of the limit, or nothing when within the limit. */
export function autoHedgeQty(position: bigint, limit: bigint, targetPct: number): bigint {
  const abs = position < 0n ? -position : position;
  if (abs <= limit) return 0n;
  return abs - (limit * BigInt(Math.round(targetPct * 100))) / 10000n;
}

/**
 * Pool manager: the bank's positions from its customer deals and LP hedges, P&L, limits and hedging.
 */
export class PositionKeeper {
  constructor(
    private readonly db: Db,
    private readonly lp: LiquidityAdapter,
    private readonly prices: PriceEngine,
    private readonly config: ConfigService,
    private readonly log: FastifyBaseLogger,
  ) {}

  /**
   * Committed position per pair, in base minor units: the database's principal executions and hedges, plus the
   * executions committed since it was last read. Reloads replace only this part.
   */
  private readonly committed = new Map<string, bigint>();
  /**
   * Capacity taken by executions that have not committed yet (a board fill waiting on its holds and transaction, a
   * Direct deal waiting on its claim), per pair and reservation id. Reloads never touch it: a reservation ends only
   * by its own commit or release, each at most once.
   */
  private readonly reserved = new Map<string, Map<number, bigint>>();
  private nextReservation = 0;
  /**
   * Changes of the committed part in flight between the database and memory (a Direct deal being marked REJECTED):
   * while one is open a reload's read may or may not include it, so it is not applied.
   */
  private readonly transitions = new Map<string, number>();
  /**
   * Executions inside the committed position whose outcome is unknown (hedge clips sent, not confirmed): if one did
   * not happen the position is committed − delta. Reloaded from the database with the committed part.
   */
  private readonly uncertain = new Map<string, bigint[]>();
  /** Bumped on every in-memory change of the committed part, so a reload that raced one is not applied over it. */
  private epoch = 0;

  async position(pair: PairConfig): Promise<Position> {
    // The bank's principal executions (board fills with its ladder or bot and Direct deals) count from the moment
    // they commit, not when settlement finishes. A board fill is firm whatever happens to its settlement legs
    // (review, reversal): the obligation to the customer stands until it is economically cancelled, and no such flow
    // exists. Only a Direct deal core banking definitely rejected never happened. Hedge clips count from the moment
    // they are sent (PENDING, UNKNOWN), so a clip whose outcome is not known yet is never hedged a second time.
    const { rows } = await this.db.query(
      `select at, side, qty, rate from (
         select e.created_at as at, e.seq, e.bank_side as side, e.qty, e.price as rate, 0 as src
           from principal_executions e
          where e.pair = $1
            and not (e.channel = 'DIRECT' and exists (select 1 from bank_deals d where d.id = e.ref_id and d.status = 'REJECTED'))
         union all
         select created_at, seq, side, qty, rate, 1 from hedges where pair = $1 and status <> 'REJECTED'
       ) t order by at, src, seq`,
      [pair.symbol],
    );
    return positionOf(pair, rows.map((r) => ({ side: r.side, qty: BigInt(r.qty), rate: parsePrice(r.rate) })));
  }

  /** Loads every pair's position into memory (startup). */
  async load() {
    for (const pair of this.config.get().data.pairs) await this.reload(pair.symbol);
  }

  /**
   * Reloads one pair's committed position from the database. Reservations are kept as they are. The read is applied
   * only if it was quiet: no execution committed in memory meanwhile, and no reservation of the pair was open during
   * it (an open reservation may commit in the database before the read and in memory after it, which would count it
   * twice). Otherwise it reads again.
   */
  async reload(pairSymbol: string) {
    const pair = findPair(this.config.get().data, pairSymbol);
    if (!pair) return;
    const open = () => (this.reserved.get(pair.symbol)?.size ?? 0) + (this.transitions.get(pair.symbol) ?? 0);
    for (let i = 0; i < 10; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 5 * i));
      if (open()) continue;
      const epoch = this.epoch;
      const taken = this.nextReservation;
      const p = await this.position(pair);
      const unsure = await this.openClipDeltas(pair.symbol);
      if (epoch === this.epoch && taken === this.nextReservation && !open()) {
        this.committed.set(pair.symbol, p.qty);
        this.uncertain.set(pair.symbol, unsure);
        return;
      }
    }
    this.log.warn({ pair: pair.symbol }, 'position reload kept racing executions; the in-memory position stays as it is');
  }

  /** The expected position: committed plus every open reservation, netted (base minor units, + long). */
  current(pairSymbol: string): bigint {
    let sum = this.committed.get(pairSymbol) ?? 0n;
    for (const d of this.reserved.get(pairSymbol)?.values() ?? []) sum += d;
    return sum;
  }

  /**
   * The worst case on each side, which the cap is checked against: committed plus only the open reservations that move
   * the position that way. A pending execution the other way may still fail, so it never makes room.
   */
  bounds(pairSymbol: string): { long: bigint; short: bigint } {
    const committed = this.committedPosition(pairSymbol);
    let buys = 0n;
    let sells = 0n;
    for (const d of this.reserved.get(pairSymbol)?.values() ?? []) {
      if (d > 0n) buys += d;
      else sells += d;
    }
    // An uncertain execution that did not happen takes its delta back out of the committed position.
    for (const d of this.uncertain.get(pairSymbol) ?? []) {
      if (d < 0n) buys -= d;
      else sells -= d;
    }
    return { long: committed + buys, short: committed + sells };
  }

  /** The committed part of the position, without reservations. */
  committedPosition(pairSymbol: string): bigint {
    return this.committed.get(pairSymbol) ?? 0n;
  }

  /** The hard inventory cap for the pair's base currency (base minor units), if one is set. */
  maxPosition(pairSymbol: string): bigint | undefined {
    const c = this.config.get().data;
    const pair = findPair(c, pairSymbol);
    const max = pair && c.inventory.maxPosition[pair.base];
    return pair && max ? parseDecimal(max, pair.baseDecimals) : undefined;
  }

  /**
   * How much more the bank may buy (BUY) or sell of the pair's base, with `resting` already committed on that side by
   * its other liquidity. Undefined: no cap.
   */
  headroom(pairSymbol: string, bankSide: 'BUY' | 'SELL', resting = 0n): bigint | undefined {
    const max = this.maxPosition(pairSymbol);
    if (max === undefined) return undefined;
    const b = this.bounds(pairSymbol);
    const room = (bankSide === 'BUY' ? max - b.long : max + b.short) - resting;
    return room > 0n ? room : 0n;
  }

  /**
   * Whether a principal execution of `delta` keeps the worst case on its side within the cap: a buy against committed
   * plus pending buys, a sell against committed plus pending sells. A trade that brings a position already past the cap
   * back towards it is allowed by the same check.
   */
  allows(pairSymbol: string, delta: bigint): boolean {
    const max = this.maxPosition(pairSymbol);
    if (max === undefined || delta === 0n) return true;
    const b = this.bounds(pairSymbol);
    return delta > 0n ? b.long + delta <= max : b.short + delta >= -max;
  }

  /**
   * Takes capacity for a principal execution before anything is awaited (Direct claim, board fill holds and
   * transaction), so two executions at once can never both use the last headroom. The check and the take happen
   * in one synchronous step. Undefined when the cap does not allow it.
   */
  tryReserve(pairSymbol: string, delta: bigint, opts: { hedge?: boolean } = {}): Reservation | undefined {
    if (!this.allows(pairSymbol, delta)) return undefined;
    const id = ++this.nextReservation;
    let byId = this.reserved.get(pairSymbol);
    if (!byId) this.reserved.set(pairSymbol, (byId = new Map()));
    byId.set(id, delta);
    let done = false;
    const end = () => {
      if (done) return false;
      done = true;
      byId!.delete(id);
      return true;
    };
    return {
      id,
      delta,
      commit: () => {
        // Into the committed position in the same step it leaves the reservations: the exposure never dips.
        if (!end()) return;
        if (opts.hedge) this.change(pairSymbol, delta);
        else this.afterExecution(pairSymbol, delta);
      },
      release: () => {
        end();
      },
      commitUncertain: () => {
        if (!end()) return;
        this.uncertain.set(pairSymbol, [...(this.uncertain.get(pairSymbol) ?? []), delta]);
        this.change(pairSymbol, delta);
      },
    };
  }

  /** Signed deltas of the pair's hedge clips sent and not confirmed (PENDING, UNKNOWN). */
  private async openClipDeltas(pairSymbol: string): Promise<bigint[]> {
    const { rows } = await this.db.query(
      `select case side when 'BUY' then qty else -qty end::bigint as d from hedges where pair = $1 and status in ('PENDING', 'UNKNOWN')`,
      [pairSymbol],
    );
    return rows.map((r) => BigInt(r.d));
  }

  /** As tryReserve, for Direct: a deal the cap does not allow is refused with INVENTORY_LIMIT. */
  reserve(pairSymbol: string, delta: bigint): Reservation {
    const r = this.tryReserve(pairSymbol, delta);
    if (!r) throw new ApiError(422, 'INVENTORY_LIMIT', 'the bank cannot take more of this currency on this side right now');
    return r;
  }

  /** Active reservations of a pair (operations, tests). */
  reservations(pairSymbol: string): bigint[] {
    return [...(this.reserved.get(pairSymbol)?.values() ?? [])];
  }

  /** A principal execution committed: the committed position moves now, and auto-hedge looks at it (in the background). */
  afterExecution(pairSymbol: string, delta: bigint) {
    this.change(pairSymbol, delta);
    this.afterDeal(pairSymbol).catch(() => {});
  }

  /**
   * A committed execution that may turn out never to have happened (a Direct deal core banking rejects), as one step
   * coordinated with reloads: open it before the database write, then `apply` it only if that write changed the
   * record (once per execution), or `abandon` it. Reloads are not applied while it is open, and its change bumps the
   * epoch, so a read taken before or after the write is never combined with it.
   */
  beginReversal(pairSymbol: string, delta: bigint): { apply(): void; abandon(): void } {
    this.transitions.set(pairSymbol, (this.transitions.get(pairSymbol) ?? 0) + 1);
    let open = true;
    const close = () => {
      if (!open) return false;
      open = false;
      this.transitions.set(pairSymbol, (this.transitions.get(pairSymbol) ?? 1) - 1);
      return true;
    };
    return {
      apply: () => {
        if (close()) this.change(pairSymbol, -delta);
      },
      abandon: () => {
        close();
      },
    };
  }

  private change(pairSymbol: string, delta: bigint) {
    this.epoch++;
    this.committed.set(pairSymbol, this.committedPosition(pairSymbol) + delta);
  }

  /** Positions with unrealized P&L at the LP mid, and the limit. */
  async snapshot() {
    const c = this.config.get().data;
    const out = [];
    for (const pair of c.pairs) {
      const p = await this.position(pair);
      const agg = this.prices.cached(pair.symbol);
      const mid = agg ? (agg.bid + agg.ask) / 2n : undefined;
      const unrealized =
        mid !== undefined && p.qty !== 0n
          ? valueOf(p.qty < 0n ? -p.qty : p.qty, pair.baseDecimals, p.qty > 0n ? mid - p.avgRate : p.avgRate - mid, pair.quoteDecimals, 'HALF_UP')
          : 0n;
      const { rows } = await this.db.query(
        `select count(*)::int as deals, coalesce(sum(margin), 0)::bigint as margin from bank_deals where pair = $1 and status = 'SETTLED'`,
        [pair.symbol],
      );
      const q = (v: bigint) => formatDecimal(v, pair.quoteDecimals);
      out.push({
        pair: pair.symbol,
        currency: pair.base,
        qty: formatDecimal(p.qty, pair.baseDecimals),
        avgRate: p.qty === 0n ? null : formatPrice(p.avgRate),
        mid: mid === undefined ? null : formatPrice(mid),
        limit: c.dealing.positionLimits[pair.base] ?? null,
        maxPosition: c.inventory.maxPosition[pair.base] ?? null,
        realizedPnl: q(p.realized),
        unrealizedPnl: q(unrealized),
        deals: rows[0].deals,
        marginEarned: q(BigInt(rows[0].margin)),
        quoteCurrency: pair.quote,
        // Part of qty: hedge clips whose outcome the LP has not confirmed yet (kept in the position as a reserve).
        unconfirmedHedgeQty: formatDecimal(await this.unconfirmed(pair.symbol), pair.baseDecimals),
      });
    }
    return out;
  }

  /** One hedge decision at a time per pair, so two deals finishing together cannot both hedge the same position. */
  private readonly hedgeChains = new Map<string, Promise<unknown>>();

  /** Waits for hedge decisions in flight (tests, shutdown). */
  async idle() {
    await Promise.all([...this.hedgeChains.values()]);
  }

  private serial<T>(pair: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.hedgeChains.get(pair) ?? Promise.resolve()).then(fn, fn);
    this.hedgeChains.set(pair, next.catch(() => {}));
    return next;
  }

  /** After a deal: when the position is over its limit, hedge it down to the target with the LPs. */
  afterDeal(pairSymbol: string) {
    return this.serial(pairSymbol, async () => {
      const c = this.config.get().data;
      const pair = findPair(c, pairSymbol);
      const limit = pair && c.dealing.positionLimits[pair.base];
      if (!pair || !c.dealing.autoHedge || !limit) return;
      try {
        await this.resolveOpenClips(pair.symbol);
        const p = await this.position(pair);
        const qty = autoHedgeQty(p.qty, parseDecimal(limit, pair.baseDecimals), c.dealing.hedging.targetPct);
        if (qty === 0n) return;
        await this.execute(pair, p.qty < 0n ? 'BUY' : 'SELL', qty, 'AUTO', 'system');
      } catch (err) {
        this.log.error({ err, pair: pair.symbol }, 'auto-hedge failed');
      } finally {
        await this.reload(pair.symbol).catch(() => {});
      }
    });
  }

  /**
   * Trades `qty` with the LPs: split into clips by `hedging.maxClipQty`, each clip to the LP the split rule picks.
   * A clip an LP definitely rejects goes to the next LP by price; a clip whose outcome is unknown stops the
   * hedge (it is never re-sent to another LP before it is looked up). Clips that no LP takes are reported as unhedged.
   */
  hedge(pair: PairConfig, side: 'BUY' | 'SELL', qty: bigint, reason: 'AUTO' | 'MANUAL', actor: string) {
    return this.serial(pair.symbol, async () => {
      await this.resolveOpenClips(pair.symbol);
      try {
        return await this.execute(pair, side, qty, reason, actor);
      } finally {
        await this.reload(pair.symbol).catch(() => {});
      }
    });
  }

  private async execute(pair: PairConfig, side: 'BUY' | 'SELL', qty: bigint, reason: 'AUTO' | 'MANUAL', actor: string) {
    if (qty <= 0n) throw badRequest('INVALID_QTY', 'quantity must be positive');
    const { hedging } = this.config.get().data.dealing;
    const first = await this.prices.current(pair.symbol);
    const maxClip = hedging.maxClipQty[pair.base];
    const plan = planHedge(qty, maxClip ? parseDecimal(maxClip, pair.baseDecimals) : undefined, lpsByPrice(first, side), hedging.split);
    const batchId = randomUUID();
    const clips = [];
    let unhedged = 0n;
    let unknown = 0n;
    let limited = false;
    for (const clip of plan) {
      if (unknown > 0n || limited) {
        unhedged += clip.qty;
        continue;
      }
      // Each clip prices against LP quotes that are fresh now (the first one may be a while ago by the last clip).
      const agg = await this.prices.current(pair.symbol);
      const lps = lpsByPrice(agg, side);
      const done = await this.executeClip(pair, side, clip, [clip.lp, ...lps.filter((l) => l !== clip.lp)], agg, batchId, reason, actor);
      if (done === 'UNKNOWN') unknown += clip.qty;
      else if (done === 'LIMIT') {
        limited = true;
        unhedged += clip.qty;
      } else if (done) clips.push(done);
      else unhedged += clip.qty;
    }
    const fmt = (v: bigint) => formatDecimal(v, pair.baseDecimals);
    await audit(this.db, actor, 'dealing.hedge', { batchId, pair: pair.symbol, side, qty: fmt(qty), clips: clips.length, unhedged: fmt(unhedged), unknown: fmt(unknown), reason });
    this.log.info({ pair: pair.symbol, side, qty: fmt(qty), clips: clips.length, unknown: fmt(unknown), reason }, 'hedged with LPs');
    if (clips.length === 0 && unknown === 0n && limited) {
      throw new ApiError(422, 'INVENTORY_LIMIT', 'this hedge would take the bank past its inventory cap');
    }
    if (clips.length === 0 && unknown === 0n) throw new ApiError(503, 'LP_UNAVAILABLE', 'no liquidity provider accepted the hedge');
    return { batchId, side, qty: fmt(qty - unhedged - unknown), unhedged: fmt(unhedged), unknown: fmt(unknown), clips };
  }

  /**
   * One clip. Its capacity is reserved before anything is written or sent, against the same reservations as Direct and
   * the board (so a fill cannot use headroom the clip is about to take, and a reload cannot apply a read that may or
   * may not contain the clip). Then the intent is stored (PENDING, with the reference the LP gets) before anything is
   * sent, so a crash or a database error after the LP traded can never lose the trade. Endings: filled → the
   * reservation commits; definitely rejected → released, and the next LP by price is tried; unknown → it stays in the
   * position as uncertain (both outcomes count for the cap) and nothing more is sent. An LP operations switched off, or
   * whose own quote is no longer fresh, is skipped at the moment of sending.
   */
  private async executeClip(
    pair: PairConfig, side: 'BUY' | 'SELL', clip: Clip, order: string[], agg: Aggregate, batchId: string, reason: string, actor: string,
  ): Promise<ReturnType<typeof hedgeView> | 'UNKNOWN' | 'LIMIT' | undefined> {
    const delta = side === 'BUY' ? clip.qty : -clip.qty;
    for (const lp of order) {
      const config = this.config.get().data;
      if (config.killSwitch.disabledLps.includes(lp)) continue;
      const quote = agg.quotes.find((q) => q.lp === lp);
      if (!quote || !this.prices.quoteFresh(quote)) continue;
      const expected = side === 'BUY' ? quote.ask : quote.bid;
      // A hedge does not start another auto-hedge decision when it commits (it is one).
      const reservation = this.tryReserve(pair.symbol, delta, { hedge: true });
      if (!reservation) return 'LIMIT';
      const ref = randomUUID();
      let id: string;
      try {
        const { rows: intent } = await this.db.query(
          `insert into hedges (pair, side, qty, rate, expected_rate, lp, lp_ref, batch_id, reason, actor, status)
           values ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9, 'PENDING') returning id`,
          [pair.symbol, side, clip.qty, expected, lp, ref, batchId, reason, actor],
        );
        id = intent[0].id as string;
      } catch (err) {
        reservation.release();
        throw err;
      }
      let exec;
      try {
        exec = await this.lp.execute({ lp, pair: pair.symbol, side, qty: formatDecimal(clip.qty, pair.baseDecimals), ref });
      } catch (err) {
        if (err instanceof LiquidityError) {
          this.log.warn({ err, lp, pair: pair.symbol }, 'LP rejected hedge clip');
          try {
            await this.db.query(`update hedges set status = 'REJECTED' where id = $1`, [id]);
            reservation.release();
          } catch (e) {
            // Not recorded as rejected: the row stays PENDING (in the position) until a lookup or operations resolve it.
            reservation.commitUncertain();
            throw e;
          }
          continue;
        }
        this.log.error({ err, lp, pair: pair.symbol, ref }, 'hedge clip outcome unknown: not re-sent to another LP');
        await this.db.query(`update hedges set status = 'UNKNOWN' where id = $1`, [id]).catch(() => {});
        reservation.commitUncertain();
        return 'UNKNOWN';
      }
      // The LP contract is all of the clip or a definite rejection. An execution that does not match the request (another
      // quantity, pair, side or reference) is not taken as done: it stays open for the lookup and operations.
      const matches =
        exec.lp === lp && exec.pair === pair.symbol && exec.side === side && exec.ref === ref && parseDecimal(String(exec.qty), pair.baseDecimals) === clip.qty;
      if (!matches) {
        this.log.error({ lp, ref, requested: formatDecimal(clip.qty, pair.baseDecimals), exec }, 'LP execution does not match the clip: left for reconciliation');
        await this.db.query(`update hedges set status = 'UNKNOWN', lp_trade_ref = $2 where id = $1`, [id, exec.tradeRef]).catch(() => {});
        reservation.commitUncertain();
        return 'UNKNOWN';
      }
      try {
        const { rows } = await this.db.query(
          `update hedges set status = 'DONE', rate = $2, lp_trade_ref = $3 where id = $1 returning *`,
          [id, exec.rate, exec.tradeRef],
        );
        reservation.commit();
        return hedgeView(rows[0], pair);
      } catch (err) {
        // The LP traded; the clip stays PENDING (counted in the position) and is confirmed by the next lookup.
        this.log.error({ err, lp, ref, tradeRef: exec.tradeRef }, 'hedge executed but not recorded as done');
        reservation.commitUncertain();
        return 'UNKNOWN';
      }
    }
    return undefined;
  }

  /**
   * Looks up clips left PENDING or UNKNOWN (crash, timeout, database error) at their LP by reference. A clip
   * the LP shows becomes DONE; any other stays open (and in the position) and is looked up again on the next run.
   */
  async resolveOpenClips(pairSymbol?: string) {
    const { rows } = await this.db.query(
      `select id, lp, lp_ref, created_at from hedges where status in ('PENDING', 'UNKNOWN') and lp_ref is not null and ($1::text is null or pair = $1) order by seq`,
      [pairSymbol ?? null],
    );
    for (const r of rows) {
      try {
        const exec = await this.lp.findExecution(r.lp, r.lp_ref);
        if (exec) {
          await this.db.query(`update hedges set status = 'DONE', rate = $2, lp_trade_ref = $3 where id = $1 and status in ('PENDING', 'UNKNOWN')`, [r.id, exec.rate, exec.tradeRef]);
        } else if (Date.now() - new Date(r.created_at).getTime() > UNKNOWN_ESCALATE_MS) {
          this.log.error({ hedgeId: r.id, lp: r.lp, ref: r.lp_ref }, 'hedge clip still unknown at its LP: check with the LP and resolve it in operations');
        }
      } catch (err) {
        this.log.warn({ err, hedgeId: r.id }, 'hedge clip lookup failed; it stays open');
      }
    }
  }

  /**
   * Operations: closes a clip still open after checking with the LP. The LP is asked once more first; a clip it
   * shows is recorded as DONE whatever the operator chose. Only a clip the LP still does not show is rejected.
   */
  async resolveClip(id: string, outcome: 'REJECTED', note: string, actor: string) {
    const { rows } = await this.db.query(`select * from hedges where id::text = $1`, [id]);
    const r = rows[0];
    if (!r) throw new ApiError(404, 'NOT_FOUND', 'hedge not found');
    if (!['PENDING', 'UNKNOWN'].includes(r.status)) throw new ApiError(409, 'NOT_OPEN', `hedge is ${r.status}`);
    let exec;
    try {
      exec = await this.lp.findExecution(r.lp, r.lp_ref);
    } catch (err) {
      throw new ApiError(503, 'LP_LOOKUP_FAILED', `the LP lookup failed, nothing was changed: ${(err as Error).message}`);
    }
    const status = exec ? 'DONE' : outcome;
    const { rows: updated } = await this.db.query(
      `update hedges set status = $2, rate = coalesce($3, rate), lp_trade_ref = coalesce($4, lp_trade_ref), resolved_by = $5, resolution_note = $6
        where id = $1 and status in ('PENDING', 'UNKNOWN') returning *`,
      [r.id, status, exec?.rate ?? null, exec?.tradeRef ?? null, actor, note],
    );
    if (!updated.length) throw new ApiError(409, 'NOT_OPEN', 'hedge was resolved meanwhile');
    await audit(this.db, actor, 'dealing.hedge.resolve', { hedgeId: r.id, requested: outcome, status, note });
    await this.reload(r.pair).catch(() => {});
    return hedgeView(updated[0], findPair(this.config.get().data, r.pair));
  }

  /** Base quantity of clips sent but not confirmed by their LP yet (signed: + the bank is buying), per pair. */
  private async unconfirmed(pair: string): Promise<bigint> {
    const { rows } = await this.db.query(
      `select coalesce(sum(case side when 'BUY' then qty else -qty end), 0)::bigint as q from hedges where pair = $1 and status in ('PENDING', 'UNKNOWN')`,
      [pair],
    );
    return BigInt(rows[0].q);
  }

  async recentHedges(limit = 20) {
    const c = this.config.get().data;
    const { rows } = await this.db.query(`select * from hedges where status <> 'REJECTED' order by seq desc limit $1`, [limit]);
    return rows.map((r) => hedgeView(r, findPair(c, r.pair)));
  }
}

const HEDGE_STATES: Record<string, string> = { PENDING: 'SENT', DONE: 'FILLED', UNKNOWN: 'UNKNOWN_OUTCOME', REJECTED: 'REJECTED' };

function hedgeView(r: Record<string, any>, pair: PairConfig | undefined) {
  return {
    id: r.id,
    pair: r.pair,
    side: r.side,
    qty: formatDecimal(BigInt(r.qty), pair?.baseDecimals ?? 2),
    rate: formatPrice(parsePrice(r.rate)),
    lp: r.lp,
    lpTradeRef: r.lp_trade_ref,
    status: r.status,
    /** v1.1 hedge states: SENT (waiting for the LP), FILLED, UNKNOWN_OUTCOME (to be looked up), REJECTED. */
    state: HEDGE_STATES[r.status as string] ?? r.status,
    batchId: r.batch_id,
    reason: r.reason,
    at: new Date(r.created_at).toISOString(),
  };
}
