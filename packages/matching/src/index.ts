import type { Side } from '@p2p/shared';

/** An order as the matching engine sees it. Prices are PRICE_SCALE units, quantities minor units. */
export interface BookOrder {
  id: string;
  ownerId: string;
  side: Side;
  price: bigint;
  remaining: bigint;
  /** Arrival sequence; lower is earlier (time priority). */
  seq: bigint;
}

export interface Level {
  price: bigint;
  qty: bigint;
  count: number;
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

  /** Aggregated price levels, best first. */
  depth(side: Side, maxLevels = 20): Level[] {
    return this.levels[side].slice(0, maxLevels).map((l) => ({
      price: l.price,
      qty: l.orders.reduce((s, o) => s + o.remaining, 0n),
      count: l.orders.length,
    }));
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
 */
export type MatchDecision =
  | { action: 'filled' }
  | { action: 'cancelMaker'; reason: string }
  | { action: 'cancelTaker'; reason: string };

export interface MatchResult {
  fills: { makerId: string; qty: bigint; price: bigint }[];
  cancelledMakers: { id: string; reason: string }[];
  /** Set when the incoming order was cancelled (self-match or the caller's decision). */
  takerCancelled?: string;
  /** Unfilled quantity of the incoming order. */
  remaining: bigint;
  /** True if the incoming order now rests in the book. */
  rested: boolean;
}

/**
 * Matches an incoming order against the book with price-time priority.
 *
 * Fills execute at the resting order's price. A customer's order never trades with
 * their own resting order: the incoming order is cancelled instead (cancel-newest).
 * The caller decides, per candidate, whether the trade can happen (balance holds in
 * `no_block` mode) and performs it. Whatever remains rests in the book.
 */
export async function matchIncoming(
  book: OrderBook,
  taker: BookOrder,
  onMatch: (c: MatchCandidate) => Promise<MatchDecision> | MatchDecision,
): Promise<MatchResult> {
  const result: MatchResult = { fills: [], cancelledMakers: [], remaining: taker.remaining, rested: false };
  const otherSide = opposite(taker.side);

  while (taker.remaining > 0n) {
    const maker = book.best(otherSide);
    if (!maker || !crosses(taker, maker)) break;

    if (maker.ownerId === taker.ownerId) {
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
    } else {
      result.takerCancelled = decision.reason;
      break;
    }
  }

  result.remaining = taker.remaining;
  if (!result.takerCancelled && taker.remaining > 0n) {
    book.add(taker);
    result.rested = true;
  }
  return result;
}
