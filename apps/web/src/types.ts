// Shapes returned by the P2P API (see apps/api/src/routes/customer.ts). Shared request/quote types come from @p2p/shared.
import type { OrderStatus, QuoteBreakdown, Side } from '@p2p/shared';

export type { OrderStatus, QuoteBreakdown, Side };
export type Validity = 'DAY' | 'GTD' | 'GTC';

export interface Branding {
  productName: string;
  logoUrl?: string;
  colors: Record<string, string>;
  radius: number;
  font?: string;
  locale: string;
  strings: Record<string, string>;
}

export interface PairInfo {
  symbol: string;
  base: string;
  quote: string;
  baseDecimals: number;
  quoteDecimals: number;
  tickSize: string;
  minQty: string;
  priceBandPct: string;
  /** Value of one bip in quote currency, e.g. "0.01". */
  bipSize: string;
  commissionPerUnit: { buy: string; sell: string };
}

export interface AppConfig {
  version: number;
  bank: { code: string; name: string };
  branding: Branding;
  balanceMode: 'block' | 'no_block';
  pairs: PairInfo[];
  tax: { buyRate: string; sellRate: string; base: 'effective' | 'book' };
  validity: { options: Validity[]; maxValidityDays: number };
  tradingHours: { timezone: string; days: number[]; open: string; close: string; outsideHours: 'reject' | 'queue' };
  marketOpen: boolean;
  limits: { maxOrderNotional: string; maxDailyNotional: string };
}

export interface Account {
  id: string;
  currency: string;
  name: string;
  iban?: string;
  balance: string;
  held: string;
  available: string;
}

export interface BookLevel {
  price: string;
  qty: string;
  count: number;
}

export interface Book {
  pair: string;
  bids: BookLevel[];
  asks: BookLevel[];
}

export interface Trade {
  id: string;
  pair: string;
  price: string;
  qty: string;
  /** BUY: a buyer took an offer (price ticked up); SELL: a seller hit a bid. */
  takerSide: Side;
  at: string;
}

export interface PairStats {
  pair: string;
  open: string | null;
  high: string | null;
  low: string | null;
  last: string | null;
  prevClose: string | null;
  volume: string;
  turnover: string;
  trades: number;
}

export interface Rate {
  pair: string;
  rate: string;
  asOf: string;
  buyPrice: string;
  sellPrice: string;
  bandLow: string;
  bandHigh: string;
}

export interface Order {
  id: string;
  pair: string;
  side: Side;
  price: string;
  qty: string;
  filledQty: string;
  remainingQty: string;
  status: OrderStatus;
  cancelReason?: string;
  validity: Validity;
  expiresAt: string;
  fxAccountId: string;
  tryAccountId: string;
  balanceMode: 'block' | 'no_block';
  quote: QuoteBreakdown;
  createdAt: string;
  updatedAt: string;
}

export interface Fill {
  id: string;
  pair: string;
  side: Side;
  orderId: string;
  liquidity: 'MAKER' | 'TAKER';
  qty: string;
  bookPrice: string;
  effectivePrice: string;
  notional: string;
  commission: string;
  tax: string;
  total: string;
  currency: string;
  settlementStatus?: string;
  receiptRef?: string;
  createdAt: string;
}

export interface Receipt {
  receiptRef: string;
  txnRef: string;
  title: string;
  customerRef: string;
  lines: { label: string; value: string }[];
  postedAt: string;
  reversed: boolean;
}
