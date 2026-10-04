import { randomUUID } from 'node:crypto';
import { findPair, formatDecimal, formatPrice, parseDecimal, parsePrice, valueOf, type PairConfig } from '@p2p/shared';
import type { LiquidityAdapter } from '@p2p/core-adapter';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/pool.js';
import type { ConfigService } from '../config-service.js';
import { audit } from '../audit.js';
import { badRequest } from '../errors.js';
import type { PriceEngine } from './price-engine.js';

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
    // Customer BUY → the bank sells. Only settled deals change the position.
    const { rows } = await this.db.query(
      `select at, side, qty, rate from (
         select created_at as at, seq, case side when 'BUY' then 'SELL' else 'BUY' end as side, qty, rate, 0 as src
           from bank_deals where pair = $1 and status = 'SETTLED'
         union all
         select created_at, seq, side, qty, rate, 1 from hedges where pair = $1
       ) t order by at, src, seq`,
      [pair.symbol],
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
      });
    }
    return out;
  }

  /** After a deal: hedge back to flat with the best LP when the position is over its limit. */
  async afterDeal(pairSymbol: string) {
    const c = this.config.get().data;
    const pair = findPair(c, pairSymbol);
    const limit = pair && c.dealing.positionLimits[pair.base];
    if (!pair || !c.dealing.autoHedge || !limit) return;
    const p = await this.position(pair);
    const abs = p.qty < 0n ? -p.qty : p.qty;
    if (abs <= parseDecimal(limit, pair.baseDecimals)) return;
    try {
      await this.hedge(pair, p.qty < 0n ? 'BUY' : 'SELL', abs, 'AUTO', 'system');
    } catch (err) {
      this.log.error({ err, pair: pair.symbol }, 'auto-hedge failed');
    }
  }

  /** Trades `qty` with the LP offering the best price for the bank's side. */
  async hedge(pair: PairConfig, side: 'BUY' | 'SELL', qty: bigint, reason: 'AUTO' | 'MANUAL', actor: string) {
    if (qty <= 0n) throw badRequest('INVALID_QTY', 'quantity must be positive');
    const agg = await this.prices.current(pair.symbol);
    const lp = side === 'BUY' ? agg.askLp : agg.bidLp;
    const exec = await this.lp.execute({ lp, pair: pair.symbol, side, qty: formatDecimal(qty, pair.baseDecimals), ref: randomUUID() });
    const { rows } = await this.db.query(
      `insert into hedges (pair, side, qty, rate, lp, lp_trade_ref, reason, actor) values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
      [pair.symbol, side, qty, exec.rate, exec.lp, exec.tradeRef, reason, actor],
    );
    await audit(this.db, actor, 'dealing.hedge', { hedgeId: rows[0].id, pair: pair.symbol, side, qty: exec.qty, rate: exec.rate, lp, reason });
    this.log.info({ pair: pair.symbol, side, qty: exec.qty, rate: exec.rate, lp, reason }, 'hedged with LP');
    return hedgeView(rows[0], pair);
  }

  async recentHedges(limit = 20) {
    const c = this.config.get().data;
    const { rows } = await this.db.query('select * from hedges order by seq desc limit $1', [limit]);
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
    reason: r.reason,
    at: new Date(r.created_at).toISOString(),
  };
}
