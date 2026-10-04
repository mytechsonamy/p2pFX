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

const MarginSchema = z.object({ buyBips: z.number().int().min(0), sellBips: z.number().int().min(0) });

/** The bank's own FX desk: prices aggregated from liquidity providers plus a margin per customer segment. */
const HedgingSchema = z.object({
  /** An auto-hedge brings the position down to this share of the limit, keeping its direction (0 = flat). */
  targetPct: z.number().min(0).max(99),
  /** Largest single LP ticket per currency; a bigger hedge is split into clips. A missing currency hedges in one ticket. */
  maxClipQty: z.record(decimalString),
  /** BEST_LP: every clip goes to the best-priced LP. ACROSS_LPS: clips go round the LPs from best to worst price. */
  split: z.enum(['BEST_LP', 'ACROSS_LPS']),
});
export type HedgingConfig = z.infer<typeof HedgingSchema>;

export const DEFAULT_HEDGING: HedgingConfig = {
  targetPct: 0,
  maxClipQty: { USD: '50000', EUR: '50000', GBP: '25000' },
  split: 'ACROSS_LPS',
};

export const DealingSchema = z.object({
  enabled: z.boolean(),
  /** How long a firm bank quote can be executed. */
  quoteTtlSeconds: z.number().int().min(1).max(120),
  /** LP quotes older than this are ignored. */
  maxStalenessMs: z.number().int().min(100),
  /** Bips (of the pair's bipSize) over the best LP price: customers buy at ask + buyBips, sell at bid − sellBips. */
  margins: z.object({ default: MarginSchema, segments: z.record(MarginSchema) }),
  /** Largest single deal per base currency. */
  maxDealQty: z.record(decimalString),
  /** Open position per currency above which the bank hedges (when autoHedge is on). */
  positionLimits: z.record(decimalString),
  autoHedge: z.boolean(),
  hedging: HedgingSchema.default(DEFAULT_HEDGING),
});
export type DealingConfig = z.infer<typeof DealingSchema>;

export const DEFAULT_DEALING: DealingConfig = {
  enabled: true,
  quoteTtlSeconds: 10,
  maxStalenessMs: 3000,
  margins: { default: { buyBips: 10, sellBips: 10 }, segments: { premium: { buyBips: 4, sellBips: 4 } } },
  maxDealQty: { USD: '250000', EUR: '250000', GBP: '100000' },
  positionLimits: { USD: '100000', EUR: '100000', GBP: '50000' },
  autoHedge: true,
  hedging: DEFAULT_HEDGING,
};

/** Customer sessions opened from the bank app. */
const SessionSchema = z.object({
  /** Platform session lifetime after the launch token is exchanged. */
  ttlMinutes: z.number().int().min(1).max(24 * 60),
});

/** Posting each fill's two bank FX legs to core banking. */
const SettlementSchema = z.object({
  /** Attempts per leg before the fill goes to operations review. */
  attempts: z.number().int().min(1).max(10),
  /** Backoff before attempt n is baseDelayMs × 2^(n−2). */
  baseDelayMs: z.number().int().min(0).max(60_000),
});

const LotSchema = z.object({ min: decimalString, max: decimalString, step: decimalString });

/** Demo order bots (market makers) that keep the board alive. Demo only. */
const BotsSchema = z.object({
  enabled: z.boolean(),
  /** Customer refs the bots trade as. */
  refs: z.array(z.string().min(1)).min(2),
  /** Customer segment the bots log in with (its limits come from `limits.segments`). */
  segment: z.string().min(1),
  /** Average pause between bot actions. */
  intervalMs: z.number().int().min(200),
  /** Open bot orders per pair and side above which the oldest are cancelled. */
  maxOrdersPerSide: z.number().int().min(1),
  /** Passive orders rest this many bips (of the pair's bipSize) away from the reference rate. */
  offsetBips: z.object({ min: z.number().int().min(1), max: z.number().int().min(1) }),
  /** Share of actions that are a bot-to-bot trade inside the spread, and that cancel a resting order. */
  tradeShare: z.number().min(0).max(1),
  cancelShare: z.number().min(0).max(1),
  /** Order size per base currency; `default` for the others. */
  lots: z.record(LotSchema),
});
export type BotsConfig = z.infer<typeof BotsSchema>;

export const DEFAULT_SESSION = { ttlMinutes: 30 };
export const DEFAULT_SETTLEMENT = { attempts: 3, baseDelayMs: 500 };
export const DEFAULT_BOTS: BotsConfig = {
  enabled: true,
  refs: ['demo-mm-1', 'demo-mm-2', 'demo-mm-3', 'demo-mm-4', 'demo-mm-5', 'demo-mm-6'],
  segment: 'market-maker',
  intervalMs: 1500,
  maxOrdersPerSide: 10,
  offsetBips: { min: 4, max: 25 },
  tradeShare: 0.25,
  cancelShare: 0.15,
  lots: { GBP: { min: '100', max: '1500', step: '50' }, default: { min: '200', max: '3500', step: '50' } },
};

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
  dealing: DealingSchema.default(DEFAULT_DEALING),
  session: SessionSchema.default(DEFAULT_SESSION),
  settlement: SettlementSchema.default(DEFAULT_SETTLEMENT),
  bots: BotsSchema.default(DEFAULT_BOTS),
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
    segments: {
      premium: { maxOrderNotional: '10000000', maxDailyNotional: '50000000' },
      // Demo order bots; limits a demo never reaches.
      'market-maker': { maxOrderNotional: '100000000', maxDailyNotional: '100000000000' },
    },
  },
  orderRateLimit: { max: 30, windowSeconds: 60 },
  dealing: DEFAULT_DEALING,
  session: DEFAULT_SESSION,
  settlement: DEFAULT_SETTLEMENT,
  bots: DEFAULT_BOTS,
};

/**
 * Parameters the prototype ships with defaults the bank has not confirmed yet. The back office flags each
 * until someone changes or confirms it. `paths` are dotted config paths; `*` matches any pair or key.
 */
export const ASSUMPTIONS: { key: string; label: string; paths: string[] }[] = [
  { key: 'tax', label: 'Kambiyo vergisi oranı ve matrahı', paths: ['tax'] },
  { key: 'tradingHours', label: 'İşlem saatleri ve tatiller', paths: ['tradingHours'] },
  { key: 'commission', label: 'P2P komisyonu (taraf başı bip)', paths: ['pairs.*.commission', 'pairs.*.bipSize'] },
  { key: 'margins', label: 'Banka satırı segment marjları', paths: ['dealing.margins'] },
  { key: 'balanceMode', label: 'Emir girişinde bakiye bloke', paths: ['balanceMode'] },
  { key: 'validity', label: 'Emir geçerlilik seçenekleri ve üst sınırı', paths: ['validity'] },
  { key: 'limits', label: 'Emir ve günlük tutar limitleri', paths: ['limits', 'orderRateLimit'] },
  { key: 'hedging', label: 'Pozisyon limitleri ve otomatik hedge kuralı', paths: ['dealing.positionLimits', 'dealing.autoHedge', 'dealing.hedging'] },
  { key: 'dealing', label: 'Banka kotasyon süresi, LP fiyat tazeliği, işlem üst sınırı', paths: ['dealing.quoteTtlSeconds', 'dealing.maxStalenessMs', 'dealing.maxDealQty'] },
  { key: 'session', label: 'Müşteri oturum süresi', paths: ['session'] },
  { key: 'settlement', label: 'Settlement yeniden deneme politikası', paths: ['settlement'] },
  { key: 'bots', label: 'Demo piyasa yapıcı botlar', paths: ['bots'] },
];

export interface ConfigChange {
  path: string;
  from: unknown;
  to: unknown;
}

/** Leaf-level differences between two configurations; arrays of objects are compared by index. */
export function diffConfig(a: unknown, b: unknown, path = ''): ConfigChange[] {
  const isObj = (v: unknown) => typeof v === 'object' && v !== null;
  const symbol = (v: unknown) => (isObj(v) ? (v as { symbol?: unknown }).symbol : undefined);
  if (Array.isArray(a) && Array.isArray(b) && [...a, ...b].every((v) => typeof symbol(v) === 'string')) {
    // Pairs are keyed by symbol so a path reads `pairs.USDTRY.commission.buyBips`.
    const bySymbol = (xs: unknown[]) => new Map(xs.map((x) => [symbol(x) as string, x]));
    const [ma, mb] = [bySymbol(a), bySymbol(b)];
    const keys = [...new Set([...ma.keys(), ...mb.keys()])];
    return keys.flatMap((k) => diffConfig(ma.get(k), mb.get(k), path ? `${path}.${k}` : k));
  }
  if (isObj(a) && isObj(b) && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = [...new Set([...Object.keys(a as object), ...Object.keys(b as object)])];
    return keys.flatMap((k) => diffConfig((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k));
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [{ path, from: a, to: b }];
}

/** True when `path` (from diffConfig) falls under the assumption `pattern` (may contain `*`). */
export function pathMatches(path: string, pattern: string): boolean {
  const p = path.split('.');
  const q = pattern.split('.');
  return q.length <= p.length && q.every((seg, i) => seg === '*' || seg === p[i]);
}
