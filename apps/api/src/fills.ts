import { formatDecimal, formatPrice, parsePrice, findPair, type BankConfig, type Side } from '@p2p/shared';

export interface FillRow {
  notified_status?: string | null;
  id: string;
  seq: bigint;
  pair: string;
  maker_order_id: string;
  taker_order_id: string;
  buy_order_id: string;
  sell_order_id: string;
  book_price: string;
  qty: bigint;
  notional: bigint;
  buyer_effective_price: string;
  seller_effective_price: string;
  buyer_commission: bigint;
  seller_commission: bigint;
  buyer_tax: bigint;
  seller_tax: bigint;
  buyer_total: bigint;
  seller_total: bigint;
  config_version: number;
  created_at: Date;
}

/** A fill as everyone sees it on the market board: no customers, no commission or tax. */
export function tradeView(f: Pick<FillRow, 'id' | 'pair' | 'book_price' | 'qty' | 'taker_order_id' | 'buy_order_id' | 'created_at'>, config: BankConfig) {
  const pair = findPair(config, f.pair);
  return {
    id: f.id,
    pair: f.pair,
    price: formatPrice(parsePrice(f.book_price)),
    qty: formatDecimal(BigInt(f.qty), pair?.baseDecimals ?? 2),
    /** Side of the incoming order: BUY when a buyer took an offer. */
    takerSide: (f.taker_order_id === f.buy_order_id ? 'BUY' : 'SELL') as Side,
    at: new Date(f.created_at).toISOString(),
  };
}
export type TradeView = ReturnType<typeof tradeView>;

/** A fill from one customer's point of view. */
export function fillViewFor(
  f: FillRow,
  side: Side,
  config: BankConfig,
  settlement?: { status: string; receipt_ref: string | null },
) {
  const pair = findPair(config, f.pair);
  const baseDec = pair?.baseDecimals ?? 2;
  const quoteDec = pair?.quoteDecimals ?? 2;
  const buy = side === 'BUY';
  const money = (v: bigint) => formatDecimal(v, quoteDec);
  return {
    id: f.id,
    pair: f.pair,
    side,
    orderId: buy ? f.buy_order_id : f.sell_order_id,
    liquidity: (buy ? f.buy_order_id : f.sell_order_id) === f.maker_order_id ? 'MAKER' : 'TAKER',
    qty: formatDecimal(f.qty, baseDec),
    bookPrice: formatPrice(parsePrice(f.book_price)),
    effectivePrice: formatPrice(parsePrice(buy ? f.buyer_effective_price : f.seller_effective_price)),
    notional: money(f.notional),
    commission: money(buy ? f.buyer_commission : f.seller_commission),
    tax: money(buy ? f.buyer_tax : f.seller_tax),
    /** BUY: amount paid. SELL: amount received. */
    total: money(buy ? f.buyer_total : f.seller_total),
    currency: pair?.quote ?? f.pair.slice(3),
    settlementStatus: settlement?.status,
    receiptRef: settlement?.receipt_ref ?? undefined,
    createdAt: f.created_at.toISOString(),
  };
}
