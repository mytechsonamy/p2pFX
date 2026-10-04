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
] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];

const decimal = z.string().regex(/^\d+(\.\d+)?$/, 'expected a positive decimal string');

export const QuoteRequestSchema = z.object({
  pair: z.string(),
  side: SideSchema,
  /** Quantity of base currency, e.g. "1000". */
  qty: decimal,
  /** Book price in quote currency per unit of base, e.g. "49.15". */
  price: decimal,
});
export type QuoteRequest = z.infer<typeof QuoteRequestSchema>;

export const PlaceOrderSchema = QuoteRequestSchema.extend({
  validity: ValiditySchema,
  /** Required for GTD: ISO timestamp. */
  expiresAt: z.string().datetime({ offset: true }).optional(),
  /** Customer's FX account (core banking id). Defaults to their first account in the base currency. */
  fxAccountId: z.string().optional(),
  /** Customer's TRY account (core banking id). Defaults to their first account in the quote currency. */
  tryAccountId: z.string().optional(),
});
export type PlaceOrderRequest = z.infer<typeof PlaceOrderSchema>;

/** Full price breakdown shown on the order ticket and on receipts. All amounts are decimal strings. */
export interface QuoteBreakdown {
  pair: string;
  side: Side;
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
}

export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
}
