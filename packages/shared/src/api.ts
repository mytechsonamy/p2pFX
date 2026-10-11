import { z } from 'zod';
import { ValiditySchema } from './config.js';

export const SideSchema = z.enum(['BUY', 'SELL']);
export type Side = z.infer<typeof SideSchema>;

export const ORDER_STATUSES = ['NEW', 'QUEUED', 'OPEN', 'PARTIAL', 'FILLED', 'CANCELLED', 'EXPIRED', 'REJECTED'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const CANCEL_REASONS = [
  'USER',
  'EXPIRED',
  'SELF_MATCH',
  'INSUFFICIENT_BALANCE',
  'ENTRY_INTERRUPTED',
  'CORE_UNAVAILABLE',
  /** A market order's remainder when the book (within its price protection) ran out. */
  'NO_LIQUIDITY',
  /** Bank liquidity replaced by a new generation of its ladder or bot. */
  'REPLACED',
  /** Bank liquidity withdrawn: the source was switched off, the feed went stale or the pair was halted. */
  'WITHDRAWN',
  /** Cancelled by bank operations (kill switch). */
  'OPS_CANCEL',
  /** A bank order that would have taken the bank's position past its inventory cap. */
  'INVENTORY_LIMIT',
  /** A market order entered (or replayed) while the market was closed. */
  'MARKET_CLOSED',
  /** The book's view of the order was out of date; it was taken out. */
  'STALE',
] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];

const decimal = z.string().regex(/^\d+(\.\d+)?$/, 'expected a positive decimal string');

/**
 * LIMIT: trades at the price or better; what is left rests in the book for its validity. MARKET: takes the book
 * now, never beyond its protection price (the LP price ± the bank's maximum slippage); what is left is cancelled.
 */
export const OrderTypeSchema = z.enum(['LIMIT', 'MARKET']);
export type OrderType = z.infer<typeof OrderTypeSchema>;

const QuoteFields = z.object({
  pair: z.string(),
  side: SideSchema,
  /** Quantity of base currency, e.g. "1000". */
  qty: decimal,
  type: OrderTypeSchema.default('LIMIT'),
  /** Book price in quote currency per unit of base, e.g. "49.15". Limit orders only. */
  price: decimal.optional(),
});
const priceForLimit = (r: { type: OrderType; price?: string }) => r.type === 'MARKET' || !!r.price;
const priceRule = { message: 'price is required for a limit order', path: ['price'] };

export const QuoteRequestSchema = QuoteFields.refine(priceForLimit, priceRule);
export type QuoteRequest = z.infer<typeof QuoteRequestSchema>;

export const PlaceOrderSchema = QuoteFields.extend({
  /** Limit orders: how long the remainder rests. Market orders never rest. */
  validity: ValiditySchema.optional(),
  /** Required for GTD: ISO timestamp. */
  expiresAt: z.string().datetime({ offset: true }).optional(),
  /** Customer's FX account (core banking id). Defaults to their first account in the base currency. */
  fxAccountId: z.string().optional(),
  /** Customer's TRY account (core banking id). Defaults to their first account in the quote currency. */
  tryAccountId: z.string().optional(),
  /**
   * Market orders: the protection price the customer confirmed (from the quote). It binds: the order never trades
   * beyond it, and if the protection the bank would give now is worse for the customer the order is refused
   * (PROTECTION_PRICE_CHANGED) so they can confirm the new one.
   */
  protectionPrice: decimal.optional(),
})
  .refine(priceForLimit, priceRule)
  .refine((r) => r.type !== 'MARKET' || !!r.protectionPrice, { message: 'the confirmed protection price is required for a market order', path: ['protectionPrice'] })
  .refine((r) => r.type === 'MARKET' || !!r.validity, { message: 'validity is required for a limit order', path: ['validity'] });
export type PlaceOrderRequest = z.infer<typeof PlaceOrderSchema>;

/** Full price breakdown shown on the order ticket and on receipts. All amounts are decimal strings. */
export interface QuoteBreakdown {
  pair: string;
  side: Side;
  type?: OrderType;
  qty: string;
  bookPrice: string;
  commissionPerUnit: string;
  effectivePrice: string;
  /** qty × book price */
  notional: string;
  /** qty × commission per unit */
  commission: string;
  /** buy: notional + commission; sell: notional − commission */
  gross: string;
  taxRate: string;
  tax: string;
  /** buy: amount debited (gross + tax); sell: amount credited (gross − tax) */
  total: string;
  currency: string;
  /** Market orders: the protection price the breakdown is worked out at (the worst case). */
  protectionPrice?: string;
  /** Market orders: the average book price the visible depth would give now, and how much of the quantity it covers. */
  estimate?: { averagePrice: string; fillableQty: string };
}

export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
}
