import type { Side } from '@p2p/shared';

/** An order as the matching engine sees it. Prices are PRICE_SCALE units, quantities minor units. */
export interface BookOrder {
  id: string;
  /**
   * The economic owner (principal) of the order: two orders of the same principal never trade with each other
   * (self trade prevention). A customer is their own principal; the bank's ladder and its bot share the bank's.
   */
  principalId: string;
  side: Side;
  price: bigint;
  remaining: bigint;
  /** Arrival sequence; lower is earlier (time priority). */
  seq: bigint;
  /** Where the liquidity comes from. Kept for depth reporting only: it never affects priority. */
  source?: string;
}

export interface Level {
  price: bigint;
  qty: bigint;
  count: number;
  /** Quantity per source, when asked for. */
  bySource?: Record<string, bigint>;
}

/**
 * Price-time priority order book for one pair. Each side keeps price levels sorted
 * best-first, and each level keeps its orders in arrival order.
 */
export class OrderBook {
  private readonly levels: Record<Side, { price: bigint; orders: BookOrder[] }[]> = { BUY: [], SELL: [] };
  private readonly byId = new Map<string, BookOrder>();

  get size() {
    return this.byId.size;
  }

  get(id: string): BookOrder | undefined {
    return this.byId.get(id);
  }

  has(id: string) {
    return this.byId.has(id);
  }

  add(order: BookOrder): void {
    if (order.remaining <= 0n) throw new Error(`order ${order.id} has nothing to rest`);
    if (this.byId.has(order.id)) throw new Error(`order ${order.id} already in book`);
    const levels = this.levels[order.side];
    const better = (a: bigint, b: bigint) => (order.side === 'BUY' ? a > b : a < b);
    let i = 0;
    while (i < levels.length && better(levels[i].price, order.price)) i++;
    if (i < levels.length && levels[i].price === order.price) {
      const orders = levels[i].orders;
      // Keep time priority even when orders are reloaded out of order.
      let j = orders.length;
      while (j > 0 && orders[j - 1].seq > order.seq) j--;
      orders.splice(j, 0, order);
    } else {
      levels.splice(i, 0, { price: order.price, orders: [order] });
    }
    this.byId.set(order.id, order);
  }

  remove(id: string): BookOrder | undefined {
    const order = this.byId.get(id);
    if (!order) return undefined;
    const levels = this.levels[order.side];
    const li = levels.findIndex((l) => l.price === order.price);
    const level = levels[li];
    level.orders.splice(level.orders.indexOf(order), 1);
    if (level.orders.length === 0) levels.splice(li, 1);
    this.byId.delete(id);
    return order;
  }

  /** Reduces an order's remaining quantity, removing it when it reaches zero. */
  reduce(id: string, qty: bigint): void {
    const order = this.byId.get(id);
    if (!order) throw new Error(`order ${id} not in book`);
    if (qty > order.remaining) throw new Error(`cannot reduce ${id} by more than remaining`);
    order.remaining -= qty;
    if (order.remaining === 0n) this.remove(id);
  }

  /** Best resting order on a side (first in time at the best price). */
  best(side: Side): BookOrder | undefined {
    return this.levels[side][0]?.orders[0];
  }

  /** Aggregated price levels, best first; `bySource` adds each level's quantity per source. */
  depth(side: Side, maxLevels = 20, bySource = false): Level[] {
    return this.levels[side].slice(0, maxLevels).map((l) => {
      const level: Level = { price: l.price, qty: l.orders.reduce((s, o) => s + o.remaining, 0n), count: l.orders.length };
      if (bySource) {
        level.bySource = {};
        for (const o of l.orders) level.bySource[o.source ?? 'CUSTOMER'] = (level.bySource[o.source ?? 'CUSTOMER'] ?? 0n) + o.remaining;
      }
      return level;
    });
  }

  orders(): BookOrder[] {
    return [...this.byId.values()];
  }
}

export const opposite = (side: Side): Side => (side === 'BUY' ? 'SELL' : 'BUY');

export function crosses(taker: Pick<BookOrder, 'side' | 'price'>, maker: Pick<BookOrder, 'price'>): boolean {
  return taker.side === 'BUY' ? taker.price >= maker.price : taker.price <= maker.price;
}

export interface MatchCandidate {
  maker: BookOrder;
  /** Quantity that would trade. */
  qty: bigint;
  /** Execution price: always the resting (maker) order's price. */
  price: bigint;
}

/**
 * What the caller did with a candidate match.
 * - `filled`: the trade was executed (holds, persistence, settlement are the caller's job).
 * - `cancelMaker`: the resting order cannot trade (e.g. insufficient balance) and was cancelled;
 *   matching continues with the next resting order.
 * - `cancelTaker`: the incoming order cannot trade and was cancelled; matching stops.
 * - `skipMaker`: the book's view of the resting order was stale (the caller resyncs it); it leaves the
 *   book and matching continues with the next resting order.
 * - `stop`: the incoming order may not trade any further right now (e.g. the session closed); matching stops and
 *   what is left of it rests in the book.
 */
export type MatchDecision =
  | { action: 'filled' }
  | { action: 'cancelMaker'; reason: string }
  | { action: 'cancelTaker'; reason: string }
  | { action: 'skipMaker' }
  | { action: 'stop' };

export interface MatchResult {
  fills: { makerId: string; qty: bigint; price: bigint }[];
  cancelledMakers: { id: string; reason: string }[];
  /** Set when the incoming order was cancelled (self-match, a market order's unfilled remainder, or the caller's decision). */
  takerCancelled?: string;
  /** Unfilled quantity of the incoming order. */
  remaining: bigint;
  /** True if the incoming order now rests in the book. */
  rested: boolean;
}

/**
 * Matches an incoming order against the book with price-time priority: the best price first and, at one price,
 * the order the sequencer accepted first. Where an order comes from (customer, bank, bot) plays no part.
 *
 * Fills execute at the resting order's price. Two orders of the same principal never trade (self trade
 * prevention): by default the incoming order's remainder is cancelled (`CANCEL_TAKER`); with `CANCEL_MAKER` the
 * resting order is cancelled and matching goes on. The caller decides, per candidate, whether the trade can happen
 * (balance holds in `no_block` mode) and performs it. Whatever remains rests in the book, unless `rest` is false
 * (market orders: the remainder is cancelled).
 */
export async function matchIncoming(
  book: OrderBook,
  taker: BookOrder,
  onMatch: (c: MatchCandidate) => Promise<MatchDecision> | MatchDecision,
  opts: { selfTrade?: 'CANCEL_TAKER' | 'CANCEL_MAKER'; rest?: boolean } = {},
): Promise<MatchResult> {
  const result: MatchResult = { fills: [], cancelledMakers: [], remaining: taker.remaining, rested: false };
  const otherSide = opposite(taker.side);

  while (taker.remaining > 0n) {
    const maker = book.best(otherSide);
    if (!maker || !crosses(taker, maker)) break;

    if (maker.principalId === taker.principalId) {
      if (opts.selfTrade === 'CANCEL_MAKER') {
        book.remove(maker.id);
        result.cancelledMakers.push({ id: maker.id, reason: 'SELF_MATCH' });
        continue;
      }
      result.takerCancelled = 'SELF_MATCH';
      break;
    }

    const qty = maker.remaining < taker.remaining ? maker.remaining : taker.remaining;
    const decision = await onMatch({ maker, qty, price: maker.price });

    if (decision.action === 'filled') {
      book.reduce(maker.id, qty);
      taker.remaining -= qty;
      result.fills.push({ makerId: maker.id, qty, price: maker.price });
    } else if (decision.action === 'cancelMaker') {
      book.remove(maker.id);
      result.cancelledMakers.push({ id: maker.id, reason: decision.reason });
    } else if (decision.action === 'skipMaker') {
      book.remove(maker.id);
    } else if (decision.action === 'stop') {
      break;
    } else {
      result.takerCancelled = decision.reason;
      break;
    }
  }

  result.remaining = taker.remaining;
  if (!result.takerCancelled && taker.remaining > 0n) {
    if (opts.rest === false) {
      result.takerCancelled = 'NO_LIQUIDITY';
    } else {
      book.add(taker);
      result.rested = true;
    }
  }
  return result;
}
