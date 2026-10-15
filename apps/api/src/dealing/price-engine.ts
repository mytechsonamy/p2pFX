import { findPair, formatPrice, isLpMarketOpen, isMetal, lpDisabled, nextLpMarketOpen, parsePrice, type BankConfig, type PairConfig } from '@p2p/shared';
import type { LiquidityAdapter, LpQuote } from '@p2p/core-adapter';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/pool.js';
import type { ConfigService } from '../config-service.js';
import type { EventBus, PriceOffReason } from '../events.js';
import { ApiError } from '../errors.js';

/** Best LP prices for a pair, PRICE_SCALE units. */
export interface Aggregate {
  pair: string;
  bid: bigint;
  ask: bigint;
  bidLp: string;
  askLp: string;
  quotes: LpQuote[];
  /** When the aggregate was built (display, streaming). Not a measure of freshness. */
  at: Date;
  /** The LP timestamp of the older of the two quotes behind bid and ask: freshness is measured from this. */
  sourceAt: Date;
  /**
   * Set while the LP market is closed: the price is the last LP price before the close, widened (`dealing.offHours`).
   * It has no LP quotes, so nothing hedges on it.
   */
  offHours?: { closeAt: Date; nextOpen?: Date };
  /** LPs left out of this aggregate by the price sanity check (mid too far from the other LPs' median). */
  excludedLps?: string[];
}

/** Reads the core banking reference rate of a pair (PRICE_SCALE units) and its time, or undefined when it has none. */
export type ReferenceRateSource = (pair: string) => Promise<{ rate: bigint; asOf?: Date } | undefined>;

interface ReferenceState {
  rate?: bigint;
  /** The rate's own time (asOf), else when it was read. */
  at?: number;
  /** No new read before this (one read per REFERENCE_TTL_MS, failures included). */
  nextTryAt: number;
  inflight?: Promise<void>;
  /** A failure is logged once per outage. */
  failing?: boolean;
  offLoggedAt?: number;
}

export interface SegmentRates {
  /** The customer buys from the bank at this rate. */
  buy: bigint;
  /** The customer sells to the bank at this rate. */
  sell: bigint;
  buyPips: number;
  sellPips: number;
}

/** The LP name an off-hours price carries (no LP stands behind it). */
export const OFF_HOURS_LP = 'CLOSE';

/** How often a price tick is written to the history. */
const TICK_EVERY_MS = 5000;
/** Clock skew tolerated on an LP quote's timestamp. */
const FUTURE_TOLERANCE_MS = 2000;
/** How long a core banking reference rate is reused before it is read again. */
const REFERENCE_TTL_MS = 60_000;
/** An asOf this far ahead of the local clock is taken as clock skew. */
const REFERENCE_SKEW_MS = 5 * 60_000;
/** How long the price engine waits for the reference rate before going on with the one it has. */
const REFERENCE_TIMEOUT_MS = 500;
/** The jump check compares with the last accepted price only while it is this recent (else any level is accepted). */
const JUMP_WINDOW_MS = 60_000;
/** An excluded LP is logged at most this often per pair. */
const EXCLUDE_LOG_EVERY_MS = 30_000;

/**
 * Price module: pulls quotes from the liquidity providers, drops stale ones, keeps the best bid and ask
 * across LPs, streams them and samples them into the price history. Segment rates add the bank's margin.
 */
export class PriceEngine {
  private readonly latest = new Map<string, Aggregate>();
  private readonly lastTick = new Map<string, number>();
  /** Pairs announced as without a bank price, so 'lpOff' goes out once per outage. */
  private readonly off = new Map<string, { reason: PriceOffReason; nextOpen?: Date }>();
  /** The last LP price per pair (raw, before any widening): the close price the bank quotes from while closed. */
  private readonly lastLp = new Map<string, { bid: bigint; ask: bigint; at: Date }>();
  private readonly reopenListeners: ((pair: string) => void)[] = [];
  /** Core banking reference rates, read at most once a minute per pair. */
  private readonly reference = new Map<string, ReferenceState>();
  /** A price that jumped past maxJumpBps, waiting to hold for jumpConfirmMs before it becomes the new level. */
  private readonly pendingJump = new Map<string, { mid: bigint; since: number }>();
  private readonly excludeLogged = new Map<string, number>();
  /** Refreshes are numbered as they start; the number of the last one whose price was taken, per pair. */
  private refreshSeq = 0;
  private readonly applied = new Map<string, number>();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: Db,
    private readonly lp: LiquidityAdapter,
    private readonly config: ConfigService,
    private readonly events: EventBus,
    private readonly clock: () => Date,
    private readonly log: FastifyBaseLogger,
    private readonly referenceRate?: ReferenceRateSource,
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
    // LP prices feed Direct, the ladder, the bot, market order protection and price evidence: always refreshed.
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
    const now = this.clock();
    // Outside the LP market's hours LP prices are at best indicative: no bank price, and the customer is told when it opens.
    const kind = isMetal(findPair(c, pair)?.base ?? pair.slice(0, 3)) ? 'metal' : 'fx';
    if (!isLpMarketOpen(now, c.dealing.lpMarket, kind)) {
      const known = this.off.get(pair);
      const cached = this.latest.get(pair)?.offHours?.nextOpen ?? (known?.reason === 'MARKET_CLOSED' ? known.nextOpen : undefined);
      const nextOpen = cached && cached > now ? cached : nextLpMarketOpen(now, c.dealing.lpMarket, kind);
      const close = c.dealing.offHours.enabled ? await this.closePrice(pair) : undefined;
      if (!close || now.getTime() - close.at.getTime() > c.dealing.offHours.maxCloseAgeHours * 3_600_000) {
        return this.unavailable(pair, 'MARKET_CLOSED', `the ${pair} market is closed`, nextOpen);
      }
      // The close price widened by extraSpreadBps of its mid on each side; the segment margin comes on top as usual.
      const widen = (((close.bid + close.ask) / 2n) * BigInt(Math.round(c.dealing.offHours.extraSpreadBps * 100))) / 1_000_000n;
      const agg: Aggregate = {
        pair,
        bid: close.bid - widen,
        ask: close.ask + widen,
        bidLp: OFF_HOURS_LP,
        askLp: OFF_HOURS_LP,
        quotes: [],
        at: now,
        sourceAt: now,
        offHours: { closeAt: close.at, nextOpen },
      };
      this.latest.set(pair, agg);
      this.off.delete(pair);
      await this.events.publish({
        type: 'lp',
        pair,
        bid: formatPrice(agg.bid),
        ask: formatPrice(agg.ask),
        at: now.toISOString(),
        offHours: { nextOpen: nextOpen?.toISOString() },
      });
      return agg;
    }
    const seq = ++this.refreshSeq;
    // An LP operations switched off (kill switch) is ignored entirely.
    let all: LpQuote[];
    try {
      all = await this.lp.quotes(pair);
    } catch (err) {
      this.log.warn({ err, pair }, 'LP quotes failed');
      return this.fail(pair, seq, 'NO_PRICE', `no LP price for ${pair}`);
    }
    const quotes = all.filter((q) => !lpDisabled(c.killSwitch.disabledLps, q.lp));
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
    if (!fresh.length) return this.fail(pair, seq, 'NO_PRICE', `no live LP price for ${pair}`);
    const sanity = c.dealing.priceSanity;
    // Outliers: with three or more LPs, one whose mid is far from the median is a bad feed, not the market.
    const { kept: usable, excluded } = sanity.enabled ? dropOutliers(fresh, sanity.maxLpDeviationBps) : { kept: fresh, excluded: [] };
    if (excluded.length) this.logExcluded(pair, excluded, now);
    // No majority agrees (e.g. two LPs against two): there is no telling which side is right.
    if (excluded.length && usable.length * 2 <= fresh.length) {
      return this.fail(pair, seq, 'PRICE_SUSPECT', `${pair} LPs disagree: ${excluded.length} of ${fresh.length} are far from the median`);
    }
    const best = (pick: (a: LpQuote, b: LpQuote) => boolean) => usable.reduce((a, b) => (pick(a, b) ? a : b));
    const bidQ = best((a, b) => parsePrice(a.bid) >= parsePrice(b.bid));
    const askQ = best((a, b) => parsePrice(a.ask) <= parsePrice(b.ask));
    const sourceAt = new Date(Math.min(new Date(bidQ.at).getTime(), new Date(askQ.at).getTime()));
    const agg: Aggregate = {
      pair,
      bid: parsePrice(bidQ.bid),
      ask: parsePrice(askQ.ask),
      bidLp: bidQ.lp,
      askLp: askQ.lp,
      quotes: usable,
      at: now,
      sourceAt,
      ...(excluded.length ? { excludedLps: excluded.map((q) => q.lp) } : {}),
    };
    // Spread guard: a crossed best price (one LP's bid above another's ask) or a spread wider than the limit is a
    // market the bank does not quote into; the bank's price comes back when the LPs narrow again.
    const limitBps = findPair(c, pair)?.maxSpreadBps ?? c.dealing.maxSpreadBps;
    const spreadBps = spreadInBps(agg.bid, agg.ask);
    if (agg.bid > agg.ask || spreadBps > limitBps) {
      this.log.warn({ pair, bid: formatPrice(agg.bid), ask: formatPrice(agg.ask), bidLp: agg.bidLp, askLp: agg.askLp, spreadBps, limitBps }, 'spread guard: no bank price');
      return this.fail(pair, seq, 'WIDE_MARKET', `${pair} spread ${spreadBps.toFixed(1)} bps is beyond the limit ${limitBps} bps`);
    }
    if (sanity.enabled) {
      const mid = (agg.bid + agg.ask) / 2n;
      // Against core banking's own rate: a feed that drifts away (all LPs together, or the only LP) is not quoted.
      const ref = await this.referenceFor(pair, now, sanity.referenceMaxAgeMinutes * 60_000);
      // The read may have been awaited: a refresh that started later has decided meanwhile.
      if ((this.applied.get(pair) ?? 0) > seq) return this.superseded(pair);
      if (ref !== undefined) {
        const off = deviationBps(mid, ref);
        if (off > sanity.maxReferenceDeviationBps) {
          this.log.warn({ pair, mid: formatPrice(mid), reference: formatPrice(ref), deviationBps: off, limitBps: sanity.maxReferenceDeviationBps }, 'price sanity: LP price too far from the reference rate');
          return this.fail(pair, seq, 'PRICE_SUSPECT', `${pair} LP price is ${off.toFixed(1)} bps from the reference rate (limit ${sanity.maxReferenceDeviationBps} bps)`);
        }
      }
      // Against the last accepted price: a jump is held back until the new level has held for jumpConfirmMs.
      const last = this.lastLp.get(pair);
      if (last && now.getTime() - last.at.getTime() <= JUMP_WINDOW_MS) {
        const jump = deviationBps(mid, (last.bid + last.ask) / 2n);
        if (jump > sanity.maxJumpBps) {
          const pending = this.pendingJump.get(pair);
          const holding = pending && deviationBps(mid, pending.mid) <= sanity.maxJumpBps;
          if (!holding) this.pendingJump.set(pair, { mid, since: now.getTime() });
          if (!holding || now.getTime() - pending.since < sanity.jumpConfirmMs) {
            if (!holding) this.log.warn({ pair, mid: formatPrice(mid), last: formatPrice((last.bid + last.ask) / 2n), jumpBps: jump, limitBps: sanity.maxJumpBps }, 'price sanity: price jump held back');
            return this.fail(pair, seq, 'PRICE_JUMP', `${pair} LP price moved ${jump.toFixed(1)} bps (limit ${sanity.maxJumpBps} bps); waiting for it to hold`);
          }
          this.log.info({ pair, mid: formatPrice(mid), jumpBps: jump }, 'price sanity: jumped price held, accepted as the new level');
        }
      }
      this.pendingJump.delete(pair);
    }
    // A slower refresh that started earlier must not replace the outcome of one that started later (refreshes of a
    // pair can overlap): neither its price nor the absence of one.
    if ((this.applied.get(pair) ?? 0) > seq) return this.superseded(pair);
    this.applied.set(pair, seq);
    const reopened = !!this.latest.get(pair)?.offHours;
    this.latest.set(pair, agg);
    this.lastLp.set(pair, { bid: agg.bid, ask: agg.ask, at: sourceAt });
    if (reopened) for (const fn of this.reopenListeners) fn(pair);
    this.off.delete(pair);
    await this.events.publish({ type: 'lp', pair, bid: formatPrice(agg.bid), ask: formatPrice(agg.ask), at: now.toISOString() });
    if (now.getTime() - (this.lastTick.get(pair) ?? 0) >= TICK_EVERY_MS) {
      this.lastTick.set(pair, now.getTime());
      await this.db.query('insert into price_ticks (pair, bid, ask, at) values ($1, $2, $3, $4)', [pair, formatPrice(agg.bid), formatPrice(agg.ask), now]);
    }
    return agg;
  }

  /**
   * The last raw LP price before the close: from memory, or after a restart the last sampled tick (ticks hold only raw
   * LP prices, never off-hours ones).
   */
  private async closePrice(pair: string) {
    const known = this.lastLp.get(pair);
    if (known) return known;
    const { rows } = await this.db.query('select bid, ask, at from price_ticks where pair = $1 order by at desc limit 1', [pair]);
    if (!rows.length) return undefined;
    const close = { bid: parsePrice(String(rows[0].bid)), ask: parsePrice(String(rows[0].ask)), at: new Date(rows[0].at) };
    this.lastLp.set(pair, close);
    return close;
  }

  /**
   * The core banking reference rate for the sanity check. Read at most once per REFERENCE_TTL_MS per pair (a failure
   * waits as long as a success), one read in flight per pair, waited on for at most REFERENCE_TIMEOUT_MS and only by
   * the refresh that started it; the last good rate is kept through failures. Undefined (no rate, or older than maxAgeMs by its own time) skips the check.
   */
  private async referenceFor(pair: string, now: Date, maxAgeMs: number): Promise<bigint | undefined> {
    if (!this.referenceRate) return undefined;
    let st = this.reference.get(pair);
    if (!st) this.reference.set(pair, (st = { nextTryAt: 0 }));
    const state = st;
    let started = false;
    if (now.getTime() >= state.nextTryAt && !state.inflight) {
      started = true;
      state.nextTryAt = now.getTime() + REFERENCE_TTL_MS;
      const readAt = now.getTime();
      state.inflight = this.referenceRate(pair)
        .then(
          (r) => {
            state.rate = r?.rate;
            // A rate stamped in the future (clock skew) is aged from when it was read.
            const asOf = r?.asOf?.getTime();
            state.at = r ? (asOf !== undefined && asOf <= readAt + REFERENCE_SKEW_MS ? asOf : readAt) : undefined;
            state.failing = false;
          },
          (err) => {
            if (!state.failing) this.log.warn({ err, pair }, 'price sanity: reference rate not available; the last one is used while it is recent');
            state.failing = true;
          },
        )
        .finally(() => (state.inflight = undefined));
    }
    // Only the refresh that started the read waits for it (briefly); the others go on with the rate they have.
    if (started && state.inflight) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([state.inflight, new Promise<void>((resolve) => (timer = setTimeout(resolve, REFERENCE_TIMEOUT_MS)))]);
      clearTimeout(timer);
    }
    if (state.rate === undefined || state.at === undefined) return undefined;
    if (now.getTime() - state.at <= maxAgeMs) return state.rate;
    // Too old to compare with: the check is off for the pair. Said once an hour, so a stale core rate is noticed.
    if (now.getTime() - (state.offLoggedAt ?? 0) >= 3_600_000) {
      state.offLoggedAt = now.getTime();
      this.log.warn({ pair, referenceAt: new Date(state.at).toISOString(), maxAgeMs }, 'price sanity: reference rate too old, reference check is off for the pair');
    }
    return undefined;
  }

  private logExcluded(pair: string, excluded: LpQuote[], now: Date) {
    const key = `${pair}:${excluded.map((q) => q.lp).join(',')}`;
    if (now.getTime() - (this.excludeLogged.get(key) ?? 0) < EXCLUDE_LOG_EVERY_MS) return;
    this.excludeLogged.set(key, now.getTime());
    this.log.warn({ pair, lps: excluded.map((q) => ({ lp: q.lp, bid: q.bid, ask: q.ask })) }, 'price sanity: LP left out, its price is far from the other LPs');
  }

  /** Called with the pair when the LP market opens after an off-hours period (the position can be hedged again). */
  onReopen(fn: (pair: string) => void) {
    this.reopenListeners.push(fn);
  }

  /** Whether the pair's current bank price is an off-hours one (LP market closed). */
  isOffHours(pair: string): boolean {
    return !!this.latest.get(pair)?.offHours;
  }

  /** Fails this refresh as unavailable, unless a refresh that started later has already decided the pair's state. */
  private async fail(pair: string, seq: number, reason: PriceOffReason, message: string): Promise<Aggregate> {
    if ((this.applied.get(pair) ?? 0) > seq) return this.superseded(pair);
    this.applied.set(pair, seq);
    return this.unavailable(pair, reason, message);
  }

  /** The outcome a later refresh decided: its price, or the reason there is none. */
  private superseded(pair: string): Aggregate {
    const a = this.latest.get(pair);
    if (a) return a;
    const o = this.off.get(pair);
    throw new ApiError(503, 'PRICE_UNAVAILABLE', `no bank price for ${pair}`, o && { reason: o.reason, ...(o.nextOpen ? { nextOpen: o.nextOpen.toISOString() } : {}) });
  }

  /** Drops the pair's price so nothing trades on it, tells the stream once, and fails the refresh. */
  private async unavailable(pair: string, reason: PriceOffReason, message: string, nextOpen?: Date): Promise<never> {
    this.latest.delete(pair);
    // A jump waiting for confirmation must hold through consecutive prices: any other outage starts it over.
    if (reason !== 'PRICE_JUMP') this.pendingJump.delete(pair);
    const known = this.off.get(pair);
    if (known?.reason !== reason || known.nextOpen?.getTime() !== nextOpen?.getTime()) {
      this.off.set(pair, { reason, nextOpen });
      await this.events
        .publish({ type: 'lpOff', pair, reason, nextOpen: nextOpen?.toISOString() })
        .catch((err) => this.log.warn({ err, pair }, 'lpOff not published'));
    }
    throw new ApiError(503, 'PRICE_UNAVAILABLE', message, { reason, ...(nextOpen ? { nextOpen: nextOpen.toISOString() } : {}) });
  }

  /** Why the pair has no bank price right now (and when its market opens, if closed), if it has none. */
  offState(pair: string): { reason: PriceOffReason; nextOpen?: string } | undefined {
    const o = this.off.get(pair);
    return o && { reason: o.reason, ...(o.nextOpen ? { nextOpen: o.nextOpen.toISOString() } : {}) };
  }

  /**
   * The latest aggregate if it was built in the last second and its LP quotes are still within the staleness limit,
   * otherwise a new one.
   */
  async current(pair: string): Promise<Aggregate> {
    const a = this.latest.get(pair);
    const maxAge = Math.min(1000, this.config.get().data.dealing.maxStalenessMs);
    if (a && this.clock().getTime() - a.at.getTime() <= maxAge && this.live(a)) return a;
    return this.refresh(pair);
  }

  /** The latest aggregate whatever its age (display only: dealer screen marks, P&L). */
  cached(pair: string): Aggregate | undefined {
    return this.latest.get(pair);
  }

  /**
   * The latest aggregate only while the LP quotes behind it are within the staleness limit, measured from the LPs' own
   * timestamps (refreshing the cache does not make an old quote younger). Anything that trades must use this or
   * current().
   */
  fresh(pair: string): Aggregate | undefined {
    const a = this.latest.get(pair);
    return a && this.live(a) ? a : undefined;
  }

  /**
   * Whether an aggregate may still be traded on: its LP quotes are within the staleness limit and neither LP behind
   * its bid or ask has been switched off since it was built (the kill switch is checked against the configuration of
   * the moment, not the one of the refresh).
   */
  private live(a: Aggregate): boolean {
    const c = this.config.get().data;
    if (lpDisabled(c.killSwitch.disabledLps, a.bidLp) || lpDisabled(c.killSwitch.disabledLps, a.askLp)) return false;
    return this.clock().getTime() - a.sourceAt.getTime() <= c.dealing.maxStalenessMs;
  }

  /** Whether one LP's quote may still be traded on now: the LP is switched on and its own quote is fresh. */
  quoteFresh(q: LpQuote): boolean {
    const c = this.config.get().data;
    if (lpDisabled(c.killSwitch.disabledLps, q.lp)) return false;
    return this.clock().getTime() - new Date(q.at).getTime() <= c.dealing.maxStalenessMs;
  }
}

/** |a − b| in basis points of b. */
export function deviationBps(a: bigint, b: bigint): number {
  if (b <= 0n) return Infinity;
  const d = a > b ? a - b : b - a;
  return Number((d * 1_000_000n) / b) / 100;
}

/**
 * Splits fresh LP quotes into the ones that agree with the market and the outliers: with three or more quotes, a quote
 * whose mid is more than maxBps from the median mid is an outlier. With one or two quotes nothing is dropped (there is
 * no majority to tell which one is wrong; the spread guard and the reference check cover that case).
 */
export function dropOutliers(quotes: LpQuote[], maxBps: number): { kept: LpQuote[]; excluded: LpQuote[] } {
  if (quotes.length < 3) return { kept: quotes, excluded: [] };
  const mid = (q: LpQuote) => (parsePrice(q.bid) + parsePrice(q.ask)) / 2n;
  const mids = quotes.map(mid).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const n = mids.length;
  const median = n % 2 ? mids[(n - 1) / 2]! : (mids[n / 2 - 1]! + mids[n / 2]!) / 2n;
  const kept: LpQuote[] = [];
  const excluded: LpQuote[] = [];
  for (const q of quotes) (deviationBps(mid(q), median) > maxBps ? excluded : kept).push(q);
  return { kept, excluded };
}

/** (ask − bid) in basis points of the mid; negative when crossed. */
export function spreadInBps(bid: bigint, ask: bigint): number {
  const mid = (bid + ask) / 2n;
  if (mid <= 0n) return Infinity;
  return Number(((ask - bid) * 1_000_000n) / mid) / 100;
}

interface PairPricing {
  pip: bigint;
  tick: bigint;
  /** Margin in price units per segment, and for segments without their own margin. */
  segments: Map<string, { buy: bigint; sell: bigint; buyPips: number; sellPips: number }>;
  fallback: { buy: bigint; sell: bigint; buyPips: number; sellPips: number };
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
    const pip = parsePrice(pair.pipSize);
    const margin = (m: { buyPips: number; sellPips: number }) => ({ buy: BigInt(m.buyPips) * pip, sell: BigInt(m.sellPips) * pip, ...m });
    table.set(pair.symbol, {
      pip,
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
  return { buy: up(agg.ask + m.buy), sell: down(agg.bid - m.sell), buyPips: m.buyPips, sellPips: m.sellPips };
}

export function ratesView(
  config: BankConfig,
  pairSymbol: string,
  agg: { bid: bigint; ask: bigint; at: Date | string; offHours?: { nextOpen?: Date | string } },
  segment: string,
) {
  const pair = findPair(config, pairSymbol);
  if (!pair) return undefined;
  const r = segmentRates(config, pair, agg, segment);
  const iso = (d: Date | string) => (typeof d === 'string' ? d : d.toISOString());
  return {
    pair: pairSymbol,
    buy: formatPrice(r.buy),
    sell: formatPrice(r.sell),
    at: iso(agg.at),
    // While the LP market is closed the price comes from the close, widened; the app says so and when it opens.
    ...(agg.offHours ? { offHours: { ...(agg.offHours.nextOpen ? { nextOpen: iso(agg.offHours.nextOpen) } : {}) } } : {}),
  };
}
