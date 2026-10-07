import { z } from 'zod';
import { withPair } from './instruments.js';

const decimalString = z.string().regex(/^\d+(\.\d+)?$/, 'expected a non-negative decimal string');
const hhmm = z.string().regex(/^([01]\d|2[0-4]):[0-5]\d$/, 'expected HH:MM');

export const ValiditySchema = z.enum(['DAY', 'GTD', 'GTC']);
export type Validity = z.infer<typeof ValiditySchema>;

export const FeeModeSchema = z.enum(['PIPS', 'BPS']);
export type FeeMode = z.infer<typeof FeeModeSchema>;

const CommissionSchema = z.object({ mode: FeeModeSchema, buy: z.number().int().min(0), sell: z.number().int().min(0) });

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
  /**
   * The pair's market pip: the price unit fees and margins are counted in, in quote currency per unit of base,
   * e.g. "0.0001" (5 pips = 0.0005 TRY). Never a basis point: bps are always a fraction of the price.
   */
  pipSize: decimalString,
  /**
   * Bank commission per side. PIPS: an absolute fee of `buy`/`sell` pips per unit of base (500 pips × 0.0001 =
   * 0.05 TRY per USD). BPS: a share of the book price (5 bps = 0.05 %). Added to the book price for buyers,
   * subtracted for sellers, and shown before the customer confirms.
   */
  commission: CommissionSchema,
  enabled: z.boolean(),
});
export type PairConfig = z.infer<typeof PairConfigSchema>;

export const LimitsSchema = z.object({
  /** Max value of a single order, in quote currency at book price. */
  maxOrderNotional: decimalString,
  /** Max total value of orders entered per day, in quote currency at book price. */
  maxDailyNotional: decimalString,
  /** Orders per `orderRateLimit` window for this segment, instead of `orderRateLimit.max`. */
  maxOrdersPerWindow: z.number().int().min(1).optional(),
});

/** The bank's margin over the LP price, in pips of the pair. */
const MarginSchema = z.object({ buyPips: z.number().int().min(0), sellPips: z.number().int().min(0) });

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
  /** How long a firm bank quote can be executed. */
  quoteTtlSeconds: z.number().int().min(1).max(120),
  /** LP quotes older than this are ignored. */
  maxStalenessMs: z.number().int().min(100),
  /** Pips over the best LP price: customers buy at ask + buyPips, sell at bid − sellPips. */
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
  quoteTtlSeconds: 10,
  maxStalenessMs: 3000,
  margins: { default: { buyPips: 1000, sellPips: 1000 }, segments: { premium: { buyPips: 400, sellPips: 400 } } },
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
  /**
   * ASYNC: matching commits the fill and moves on; the legs (the fill's outbox) are posted by the settlement
   * dispatcher. INLINE: the pair waits for core banking before the next match.
   */
  dispatch: z.enum(['ASYNC', 'INLINE']).default('ASYNC'),
});

const LotSchema = z.object({ min: decimalString, max: decimalString, step: decimalString });


/**
 * The bank's algorithmic market maker (BOT_MM): extra levels around the LP reference, entered as real orders for
 * the bank (the principal) under one strategy id. It shares the bank's inventory limit with the ladder and the
 * Direct channel, never trades with them (self trade prevention) and withdraws on a stale feed.
 */
const BotMarketMakerSchema = z.object({
  strategyId: z.string().min(1),
  /** Levels per side. */
  levels: z.number().int().min(1).max(20),
  /** Distance of the first level from the LP mid, in pips; each level is placed somewhere in this range. */
  offsetPips: z.object({ min: z.number().int().min(1), max: z.number().int().min(1) }),
  /** Minimum distance between consecutive levels, in pips. */
  stepPips: z.number().int().min(1),
  /** How often the strategy refreshes its levels (a new generation). */
  refreshMs: z.number().int().min(200),
  /** Order size per base currency; `default` for the others. */
  lots: z.record(LotSchema),
});
export type BotMarketMakerConfig = z.infer<typeof BotMarketMakerSchema>;

/** One side of the bank's ladder in a pair: levels moving away from the bank's own rate. */
const LadderSchema = z.object({
  enabled: z.boolean(),
  /** Distance of the first level from the bank's rate, in percent ("0.02" = 0.02 %). */
  startPct: decimalString,
  /** Distance between consecutive levels, in percent. */
  stepPct: decimalString,
  /** Quantity of each level from the best price outwards (t1, t2, … tz); the length is the number of levels. */
  levels: z.array(decimalString).min(1).max(20),
});

/** The bank's own orders in the P2P book, priced off its published rate and repriced as the LPs move. */
const BankBookSchema = z.object({
  /** The bank's own trading account in core banking that its orders (ladder and bot) are entered for. */
  customerRef: z.string().min(1),
  /** Segment whose bank-row rate anchors the ladder (asks above its buy rate, bids below its sell rate). */
  anchorSegment: z.string().min(1),
  /**
   * Bank L1 parity: price levels so that, once the customer's commission is added, no level beats the bank's own
   * Direct rate (L1 ask = Direct ask − buyer fee, L1 bid = Direct bid + seller fee).
   */
  includeCommission: z.boolean(),
  /** Reprice a side when its anchor rate has moved at least this many pips. */
  repricePips: z.number().int().min(1),
  /** Per pair symbol; a pair without an entry has no bank orders. */
  pairs: z.record(z.object({ asks: LadderSchema, bids: LadderSchema })),
});
export type BankBookConfig = z.infer<typeof BankBookSchema>;

const ladder = (levels: string[]) => ({ enabled: true, startPct: '0.02', stepPct: '0.02', levels });
export const DEFAULT_BANK_BOOK: BankBookConfig = {
  customerRef: 'bank-desk',
  anchorSegment: 'default',
  includeCommission: true,
  repricePips: 200,
  pairs: {
    USDTRY: { asks: ladder(['5000', '10000', '20000']), bids: ladder(['5000', '10000', '20000']) },
    EURTRY: { asks: ladder(['5000', '10000', '20000']), bids: ladder(['5000', '10000', '20000']) },
    GBPTRY: { asks: ladder(['2000', '5000', '10000']), bids: ladder(['2000', '5000', '10000']) },
  },
};

export const DEFAULT_SESSION = { ttlMinutes: 30 };
export const DEFAULT_CHANNELS: ChannelsConfig = { bankDirect: true, bankMarketMaker: true, botMarketMaker: true };
export const DEFAULT_KILL_SWITCH = { allTrading: false, newCustomerOrders: false, haltedPairs: [] as string[], disabledLps: [] as string[] };
export const DEFAULT_INVENTORY = { maxPosition: { USD: '250000', EUR: '250000', GBP: '120000' } as Record<string, string> };
export const DEFAULT_MARKET_ORDERS = { enabled: true, maxSlippageBps: 50 };
export const DEFAULT_SETTLEMENT = { attempts: 3, baseDelayMs: 500, dispatch: 'ASYNC' as const };
export const DEFAULT_BOT_MM: BotMarketMakerConfig = {
  strategyId: 'bot-mm-1',
  levels: 4,
  offsetPips: { min: 400, max: 2500 },
  stepPips: 100,
  refreshMs: 3000,
  lots: { GBP: { min: '100', max: '1500', step: '50' }, default: { min: '200', max: '3500', step: '50' } },
};

/** The three liquidity sources the bank switches on and off independently (each under the kill switch). */
const ChannelsSchema = z.object({
  /** BANK_DIRECT: the bank's instant quote-and-deal channel (the bank row). */
  bankDirect: z.boolean(),
  /** BANK_MM: the bank's ladder resting in the board. */
  bankMarketMaker: z.boolean(),
  /** BOT_MM: the bank's algorithmic market maker resting in the board. */
  botMarketMaker: z.boolean(),
});
export type ChannelsConfig = z.infer<typeof ChannelsSchema>;

/**
 * Stopping trading at different levels. Stopping new entries is configuration (below); cancelling open orders is a
 * separate, audited operation (POST /ops/controls/cancel-orders). Fills already made keep settling and hedging.
 */
const KillSwitchSchema = z.object({
  /** No new orders, quotes, deals or bank liquidity anywhere. */
  allTrading: z.boolean(),
  /** No new customer orders (bank liquidity and Direct may continue unless switched off too). */
  newCustomerOrders: z.boolean(),
  /** Pairs where nothing new is accepted and bank liquidity is withdrawn. */
  haltedPairs: z.array(z.string()),
  /** Liquidity providers left out of prices and hedging. */
  disabledLps: z.array(z.string()),
});

/** The bank's inventory: open position per base currency that its principal channels together may not exceed. */
const InventorySchema = z.object({
  /** Hard cap per currency: at the cap the side that would increase the position is closed (ladder, bot, Direct). */
  maxPosition: z.record(decimalString),
});

const MarketOrdersSchema = z.object({
  enabled: z.boolean(),
  /** Price protection: a market order never trades worse than the LP price ± this many bps. */
  maxSlippageBps: z.number().int().min(1).max(1000),
});

export const BankConfigShape = z.object({
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
    /** Rates for precious metal pairs (gold, silver, platinum), which may diverge from the FX rates. */
    metals: z.object({ buyRate: decimalString, sellRate: decimalString }).default({ buyRate: '0.002', sellRate: '0.002' }),
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
  bankBook: BankBookSchema.default(DEFAULT_BANK_BOOK),
  botMarketMaker: BotMarketMakerSchema.default(DEFAULT_BOT_MM),
  channels: ChannelsSchema.default(DEFAULT_CHANNELS),
  /** SEPARATE: the bank's Direct rates and the board in two areas. UNIFIED: one executable board, Direct as a quick path. */
  marketPresentation: z.enum(['SEPARATE', 'UNIFIED']).default('SEPARATE'),
  /** Whether customers see which price levels hold bank liquidity (the bank's UX and compliance decision). */
  sourceDisclosure: z.boolean().default(false),
  /** Two orders of the same principal never trade: cancel the incoming order's remainder, or the resting order. */
  selfTradePrevention: z.enum(['CANCEL_TAKER', 'CANCEL_MAKER']).default('CANCEL_TAKER'),
  killSwitch: KillSwitchSchema.default(DEFAULT_KILL_SWITCH),
  inventory: InventorySchema.default(DEFAULT_INVENTORY),
  marketOrders: MarketOrdersSchema.default(DEFAULT_MARKET_ORDERS),
});

/** Configuration as stored and edited; older shapes are upgraded on the way in (see `upgradeConfig`). */
export const BankConfigSchema = z.preprocess((v) => upgradeConfig(v).data, BankConfigShape);
export type BankConfig = z.infer<typeof BankConfigShape>;

export function findPair(config: BankConfig, symbol: string): PairConfig | undefined {
  return config.pairs.find((p) => p.symbol === symbol);
}

/**
 * Pairs open in the prototype: the currencies and metals the demo LPs quote that demo customers hold. The LPs
 * quote a few more, which the back office can add (`withPair`).
 */
export const DEFAULT_PAIRS = ['USD', 'EUR', 'GBP', 'CHF', 'JPY', 'CAD', 'AUD', 'SAR', 'XAU', 'XAG', 'XPT'];

const BASE_CONFIG: BankConfig = {
  bank: { code: 'DEMO', name: 'Demo Bank' },
  branding: {
    productName: 'Döviz Pazarı',
    colors: { primary: '#0B5FFF', onPrimary: '#FFFFFF', background: '#FFFFFF', text: '#111827', buy: '#059669', sell: '#DC2626' },
    radius: 12,
    locale: 'tr-TR',
    strings: {},
  },
  balanceMode: 'block',
  pairs: [],
  tax: { buyRate: '0.002', sellRate: '0.002', base: 'effective', metals: { buyRate: '0.002', sellRate: '0.002' } },
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
    },
  },
  orderRateLimit: { max: 30, windowSeconds: 60 },
  dealing: DEFAULT_DEALING,
  session: DEFAULT_SESSION,
  settlement: DEFAULT_SETTLEMENT,
  bankBook: DEFAULT_BANK_BOOK,
  botMarketMaker: DEFAULT_BOT_MM,
  channels: DEFAULT_CHANNELS,
  marketPresentation: 'SEPARATE',
  sourceDisclosure: false,
  selfTradePrevention: 'CANCEL_TAKER',
  killSwitch: DEFAULT_KILL_SWITCH,
  inventory: DEFAULT_INVENTORY,
  marketOrders: DEFAULT_MARKET_ORDERS,
};

/** Default configuration used by the prototype and as a template for banks. */
export const DEFAULT_CONFIG: BankConfig = DEFAULT_PAIRS.reduce((c, code) => withPair(c, code, { enabled: true }), BASE_CONFIG);

/**
 * Parameters the prototype ships with defaults the bank has not confirmed yet. The back office flags each
 * until someone changes or confirms it. `paths` are dotted config paths; `*` matches any pair or key.
 */
export const ASSUMPTIONS: { key: string; label: string; paths: string[] }[] = [
  { key: 'tax', label: 'Kambiyo vergisi oranı ve matrahı', paths: ['tax'] },
  { key: 'tradingHours', label: 'İşlem saatleri ve tatiller', paths: ['tradingHours'] },
  { key: 'commission', label: 'P2P komisyonu (taraf başı pip veya bps) ve pip değeri', paths: ['pairs.*.commission', 'pairs.*.pipSize'] },
  { key: 'margins', label: 'Banka satırı segment marjları', paths: ['dealing.margins'] },
  { key: 'balanceMode', label: 'Emir girişinde bakiye bloke', paths: ['balanceMode'] },
  { key: 'validity', label: 'Emir geçerlilik seçenekleri ve üst sınırı', paths: ['validity'] },
  { key: 'limits', label: 'Emir ve günlük tutar limitleri', paths: ['limits', 'orderRateLimit'] },
  { key: 'hedging', label: 'Pozisyon limitleri ve otomatik hedge kuralı', paths: ['dealing.positionLimits', 'dealing.autoHedge', 'dealing.hedging'] },
  { key: 'dealing', label: 'Banka kotasyon süresi, LP fiyat tazeliği, işlem üst sınırı', paths: ['dealing.quoteTtlSeconds', 'dealing.maxStalenessMs', 'dealing.maxDealQty'] },
  { key: 'session', label: 'Müşteri oturum süresi', paths: ['session'] },
  { key: 'settlement', label: 'Settlement yeniden deneme politikası', paths: ['settlement'] },
  { key: 'bankBook', label: 'Bankanın tahtaya girdiği kademeli emirler (Bank MM)', paths: ['bankBook'] },
  { key: 'botMarketMaker', label: 'Algoritmik piyasa yapıcı stratejisi (Bot MM)', paths: ['botMarketMaker'] },
  { key: 'channels', label: 'Likidite kaynakları ve tahta sunumu', paths: ['channels', 'marketPresentation', 'sourceDisclosure'] },
  { key: 'inventory', label: 'Banka envanter üst sınırları', paths: ['inventory'] },
  { key: 'marketOrders', label: 'Piyasa emri ve fiyat koruması', paths: ['marketOrders'] },
  { key: 'selfTradePrevention', label: 'Kendi kendine işlem önleme davranışı', paths: ['selfTradePrevention'] },
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

/** A semantic problem in an otherwise well-formed configuration, shaped like a zod issue for the back office. */
export interface ConfigIssue {
  path: (string | number)[];
  message: string;
}

const positive = (v: string) => /[1-9]/.test(v);

/**
 * Cross-field rules the schema cannot express: values that must be positive (a zero tick size or bip size
 * would break pricing), pair symbols that must match their currencies, and no duplicate pairs.
 */
export function configIssues(c: BankConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const seen = new Set<string>();
  c.pairs.forEach((p, i) => {
    const at = (field: string) => ['pairs', i, field];
    if (p.symbol !== `${p.base}${p.quote}`) issues.push({ path: at('symbol'), message: `must be ${p.base}${p.quote} (base + quote)` });
    if (seen.has(p.symbol)) issues.push({ path: at('symbol'), message: `${p.symbol} appears more than once` });
    seen.add(p.symbol);
    for (const f of ['tickSize', 'minQty', 'pipSize', 'priceBandPct'] as const) {
      if (!positive(p[f])) issues.push({ path: at(f), message: 'must be greater than zero' });
    }
    const tickDecimals = p.tickSize.split('.')[1]?.length ?? 0;
    if (tickDecimals > 8) issues.push({ path: at('tickSize'), message: 'at most 8 decimals' });
    if ((p.pipSize.split('.')[1]?.length ?? 0) > 8) issues.push({ path: at('pipSize'), message: 'at most 8 decimals' });
    const minDecimals = p.minQty.split('.')[1]?.length ?? 0;
    if (minDecimals > p.baseDecimals) issues.push({ path: at('minQty'), message: `at most ${p.baseDecimals} decimals` });
  });
  const { min, max } = c.botMarketMaker.offsetPips;
  if (min > max) issues.push({ path: ['botMarketMaker', 'offsetPips', 'min'], message: 'must not exceed the maximum' });
  for (const [seg, l] of Object.entries({ default: c.limits.default, ...c.limits.segments })) {
    if (!positive(l.maxOrderNotional)) issues.push({ path: ['limits', seg, 'maxOrderNotional'], message: 'must be greater than zero' });
  }
  return issues;
}

// ---- upgrading stored configurations ----

/** "0.01" shifted by -2 places → "0.0001", without floating point. */
export function shiftDecimal(dec: string, places: number): string {
  const [i, f = ''] = dec.split('.');
  let digits = i + f;
  let point = i.length + places;
  if (point < 0) {
    digits = '0'.repeat(-point) + digits;
    point = 0;
  }
  if (point > digits.length) digits += '0'.repeat(point - digits.length);
  const int = digits.slice(0, point).replace(/^0+(?=\d)/, '') || '0';
  const frac = digits.slice(point).replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
}

/**
 * One bip of the old configuration is 100 pips of the new one: `pipSize = bipSize / 100`, and every amount
 * counted in bips is multiplied by 100. Prices and fees stay exactly what they were (5 bips × 0.01 TRY =
 * 500 pips × 0.0001 TRY = 0.05 TRY per USD); only the unit is renamed, so no amount moves by a factor of 100.
 */
export const PIPS_PER_BIP = 100;

/**
 * Upgrades a configuration stored by an earlier version to the current shape (v1.1): bips become pips (see
 * PIPS_PER_BIP), the on/off switches of the Direct channel, the bank ladder and the demo bots become the three
 * independent `channels`, and the demo bots (customers trading among themselves) become the bank's BOT_MM
 * strategy. Returns the configuration unchanged (`changed: false`) when it is already current.
 */
export function upgradeConfig(input: unknown): { data: unknown; changed: boolean; notes: string[] } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { data: input, changed: false, notes: [] };
  const c = structuredClone(input) as Record<string, any>;
  const notes: string[] = [];
  const bipsToPips = (v: unknown) => (typeof v === 'number' ? v * PIPS_PER_BIP : v);

  if (Array.isArray(c.pairs)) {
    for (const p of c.pairs) {
      if (!p || typeof p !== 'object') continue;
      if (typeof p.bipSize === 'string' && p.pipSize === undefined) {
        p.pipSize = shiftDecimal(p.bipSize, -2);
        notes.push(`${p.symbol}: bipSize ${p.bipSize} → pipSize ${p.pipSize}`);
      }
      delete p.bipSize;
      const com = p.commission;
      if (com && typeof com === 'object' && 'buyBips' in com) {
        p.commission = { mode: 'PIPS', buy: bipsToPips(com.buyBips), sell: bipsToPips(com.sellBips) };
        notes.push(`${p.symbol}: komisyon ${com.buyBips}/${com.sellBips} bip → ${p.commission.buy}/${p.commission.sell} pip`);
      }
    }
  }

  const d = c.dealing;
  if (d && typeof d === 'object') {
    const margin = (m: any) => (m && typeof m === 'object' && 'buyBips' in m ? { buyPips: bipsToPips(m.buyBips), sellPips: bipsToPips(m.sellBips) } : m);
    if (d.margins && typeof d.margins === 'object') {
      const before = JSON.stringify(d.margins);
      d.margins = {
        ...d.margins,
        default: margin(d.margins.default),
        segments: Object.fromEntries(Object.entries(d.margins.segments ?? {}).map(([k, m]) => [k, margin(m)])),
      };
      if (JSON.stringify(d.margins) !== before) notes.push('Banka satırı marjları bip → pip (×100)');
    }
  }

  const channels: Record<string, boolean> = {};
  if (d && typeof d.enabled === 'boolean') {
    channels.bankDirect ??= d.enabled;
    delete d.enabled;
  }
  const bb = c.bankBook;
  if (bb && typeof bb === 'object') {
    if (typeof bb.enabled === 'boolean') {
      channels.bankMarketMaker ??= bb.enabled;
      delete bb.enabled;
    }
    if (typeof bb.repriceBips === 'number') {
      bb.repricePips ??= bb.repriceBips * PIPS_PER_BIP;
      delete bb.repriceBips;
    }
  }
  if (c.bots && typeof c.bots === 'object') {
    channels.botMarketMaker ??= !!c.bots.enabled;
    c.botMarketMaker ??= {
      ...DEFAULT_BOT_MM,
      ...(c.bots.lots ? { lots: c.bots.lots } : {}),
      ...(c.bots.offsetBips ? { offsetPips: { min: bipsToPips(c.bots.offsetBips.min), max: bipsToPips(c.bots.offsetBips.max) } } : {}),
    };
    delete c.bots;
    notes.push('Demo botlar (müşteri olarak kendi aralarında işlem yapan) bankanın Bot MM stratejisine dönüştü; bot-bot işlem yok');
  }
  if (Object.keys(channels).length && !c.channels) {
    c.channels = { ...DEFAULT_CHANNELS, ...channels };
    notes.push('Bank Direct, Bank MM ve Bot MM bağımsız kontrollere (channels) taşındı');
  }

  const changed = JSON.stringify(c) !== JSON.stringify(input);
  return { data: changed ? c : input, changed, notes };
}
