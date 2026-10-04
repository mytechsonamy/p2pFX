import { z } from 'zod';

const decimalString = z.string().regex(/^\d+(\.\d+)?$/, 'expected a non-negative decimal string');
const hhmm = z.string().regex(/^([01]\d|2[0-4]):[0-5]\d$/, 'expected HH:MM');

export const ValiditySchema = z.enum(['DAY', 'GTD', 'GTC']);
export type Validity = z.infer<typeof ValiditySchema>;

export const PairConfigSchema = z.object({
  symbol: z.string().regex(/^[A-Z]{6}$/),
  base: z.string().length(3),
  quote: z.string().length(3),
  baseDecimals: z.number().int().min(0).max(8),
  quoteDecimals: z.number().int().min(0).max(8),
  /** Smallest price increment, e.g. "0.0001". */
  tickSize: decimalString,
  /** Smallest order quantity in base currency, e.g. "1". */
  minQty: decimalString,
  /** Orders priced more than this percentage away from the reference rate are rejected. */
  priceBandPct: decimalString,
  /** Bank commission per side, in bips. Added to the book price for buyers, subtracted for sellers. */
  commission: z.object({ buyBips: z.number().int().min(0), sellBips: z.number().int().min(0) }),
  /** Value of one bip in quote currency per unit of base, e.g. "0.01". */
  bipSize: decimalString,
  enabled: z.boolean(),
});
export type PairConfig = z.infer<typeof PairConfigSchema>;

export const LimitsSchema = z.object({
  /** Max value of a single order, in quote currency at book price. */
  maxOrderNotional: decimalString,
  /** Max total value of orders entered per day, in quote currency at book price. */
  maxDailyNotional: decimalString,
});

export const BankConfigSchema = z.object({
  bank: z.object({ code: z.string().min(1), name: z.string().min(1) }),
  branding: z.object({
    productName: z.string(),
    logoUrl: z.string().optional(),
    colors: z.record(z.string()),
    radius: z.number().int().min(0).default(12),
    font: z.string().optional(),
    locale: z.string().default('tr-TR'),
    strings: z.record(z.string()).default({}),
  }),
  /** `block`: hold funds at order entry. `no_block`: check at entry, hold at match, cancel if short. */
  balanceMode: z.enum(['block', 'no_block']),
  pairs: z.array(PairConfigSchema).min(1),
  /** Kambiyo vergisi (FX transaction tax), per side, as a fraction (e.g. "0.002" = binde 2). */
  tax: z.object({
    buyRate: decimalString,
    sellRate: decimalString,
    base: z.enum(['effective', 'book']),
  }),
  rounding: z.enum(['HALF_UP', 'HALF_EVEN', 'DOWN', 'UP']),
  validity: z.object({
    options: z.array(ValiditySchema).min(1),
    maxValidityDays: z.number().int().min(1),
  }),
  tradingHours: z.object({
    timezone: z.string(),
    /** ISO weekdays when trading is open, 1 = Monday ... 7 = Sunday. */
    days: z.array(z.number().int().min(1).max(7)),
    open: hhmm,
    close: hhmm,
    /** Dates (YYYY-MM-DD, local) when the market is closed. */
    holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
    /** What happens to orders entered while the market is closed. */
    outsideHours: z.enum(['reject', 'queue']),
  }),
  limits: z.object({ default: LimitsSchema, segments: z.record(LimitsSchema) }),
  orderRateLimit: z.object({ max: z.number().int().min(1), windowSeconds: z.number().int().min(1) }),
});
export type BankConfig = z.infer<typeof BankConfigSchema>;

export function findPair(config: BankConfig, symbol: string): PairConfig | undefined {
  return config.pairs.find((p) => p.symbol === symbol);
}

/** Default configuration used by the prototype and as a template for banks. */
export const DEFAULT_CONFIG: BankConfig = {
  bank: { code: 'DEMO', name: 'Demo Bank' },
  branding: {
    productName: 'Döviz Pazarı',
    colors: { primary: '#0B5FFF', onPrimary: '#FFFFFF', background: '#FFFFFF', text: '#111827', buy: '#059669', sell: '#DC2626' },
    radius: 12,
    locale: 'tr-TR',
    strings: {},
  },
  balanceMode: 'block',
  pairs: ['USD', 'EUR', 'GBP'].map((base) => ({
    symbol: `${base}TRY`,
    base,
    quote: 'TRY',
    baseDecimals: 2,
    quoteDecimals: 2,
    tickSize: '0.0001',
    minQty: '1',
    priceBandPct: '3',
    commission: { buyBips: 5, sellBips: 5 },
    bipSize: '0.01',
    enabled: true,
  })),
  tax: { buyRate: '0.002', sellRate: '0.002', base: 'effective' },
  rounding: 'HALF_UP',
  validity: { options: ['DAY', 'GTD', 'GTC'], maxValidityDays: 30 },
  // Open around the clock so the prototype can be demoed any time; banks set real hours.
  tradingHours: {
    timezone: 'Europe/Istanbul',
    days: [1, 2, 3, 4, 5, 6, 7],
    open: '00:00',
    close: '24:00',
    holidays: [],
    outsideHours: 'reject',
  },
  limits: {
    default: { maxOrderNotional: '1000000', maxDailyNotional: '5000000' },
    segments: { premium: { maxOrderNotional: '10000000', maxDailyNotional: '50000000' } },
  },
  orderRateLimit: { max: 30, windowSeconds: 60 },
};
