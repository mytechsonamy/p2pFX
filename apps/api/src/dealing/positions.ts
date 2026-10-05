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

  async position(pair: PairConfig): Promise<Position> {
    // Customer BUY → the bank sells. Only settled deals change the position. P2P fills where the bank's own
    // account (its ladder in the book) was a side count too, unless their settlement failed or was reversed;
    // other P2P fills are back-to-back and do not. Hedge clips count from the moment they are sent (PENDING,
    // UNKNOWN), so a clip whose outcome is not known yet is never hedged a second time.
    const { rows } = await this.db.query(
      `select at, side, qty, rate from (
         select created_at as at, seq, case side when 'BUY' then 'SELL' else 'BUY' end as side, qty, rate, 0 as src
           from bank_deals where pair = $1 and status = 'SETTLED'
         union all
         select created_at, seq, side, qty, rate, 1 from hedges where pair = $1 and status <> 'REJECTED'
         union all
         select f.created_at, f.seq, o.side, f.qty, f.book_price, 2 from fills f
           join orders o on o.id in (f.buy_order_id, f.sell_order_id)
           join customers c on c.id = o.customer_id
          where f.pair = $1 and c.customer_ref = $2
            and not exists (select 1 from settlements s where s.fill_id = f.id and s.status in ('FAILED_NEEDS_REVIEW', 'REVERSED', 'REVERSAL_PENDING'))
       ) t order by at, src, seq`,
      [pair.symbol, this.config.get().data.bankBook.customerRef],
    );
    return positionOf(pair, rows.map((r) => ({ side: r.side, qty: BigInt(r.qty), rate: parsePrice(r.rate) })));
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
      return this.execute(pair, side, qty, reason, actor);
    });
  }

  private async execute(pair: PairConfig, side: 'BUY' | 'SELL', qty: bigint, reason: 'AUTO' | 'MANUAL', actor: string) {
    if (qty <= 0n) throw badRequest('INVALID_QTY', 'quantity must be positive');
    const { hedging } = this.config.get().data.dealing;
    const agg = await this.prices.current(pair.symbol);
    const lps = lpsByPrice(agg, side);
    const maxClip = hedging.maxClipQty[pair.base];
    const plan = planHedge(qty, maxClip ? parseDecimal(maxClip, pair.baseDecimals) : undefined, lps, hedging.split);
    const batchId = randomUUID();
    const clips = [];
    let unhedged = 0n;
    let unknown = 0n;
    for (const clip of plan) {
      if (unknown > 0n) {
        unhedged += clip.qty;
        continue;
      }
      const done = await this.executeClip(pair, side, clip, [clip.lp, ...lps.filter((l) => l !== clip.lp)], agg, batchId, reason, actor);
      if (done === 'UNKNOWN') unknown += clip.qty;
      else if (done) clips.push(done);
      else unhedged += clip.qty;
    }
    const fmt = (v: bigint) => formatDecimal(v, pair.baseDecimals);
    await audit(this.db, actor, 'dealing.hedge', { batchId, pair: pair.symbol, side, qty: fmt(qty), clips: clips.length, unhedged: fmt(unhedged), unknown: fmt(unknown), reason });
    this.log.info({ pair: pair.symbol, side, qty: fmt(qty), clips: clips.length, unknown: fmt(unknown), reason }, 'hedged with LPs');
    if (clips.length === 0 && unknown === 0n) throw new ApiError(503, 'LP_UNAVAILABLE', 'no liquidity provider accepted the hedge');
    return { batchId, side, qty: fmt(qty - unhedged - unknown), unhedged: fmt(unhedged), unknown: fmt(unknown), clips };
  }

  /**
   * One clip: the intent is stored (PENDING, with the reference the LP gets) before anything is sent, so a
   * crash or a database error after the LP traded can never lose the trade. A definite rejection moves on to
   * the next LP; an unknown outcome stops there.
   */
  private async executeClip(
    pair: PairConfig, side: 'BUY' | 'SELL', clip: Clip, order: string[], agg: Aggregate, batchId: string, reason: string, actor: string,
  ): Promise<ReturnType<typeof hedgeView> | 'UNKNOWN' | undefined> {
    for (const lp of order) {
      const quote = agg.quotes.find((q) => q.lp === lp);
      const expected = quote ? (side === 'BUY' ? quote.ask : quote.bid) : formatPrice(side === 'BUY' ? agg.ask : agg.bid);
      const ref = randomUUID();
      const { rows: intent } = await this.db.query(
        `insert into hedges (pair, side, qty, rate, lp, lp_ref, batch_id, reason, actor, status)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PENDING') returning id`,
        [pair.symbol, side, clip.qty, expected, lp, ref, batchId, reason, actor],
      );
      const id = intent[0].id as string;
      let exec;
      try {
        exec = await this.lp.execute({ lp, pair: pair.symbol, side, qty: formatDecimal(clip.qty, pair.baseDecimals), ref });
      } catch (err) {
        if (err instanceof LiquidityError) {
          this.log.warn({ err, lp, pair: pair.symbol }, 'LP rejected hedge clip');
          await this.db.query(`update hedges set status = 'REJECTED' where id = $1`, [id]);
          continue;
        }
        this.log.error({ err, lp, pair: pair.symbol, ref }, 'hedge clip outcome unknown: not re-sent to another LP');
        await this.db.query(`update hedges set status = 'UNKNOWN' where id = $1`, [id]).catch(() => {});
        return 'UNKNOWN';
      }
      try {
        const { rows } = await this.db.query(
          `update hedges set status = 'DONE', rate = $2, lp_trade_ref = $3 where id = $1 returning *`,
          [id, exec.rate, exec.tradeRef],
        );
        return hedgeView(rows[0], pair);
      } catch (err) {
        // The LP traded; the clip stays PENDING (counted in the position) and is confirmed by the next lookup.
        this.log.error({ err, lp, ref, tradeRef: exec.tradeRef }, 'hedge executed but not recorded as done');
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
    batchId: r.batch_id,
    reason: r.reason,
    at: new Date(r.created_at).toISOString(),
  };
}
