import { formatDecimal, formatPrice, parsePrice, findPair, type BankConfig, type OrderStatus, type PairConfig, type Side, type Validity } from '@p2p/shared';
import { fromSnapshot, priceSide, toBreakdown, type PricingSnapshot } from '@p2p/pricing';
import type { Queryable } from './db/pool.js';

export interface OrderRow {
  id: string;
  seq: bigint;
  customer_id: string;
  customer_ref: string;
  pair: string;
  side: Side;
  book_price: string;
  qty: bigint;
  filled_qty: bigint;
  validity: Validity;
  expires_at: Date;
  fx_account_id: string;
  try_account_id: string;
  hold_id: string | null;
  status: OrderStatus;
  cancel_reason: string | null;
  pricing: PricingSnapshot;
  config_version: number;
  balance_mode: 'block' | 'no_block';
  notional: bigint;
  idempotency_key: string;
  request_hash: string;
  created_at: Date;
  updated_at: Date;
}

export const LIVE_STATUSES: OrderStatus[] = ['OPEN', 'PARTIAL'];

const ORDER_SELECT = 'select o.*, c.customer_ref from orders o join customers c on c.id = o.customer_id';

export async function loadOrder(db: Queryable, id: string, forUpdate = false): Promise<OrderRow | undefined> {
  const { rows } = await db.query(`${ORDER_SELECT} where o.id = $1${forUpdate ? ' for update of o' : ''}`, [id]);
  return rows[0];
}

export async function loadOrders(db: Queryable, where: string, params: unknown[]): Promise<OrderRow[]> {
  const { rows } = await db.query(`${ORDER_SELECT} where ${where}`, params);
  return rows;
}

export const remainingOf = (o: Pick<OrderRow, 'qty' | 'filled_qty'>) => o.qty - o.filled_qty;

/** Funds an order needs for `qty`: FX quantity for a sell, worst-case TRY total (at the limit price) for a buy. */
export function requirementFor(o: Pick<OrderRow, 'side' | 'book_price' | 'pricing'>, qty: bigint): bigint {
  if (o.side === 'SELL') return qty;
  return priceSide(qty, parsePrice(o.book_price), fromSnapshot(o.pricing)).total;
}

/** Order as returned by the API. */
export function orderView(o: OrderRow, config: BankConfig) {
  // A pair removed from the config still renders from the order's own snapshot.
  const pair =
    findPair(config, o.pair) ??
    ({ symbol: o.pair, base: o.pair.slice(0, 3), quote: o.pair.slice(3), baseDecimals: o.pricing.baseDecimals, quoteDecimals: o.pricing.quoteDecimals } as PairConfig);
  const params = fromSnapshot(o.pricing);
  const quote = toBreakdown(pair, priceSide(o.qty, parsePrice(o.book_price), params), params);
  return {
    id: o.id,
    pair: o.pair,
    side: o.side,
    price: formatPrice(parsePrice(o.book_price)),
    qty: formatDecimal(o.qty, pair.baseDecimals),
    filledQty: formatDecimal(o.filled_qty, pair.baseDecimals),
    remainingQty: formatDecimal(remainingOf(o), pair.baseDecimals),
    status: o.status,
    cancelReason: o.cancel_reason ?? undefined,
    validity: o.validity,
    expiresAt: o.expires_at.toISOString(),
    fxAccountId: o.fx_account_id,
    tryAccountId: o.try_account_id,
    balanceMode: o.balance_mode,
    /** Breakdown confirmed at entry, for the full quantity at the limit price. */
    quote,
    createdAt: o.created_at.toISOString(),
    updatedAt: o.updated_at.toISOString(),
  };
}
export type OrderView = ReturnType<typeof orderView>;
