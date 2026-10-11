// Shapes returned by the P2P API (see apps/api/src/routes/customer.ts). Shared request/quote types come from @p2p/shared.
import type { OrderStatus, QuoteBreakdown, Side } from '@p2p/shared';

export type { OrderStatus, QuoteBreakdown, Side };
export type Validity = 'DAY' | 'GTD' | 'GTC' | 'IOC';
export type OrderType = 'LIMIT' | 'MARKET';

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
  /** Value of one pip in quote currency, e.g. "0.0001". */
  pipSize: string;
  /** PIPS: a fixed commission per unit; BPS: a share of the price. */
  commission?: { mode: 'PIPS' | 'BPS'; buy: number; sell: number };
  /** Kambiyo vergisi for this pair (precious metals have their own rates). */
  tax?: { buyRate: string; sellRate: string };
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
  dealing?: { enabled: boolean; quoteTtlSeconds: number; maxDealQty: Record<string, string> };
  /** SEPARATE: the bank's Direct rates and the board in two areas. UNIFIED: one board, Direct as a quick path. */
  presentation?: 'SEPARATE' | 'UNIFIED';
  /** Whether the board marks levels holding bank liquidity. */
  sourceDisclosure?: boolean;
  marketOrders?: { enabled: boolean; maxSlippageBps: number };
  /** Set while trading is halted for everyone; `haltedPairs` lists halted pairs. */
  halted?: string | null;
  haltedPairs?: string[];
}

/** The bank's own rates for the customer's segment (LP price plus margin), live. */
export interface BankRates {
  pair: string;
  /** The customer buys from the bank at this rate. */
  buy: string;
  /** The customer sells to the bank at this rate. */
  sell: string;
  at: string;
}

/** A firm bank quote, executable until `expiresAt`. */
export interface BankQuote {
  id: string;
  pair: string;
  side: Side;
  qty: string;
  rate: string;
  notional: string;
  taxRate: string;
  tax: string;
  total: string;
  currency: string;
  expiresAt: string;
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
  /** With source disclosure: the part of `qty` that is the bank's (ladder and bot). */
  bankQty?: string;
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
  type?: OrderType;
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
  /** Null for a deal with the bank. */
  orderId: string | null;
  liquidity: 'MAKER' | 'TAKER' | 'BANK';
  counterparty?: 'BANK';
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
