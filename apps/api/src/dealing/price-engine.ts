import { findPair, formatPrice, parsePrice, type BankConfig, type PairConfig } from '@p2p/shared';
import type { LiquidityAdapter, LpQuote } from '@p2p/core-adapter';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/pool.js';
import type { ConfigService } from '../config-service.js';
import type { EventBus } from '../events.js';
import { ApiError } from '../errors.js';

/** Best LP prices for a pair, PRICE_SCALE units. */
export interface Aggregate {
  pair: string;
  bid: bigint;
  ask: bigint;
  bidLp: string;
  askLp: string;
  quotes: LpQuote[];
  at: Date;
}

export interface SegmentRates {
  /** The customer buys from the bank at this rate. */
  buy: bigint;
  /** The customer sells to the bank at this rate. */
  sell: bigint;
  buyBips: number;
  sellBips: number;
}

/** How often a price tick is written to the history. */
const TICK_EVERY_MS = 5000;
/** Clock skew tolerated on an LP quote's timestamp. */
const FUTURE_TOLERANCE_MS = 2000;

/**
 * Price module: pulls quotes from the liquidity providers, drops stale ones, keeps the best bid and ask
 * across LPs, streams them and samples them into the price history. Segment rates add the bank's margin.
 */
export class PriceEngine {
  private readonly latest = new Map<string, Aggregate>();
  private readonly lastTick = new Map<string, number>();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: Db,
    private readonly lp: LiquidityAdapter,
    private readonly config: ConfigService,
    private readonly events: EventBus,
    private readonly clock: () => Date,
    private readonly log: FastifyBaseLogger,
  ) {}

  start(intervalMs: number) {
    let running = false;
    this.timer = setInterval(() => {
      if (running) return;
      running = true;
      this.refreshAll()
        .catch((err) => this.log.warn({ err }, 'price refresh failed'))
        .finally(() => (running = false));
    }, intervalMs);
  }

  stop() {
    clearInterval(this.timer);
  }

  async refreshAll() {
    const c = this.config.get().data;
    if (!c.dealing.enabled) return;
    for (const p of c.pairs.filter((p) => p.enabled)) {
      try {
        await this.refresh(p.symbol);
      } catch (err) {
        this.log.warn({ err, pair: p.symbol }, 'no LP price');
      }
    }
  }

  /** Pulls fresh LP quotes for a pair and publishes the aggregate. */
  async refresh(pair: string): Promise<Aggregate> {
    const c = this.config.get().data;
    const quotes = await this.lp.quotes(pair);
    const now = this.clock();
    // Only sane, recent quotes: positive prices, bid below ask, not stamped in the future, within the staleness limit.
    const fresh = quotes.filter((q) => {
      const age = now.getTime() - new Date(q.at).getTime();
      if (!(age <= c.dealing.maxStalenessMs) || age < -FUTURE_TOLERANCE_MS) return false;
      try {
        const bid = parsePrice(q.bid);
        const ask = parsePrice(q.ask);
        return bid > 0n && ask > 0n && bid <= ask;
      } catch {
        return false;
      }
    });
    if (!fresh.length) throw new ApiError(503, 'PRICE_UNAVAILABLE', `no live LP price for ${pair}`);
    const best = (pick: (a: LpQuote, b: LpQuote) => boolean) => fresh.reduce((a, b) => (pick(a, b) ? a : b));
    const bidQ = best((a, b) => parsePrice(a.bid) >= parsePrice(b.bid));
    const askQ = best((a, b) => parsePrice(a.ask) <= parsePrice(b.ask));
    const agg: Aggregate = { pair, bid: parsePrice(bidQ.bid), ask: parsePrice(askQ.ask), bidLp: bidQ.lp, askLp: askQ.lp, quotes: fresh, at: now };
    this.latest.set(pair, agg);
    await this.events.publish({ type: 'lp', pair, bid: formatPrice(agg.bid), ask: formatPrice(agg.ask), at: now.toISOString() });
    if (now.getTime() - (this.lastTick.get(pair) ?? 0) >= TICK_EVERY_MS) {
      this.lastTick.set(pair, now.getTime());
      await this.db.query('insert into price_ticks (pair, bid, ask, at) values ($1, $2, $3, $4)', [pair, formatPrice(agg.bid), formatPrice(agg.ask), now]);
    }
    return agg;
  }

  /** The latest aggregate if still fresh, otherwise a new one. */
  async current(pair: string): Promise<Aggregate> {
    const a = this.latest.get(pair);
    const maxAge = Math.min(1000, this.config.get().data.dealing.maxStalenessMs);
    if (a && this.clock().getTime() - a.at.getTime() <= maxAge) return a;
    return this.refresh(pair);
  }

  /** The latest aggregate whatever its age (display only: dealer screen marks, P&L). */
  cached(pair: string): Aggregate | undefined {
    return this.latest.get(pair);
  }

  /** The latest aggregate only while it is within the staleness limit; anything that trades must use this or current(). */
  fresh(pair: string): Aggregate | undefined {
    const a = this.latest.get(pair);
    if (!a) return undefined;
    return this.clock().getTime() - a.at.getTime() <= this.config.get().data.dealing.maxStalenessMs ? a : undefined;
  }
}

interface PairPricing {
  bip: bigint;
  tick: bigint;
  /** Margin in price units per segment, and for segments without their own margin. */
  segments: Map<string, { buy: bigint; sell: bigint; buyBips: number; sellBips: number }>;
  fallback: { buy: bigint; sell: bigint; buyBips: number; sellBips: number };
}

/**
 * Segment pricing compiled once per configuration version. LPs tick several times a second per pair and
 * every tick is priced for every connected customer, so the hot path is a map lookup and two additions.
 * A back office change produces a new configuration object, which compiles a fresh table on first use.
 */
const compiled = new WeakMap<BankConfig, Map<string, PairPricing>>();

function pricingTable(config: BankConfig): Map<string, PairPricing> {
  let table = compiled.get(config);
  if (table) return table;
  table = new Map();
  for (const pair of config.pairs) {
    const bip = parsePrice(pair.bipSize);
    const margin = (m: { buyBips: number; sellBips: number }) => ({ buy: BigInt(m.buyBips) * bip, sell: BigInt(m.sellBips) * bip, ...m });
    table.set(pair.symbol, {
      bip,
      tick: parsePrice(pair.tickSize),
      segments: new Map(Object.entries(config.dealing.margins.segments).map(([s, m]) => [s, margin(m)])),
      fallback: margin(config.dealing.margins.default),
    });
  }
  compiled.set(config, table);
  return table;
}

/**
 * Bank rates for a segment: ask + buy margin and bid − sell margin, rounded to the pair's tick in the
 * bank's favour.
 */
export function segmentRates(config: BankConfig, pair: PairConfig, agg: { bid: bigint; ask: bigint }, segment: string): SegmentRates {
  const p = pricingTable(config).get(pair.symbol);
  if (!p) throw new ApiError(404, 'NOT_FOUND', `pair ${pair.symbol} not found`);
  const m = p.segments.get(segment) ?? p.fallback;
  const tick = p.tick;
  const up = (v: bigint) => ((v + tick - 1n) / tick) * tick;
  const down = (v: bigint) => (v / tick) * tick;
  return { buy: up(agg.ask + m.buy), sell: down(agg.bid - m.sell), buyBips: m.buyBips, sellBips: m.sellBips };
}

export function ratesView(config: BankConfig, pairSymbol: string, agg: { bid: bigint; ask: bigint; at: Date | string }, segment: string) {
  const pair = findPair(config, pairSymbol);
  if (!pair) return undefined;
  const r = segmentRates(config, pair, agg, segment);
  return { pair: pairSymbol, buy: formatPrice(r.buy), sell: formatPrice(r.sell), at: typeof agg.at === 'string' ? agg.at : agg.at.toISOString() };
}
