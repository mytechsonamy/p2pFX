import type { BankConfig, PairConfig } from './config.js';

/**
 * Currencies and precious metals the bank can open for P2P trading against TRY, with sensible starting
 * parameters. The list the bank actually offers is whatever its liquidity providers quote (`GET
 * /ops/instruments`); this catalog only supplies names and defaults, and an instrument missing from it gets
 * defaults derived from its rate. Metals are quoted in TRY per gram, with the quantity in grams.
 */
export interface Instrument {
  code: string;
  name: string;
  kind: 'fx' | 'metal';
  /** Decimals of the quantity (and of the customer's account in core banking). */
  decimals: number;
  tickSize: string;
  bipSize: string;
  minQty: string;
  /** Demo bot order sizes. */
  lot: { min: string; max: string; step: string };
  /** The bank's ladder quantities in the book, best level first. */
  ladder: string[];
  /** Largest bank deal, position limit before hedging, largest single LP ticket. */
  maxDeal: string;
  position: string;
  clip: string;
}

type Spec = Omit<Instrument, 'code' | 'name' | 'kind'>;

const major: Spec = {
  decimals: 2,
  tickSize: '0.0001',
  bipSize: '0.01',
  minQty: '1',
  lot: { min: '200', max: '3500', step: '50' },
  ladder: ['5000', '10000', '20000'],
  maxDeal: '250000',
  position: '100000',
  clip: '50000',
};
const pound: Spec = { ...major, lot: { min: '100', max: '1500', step: '50' }, ladder: ['2000', '5000', '10000'], maxDeal: '100000', position: '50000', clip: '25000' };
const dollarBloc: Spec = { ...major, lot: { min: '200', max: '3000', step: '50' }, ladder: ['3000', '6000', '12000'], maxDeal: '150000', position: '75000', clip: '30000' };
/** Currencies worth a few lira: a finer bip so that 5 bips stays a small fraction of the price. */
const small: Spec = {
  ...major,
  bipSize: '0.001',
  minQty: '10',
  lot: { min: '1000', max: '15000', step: '100' },
  ladder: ['20000', '40000', '80000'],
  maxDeal: '1000000',
  position: '400000',
  clip: '200000',
};

const fx = (code: string, name: string, spec: Spec): Instrument => ({ code, name, kind: 'fx', ...spec });
const metal = (code: string, name: string, spec: Spec): Instrument => ({ code, name, kind: 'metal', ...spec });

export const INSTRUMENTS: Record<string, Instrument> = Object.fromEntries(
  [
    fx('USD', 'ABD Doları', major),
    fx('EUR', 'Euro', major),
    fx('GBP', 'İngiliz Sterlini', pound),
    fx('CHF', 'İsviçre Frangı', pound),
    fx('JPY', 'Japon Yeni', {
      ...major,
      decimals: 0,
      bipSize: '0.0001',
      minQty: '100',
      lot: { min: '20000', max: '500000', step: '10000' },
      ladder: ['500000', '1000000', '2000000'],
      maxDeal: '30000000',
      position: '15000000',
      clip: '5000000',
    }),
    fx('CAD', 'Kanada Doları', dollarBloc),
    fx('AUD', 'Avustralya Doları', dollarBloc),
    fx('SAR', 'Suudi Arabistan Riyali', small),
    fx('AED', 'BAE Dirhemi', small),
    fx('QAR', 'Katar Riyali', small),
    fx('KWD', 'Kuveyt Dinarı', {
      ...major,
      bipSize: '0.05',
      lot: { min: '50', max: '800', step: '10' },
      ladder: ['1000', '2000', '5000'],
      maxDeal: '30000',
      position: '15000',
      clip: '7500',
    }),
    fx('DKK', 'Danimarka Kronu', small),
    fx('SEK', 'İsveç Kronu', small),
    fx('NOK', 'Norveç Kronu', small),
    fx('CNY', 'Çin Yuanı', small),
    metal('XAU', 'Altın (gram)', {
      decimals: 2,
      tickSize: '0.01',
      bipSize: '1',
      minQty: '0.1',
      lot: { min: '5', max: '150', step: '5' },
      ladder: ['250', '500', '1000'],
      maxDeal: '5000',
      position: '2000',
      clip: '1000',
    }),
    metal('XAG', 'Gümüş (gram)', {
      ...major,
      lot: { min: '200', max: '5000', step: '100' },
      ladder: ['10000', '20000', '40000'],
      maxDeal: '500000',
      position: '200000',
      clip: '100000',
    }),
    metal('XPT', 'Platin (gram)', {
      decimals: 2,
      tickSize: '0.01',
      bipSize: '0.5',
      minQty: '0.1',
      lot: { min: '5', max: '100', step: '5' },
      ladder: ['100', '250', '500'],
      maxDeal: '2000',
      position: '1000',
      clip: '500',
    }),
  ].map((i) => [i.code, i]),
);

const METALS = new Set(['XAU', 'XAG', 'XPT', 'XPD']);

/** Rounds to one significant digit: 3456 → 3000, 0.0026 → 0.003. */
const nice = (v: number) => {
  const p = 10 ** Math.floor(Math.log10(v));
  return Math.max(1, Math.round(v / p)) * p;
};
const pow10 = (v: number) => 10 ** Math.round(Math.log10(v));
/** Plain decimal string (no exponent), at most 8 decimals. */
const dec = (v: number) => v.toFixed(8).replace(/\.?0+$/, '');

/** Catalog entry, or defaults derived from the rate (a bip ≈ 2 basis points of the price, lots ≈ 10–150 k TRY). */
export function instrument(code: string, rate?: number): Instrument {
  const known = INSTRUMENTS[code];
  if (known) return known;
  const r = rate && rate > 0 ? rate : 1;
  const units = (tl: number) => dec(nice(tl / r));
  return {
    code,
    name: code,
    kind: METALS.has(code) ? 'metal' : 'fx',
    decimals: 2,
    tickSize: dec(Math.max(0.0001, pow10(r * 2e-6))),
    bipSize: dec(Math.max(0.0001, pow10(r * 2e-4))),
    minQty: '1',
    lot: { min: units(10_000), max: units(150_000), step: dec(Math.max(0.01, pow10(2_000 / r))) },
    ladder: [units(250_000), units(500_000), units(1_000_000)],
    maxDeal: units(12_000_000),
    position: units(5_000_000),
    clip: units(2_500_000),
  };
}

export const instrumentName = (code: string) => INSTRUMENTS[code]?.name ?? code;

/** A pair against TRY with the instrument's defaults: 5 bips of commission per side, a 3 % price band. */
export function pairFor(code: string, opts: { enabled?: boolean; rate?: number; quote?: string } = {}): PairConfig {
  const i = instrument(code, opts.rate);
  const quote = opts.quote ?? 'TRY';
  return {
    symbol: `${code}${quote}`,
    base: code,
    quote,
    baseDecimals: i.decimals,
    quoteDecimals: 2,
    tickSize: i.tickSize,
    minQty: i.minQty,
    priceBandPct: '3',
    commission: { buyBips: 5, sellBips: 5 },
    bipSize: i.bipSize,
    enabled: opts.enabled ?? true,
  };
}

const ladderOf = (levels: string[]) => ({ enabled: true, startPct: '0.02', stepPct: '0.02', levels });

/**
 * The configuration with one more pair: the pair itself (closed for trading unless `enabled`), and the
 * instrument's defaults for every per-currency parameter that has none yet (deal size, position limit, hedge
 * clip, bot lots, the bank's ladder).
 */
export function withPair(config: BankConfig, code: string, opts: { enabled?: boolean; rate?: number } = {}): BankConfig {
  const pair = pairFor(code, opts);
  if (config.pairs.some((p) => p.symbol === pair.symbol)) return config;
  const i = instrument(code, opts.rate);
  const keep = <T>(record: Record<string, T>, value: T) => (code in record ? record : { ...record, [code]: value });
  return {
    ...config,
    pairs: [...config.pairs, pair],
    dealing: {
      ...config.dealing,
      maxDealQty: keep(config.dealing.maxDealQty, i.maxDeal),
      positionLimits: keep(config.dealing.positionLimits, i.position),
      hedging: { ...config.dealing.hedging, maxClipQty: keep(config.dealing.hedging.maxClipQty, i.clip) },
    },
    bots: { ...config.bots, lots: keep(config.bots.lots, i.lot) },
    bankBook: {
      ...config.bankBook,
      pairs: pair.symbol in config.bankBook.pairs ? config.bankBook.pairs : { ...config.bankBook.pairs, [pair.symbol]: { asks: ladderOf(i.ladder), bids: ladderOf(i.ladder) } },
    },
  };
}
