import { randomUUID } from 'node:crypto';
import { findPair, formatDecimal, formatPrice, parseDecimal, parsePrice, PRICE_SCALE, type BankConfig, type PairConfig } from '@p2p/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/pool.js';
import type { Session } from '../auth.js';
import type { ConfigService } from '../config-service.js';
import type { Exchange } from '../engine/exchange.js';
import type { OrderEntry } from '../order-entry.js';
import { ApiError } from '../errors.js';
import { segmentRates, type PriceEngine } from './price-engine.js';
import type { PositionKeeper } from './positions.js';

type BookSide = 'asks' | 'bids';

export interface Level {
  price: bigint;
  qty: bigint;
}

/**
 * The bank's ladder for one side of a pair. Asks start `startPct` above the anchor segment's buy rate and step
 * outwards; bids mirror it below the sell rate. With `includeCommission`, the customer's commission is taken
 * out of the book price, so that what the customer pays (or receives) on a level is never better than the
 * bank's own rate for that segment.
 */
export function ladderLevels(config: BankConfig, pair: PairConfig, side: BookSide, anchor: bigint): Level[] {
  const ladder = config.bankBook.pairs[pair.symbol]?.[side];
  if (!ladder?.enabled) return [];
  const tick = parsePrice(pair.tickSize);
  const bip = parsePrice(pair.bipSize);
  const start = parsePrice(ladder.startPct);
  const step = parsePrice(ladder.stepPct);
  // percent in PRICE_SCALE units → fraction: anchor × pct / (100 × PRICE_SCALE)
  const away = (pct: bigint) => (anchor * pct) / (100n * PRICE_SCALE);
  return ladder.levels.map((q, i) => {
    const distance = away(start + step * BigInt(i));
    const qty = parseDecimal(q, pair.baseDecimals);
    if (side === 'asks') {
      const commission = config.bankBook.includeCommission ? BigInt(pair.commission.buyBips) * bip : 0n;
      const price = anchor + distance - commission;
      return { price: ((price + tick - 1n) / tick) * tick, qty };
    }
    const commission = config.bankBook.includeCommission ? BigInt(pair.commission.sellBips) * bip : 0n;
    const price = anchor - distance + commission;
    return { price: (price / tick) * tick, qty };
  });
}

interface SideState {
  anchor: bigint;
  config: BankConfig;
  placed: number;
}

/**
 * Market making with the bank's own account: keeps the configured ladder resting in the P2P book, reprices it
 * when the bank's rate moves or the configuration changes, refills levels customers have taken, and hands the
 * resulting position to the position keeper (which hedges it with the LPs past the limit).
 */
export class BankBook {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private readonly state = new Map<string, SideState>();
  private session: Session | undefined;

  constructor(
    private readonly db: Db,
    private readonly config: ConfigService,
    private readonly entry: OrderEntry,
    private readonly exchange: Exchange,
    private readonly prices: PriceEngine,
    private readonly positions: PositionKeeper,
    private readonly log: FastifyBaseLogger,
  ) {}

  start(intervalMs: number) {
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.log.error({ err }, 'bank book tick failed'));
    }, intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass over every pair and side. Safe to call directly (tests). */
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const config = this.config.get().data;
      const session = await this.houseSession(config);
      for (const pair of config.pairs) {
        for (const side of ['asks', 'bids'] as const) await this.syncSide(config, session, pair, side);
      }
    } finally {
      this.running = false;
    }
  }

  private async syncSide(config: BankConfig, session: Session, pair: PairConfig, side: BookSide) {
    const key = `${pair.symbol}:${side}`;
    const orderSide = side === 'asks' ? 'SELL' : 'BUY';
    const open = await this.openOrders(session, pair.symbol, orderSide);
    // A stale or missing LP price withdraws the bank's orders: the bank never rests prices it cannot hedge at.
    const agg = this.prices.fresh(pair.symbol);
    const wanted = config.bankBook.enabled && pair.enabled && agg && config.bankBook.pairs[pair.symbol]?.[side].enabled;
    if (!wanted) {
      await this.cancelAll(open);
      this.state.delete(key);
      return;
    }

    const rates = segmentRates(config, pair, agg, config.bankBook.anchorSegment);
    const anchor = side === 'asks' ? rates.buy : rates.sell;
    const levels = ladderLevels(config, pair, side, anchor);
    const prev = this.state.get(key);
    const moved = !prev || abs(anchor - prev.anchor) >= BigInt(config.bankBook.repriceBips) * parsePrice(pair.bipSize);
    // Fewer resting orders than were placed, or a partial fill: customers took bank liquidity.
    const taken = !!prev && (open.length < prev.placed || open.some((o) => o.filled > 0n));
    if (taken) await this.positions.afterDeal(pair.symbol);
    if (!moved && !taken && prev?.config === config) return;

    await this.cancelAll(open);
    let placed = 0;
    for (const level of levels) {
      try {
        await this.entry.place(
          session,
          { pair: pair.symbol, side: orderSide, qty: formatDecimal(level.qty, pair.baseDecimals), price: formatPrice(level.price), validity: 'GTC' },
          `bank-book:${randomUUID()}`,
          { house: true },
        );
        placed++;
      } catch (err) {
        // A level outside the price band, or the bank's account short of funds: skip it, keep the rest.
        const code = err instanceof ApiError ? err.code : String(err);
        this.log.warn({ pair: pair.symbol, side, price: formatPrice(level.price), code }, 'bank book level not placed');
      }
    }
    this.state.set(key, { anchor, config, placed });
    this.log.debug({ pair: pair.symbol, side, anchor: formatPrice(anchor), placed }, 'bank book repriced');
  }

  private async openOrders(session: Session, pair: string, side: 'BUY' | 'SELL') {
    const { rows } = await this.db.query(
      `select id, filled_qty from orders where customer_id = $1 and pair = $2 and side = $3 and status in ('OPEN', 'PARTIAL', 'QUEUED', 'NEW')`,
      [session.customerId, pair, side],
    );
    return rows.map((r) => ({ id: r.id as string, filled: BigInt(r.filled_qty) }));
  }

  private async cancelAll(orders: { id: string }[]) {
    for (const o of orders) await this.exchange.cancel(o.id, 'USER');
  }

  private async houseSession(config: BankConfig): Promise<Session> {
    const ref = config.bankBook.customerRef;
    if (this.session?.customerRef === ref) return this.session;
    const { rows } = await this.db.query(
      `insert into customers (customer_ref, segment) values ($1, 'bank')
       on conflict (customer_ref) do update set last_seen_at = now() returning id`,
      [ref],
    );
    this.session = { customerId: rows[0].id, customerRef: ref, segment: 'bank' };
    return this.session;
  }

  /** The bank's resting orders per pair and side, for the dealer screen. */
  async snapshot() {
    const config = this.config.get().data;
    const { rows } = await this.db.query(
      `select o.pair, o.side, o.book_price, o.qty, o.filled_qty from orders o join customers c on c.id = o.customer_id
        where c.customer_ref = $1 and o.status in ('OPEN', 'PARTIAL') order by o.pair, o.side, o.book_price`,
      [config.bankBook.customerRef],
    );
    return rows.map((r) => {
      const pair = findPair(config, r.pair);
      const d = pair?.baseDecimals ?? 2;
      return { pair: r.pair, side: r.side, price: formatPrice(parsePrice(r.book_price)), qty: formatDecimal(BigInt(r.qty) - BigInt(r.filled_qty), d) };
    });
  }
}

const abs = (v: bigint) => (v < 0n ? -v : v);
