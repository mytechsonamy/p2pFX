import { PRICE_SCALE, divRound, formatDecimal, formatPrice, parseDecimal, parsePrice } from '@p2p/shared';
import {
  beyondLimit,
  LiquidityError,
  LiquidityOutcomeUnknownError,
  type FindExecutionOptions,
  type LiquidityAdapter,
  type LpExecution,
  type LpExecutionRequest,
  type LpQuote,
} from './liquidity.js';

/** Grams in a troy ounce: LPs quote metals per ounce, the bank's pairs are per gram. */
export const GRAMS_PER_OUNCE = '31.1034768';

/** The vehicle currency: interbank liquidity in TRY is USDTRY, everything else is quoted against the dollar. */
const VEHICLE = 'USD';
/** Currencies and metals quoted as XXX/USD in the interbank market; the rest are USD/XXX. */
const QUOTED_IN_USD = new Set(['EUR', 'GBP', 'AUD', 'NZD', 'XAU', 'XAG', 'XPT', 'XPD']);
const METALS = new Set(['XAU', 'XAG', 'XPT', 'XPD']);

/**
 * A pair the bank offers (e.g. XAUTRY per gram, CHFTRY) built from two pairs the LPs quote: the base against
 * the dollar (`cross`: XAUUSD per ounce, USDCHF) and the dollar against the quote currency (`funding`: USDTRY).
 */
export interface SyntheticRoute {
  pair: string;
  cross: string;
  /** true when the cross is USD/base (USDCHF): the synthetic rate is funding ÷ cross. */
  inverted: boolean;
  funding: string;
  /** Bank units per cross unit: grams per ounce for metals, 1 for currencies. */
  unit: bigint;
  /** Decimals sent to the LP for the cross quantity (ounces or dollars). */
  crossDecimals: number;
}

export function syntheticRoute(pair: string): SyntheticRoute | undefined {
  if (pair.length !== 6) return undefined;
  const base = pair.slice(0, 3);
  const quote = pair.slice(3);
  if (base === VEHICLE || quote === VEHICLE || base === quote) return undefined;
  const inverted = !QUOTED_IN_USD.has(base);
  const metal = METALS.has(base);
  return {
    pair,
    cross: inverted ? `${VEHICLE}${base}` : `${base}${VEHICLE}`,
    inverted,
    funding: `${VEHICLE}${quote}`,
    unit: parsePrice(metal ? GRAMS_PER_OUNCE : '1'),
    crossDecimals: metal ? 3 : 2,
  };
}

/** The cross rate behind a synthetic pair, from the bank's reference rates (mock LPs, demos). */
export function crossFromReference(cross: string, rateOf: (pair: string) => number | undefined, quote = 'TRY'): number | undefined {
  const funding = rateOf(`${VEHICLE}${quote}`);
  if (!funding) return undefined;
  if (cross.endsWith(VEHICLE)) {
    const base = cross.slice(0, 3);
    const synthetic = rateOf(`${base}${quote}`);
    return synthetic ? (synthetic * (METALS.has(base) ? Number(GRAMS_PER_OUNCE) : 1)) / funding : undefined;
  }
  if (cross.startsWith(VEHICLE)) {
    const synthetic = rateOf(`${cross.slice(3)}${quote}`);
    return synthetic ? funding / synthetic : undefined;
  }
  return undefined;
}

const SEP = '+';
const legRef = (ref: string, leg: 1 | 2) => `${ref}/${leg}`;
const older = (a: string, b: string) => (Date.parse(a) <= Date.parse(b) ? a : b);
/** Quantities sent to an LP: at most `decimals` places, rounded half up. */
const qtyOf = (scaled: bigint, decimals: number) => divRound(scaled, 10n ** BigInt(8 - decimals), 'HALF_UP') * 10n ** BigInt(8 - decimals);
const dec8 = (v: string) => parseDecimal(v, 8);

/**
 * LiquidityAdapter that adds synthetic crosses to what the LPs quote. A pair the LPs do not quote directly
 * (gram gold, CHFTRY…) is priced from its cross against the dollar and USDTRY: one quote per combination of
 * LPs, named `crossLp+fundingLp`, at the worse timestamp of the two. The bank buying takes both asks, the
 * bank selling hits both bids (for an inverted cross, the opposite side of the cross), so the synthetic
 * spread is the two spreads combined. Pairs the LPs quote directly keep their own quotes alongside, and the
 * price engine takes the best of all.
 *
 * Trading a synthetic quote is two LP trades: the cross first, then the dollars it bought or sold against
 * the quote currency. Each leg carries the clip's reference with /1 or /2, so both are idempotent and can be
 * looked up. Once the cross has traded the outcome is never a rejection: if no LP took the funding leg, or a
 * lookup of it failed, the outcome is reported as unknown and the lookup (`findExecution`) completes the funding
 * leg before it reports the trade.
 */
export class SyntheticLiquidity implements LiquidityAdapter {
  constructor(
    private readonly inner: LiquidityAdapter,
    /** Currencies the bank's pairs are quoted in; the dollar crosses behind them are not offered as pairs. */
    private readonly quoteCurrencies: readonly string[] = ['TRY'],
  ) {}

  /**
   * Every LP that ever quoted a funding pair, and the LPs a funding leg was sent to (per reference): a lookup searches
   * them even when they do not quote right now. In memory only: after a restart, an LP that took a funding leg and
   * no longer quotes is not searched (the clip stays unknown until operations check it with that LP).
   */
  private readonly fundingLps = new Map<string, Set<string>>();
  private readonly sentTo = new Map<string, Set<string>>();

  private route(pair: string) {
    const r = syntheticRoute(pair);
    return r && this.quoteCurrencies.includes(pair.slice(3)) ? r : undefined;
  }

  /** The pairs the LPs quote in the bank's quote currencies, plus every synthetic pair both legs exist for. */
  async instruments() {
    const listed = await this.inner.instruments();
    const offered = new Set(listed.filter((p) => this.quoteCurrencies.includes(p.slice(3))));
    for (const quote of this.quoteCurrencies) {
      if (!listed.includes(`${VEHICLE}${quote}`)) continue;
      for (const p of listed) {
        const base = p.endsWith(VEHICLE) ? p.slice(0, 3) : p.startsWith(VEHICLE) ? p.slice(3) : undefined;
        const r = base && this.route(`${base}${quote}`);
        if (r && r.cross === p) offered.add(r.pair);
      }
    }
    return [...offered];
  }

  async quotes(pair: string): Promise<LpQuote[]> {
    const route = this.route(pair);
    const direct = this.inner.quotes(pair).catch((err) => {
      if (route && err instanceof LiquidityError) return [];
      throw err;
    });
    if (!route) return direct;
    const [own, combos] = await Promise.all([direct, this.syntheticQuotes(route).catch(() => [])]);
    // An LP that quotes the pair directly has its own price for it: no synthetic from its own two legs as well (the
    // two can disagree, e.g. a thin EUR/TRY book against EUR/USD × USD/TRY, and cross each other on the board).
    const directLps = new Set(own.map((q) => q.lp));
    const synthetic = combos.filter((q) => {
      const [c, f] = q.lp.split(SEP);
      return !(c === f && directLps.has(c!));
    });
    if (!own.length && !synthetic.length) throw new LiquidityError(`no liquidity for ${pair}`);
    return [...own, ...synthetic];
  }

  private async syntheticQuotes(route: SyntheticRoute): Promise<LpQuote[]> {
    const [cross, funding] = await Promise.all([this.inner.quotes(route.cross), this.inner.quotes(route.funding)]);
    const out: LpQuote[] = [];
    for (const c of cross) {
      for (const f of funding) {
        const r = combine(route, c, f);
        if (r) out.push({ lp: `${c.lp}${SEP}${f.lp}`, pair: route.pair, bid: formatPrice(r.bid), ask: formatPrice(r.ask), at: older(c.at, f.at) });
      }
    }
    return out;
  }

  private legs(lp: string, pair: string) {
    const route = this.route(pair);
    const i = lp.indexOf(SEP);
    if (!route || i < 0) return undefined;
    return { route, crossLp: lp.slice(0, i), fundingLp: lp.slice(i + 1) };
  }

  async execute(req: LpExecutionRequest): Promise<LpExecution> {
    const legs = this.legs(req.lp, req.pair);
    if (!legs) return this.inner.execute(req);
    const { route, crossLp } = legs;
    const qty = dec8(req.qty);
    if (qty <= 0n) throw new LiquidityError('quantity must be positive');
    const traded = await this.inner.findExecution(crossLp, legRef(req.ref, 1));
    if (traded) {
      try {
        return await this.complete(req, legs, traded, true);
      } catch (err) {
        throw asUnknown(err, `${route.cross} traded (${traded.tradeRef})`);
      }
    }
    // The limit is checked against the combination's current price: the legs themselves go without one, so
    // a cross that traded is never left without its funding leg because of a price move.
    if (req.limitRate) {
      const now = (await this.syntheticQuotes(route)).find((q) => q.lp === req.lp);
      if (!now) throw new LiquidityError(`${req.lp} does not quote ${req.pair}`);
      const rate = req.side === 'BUY' ? now.ask : now.bid;
      if (beyondLimit(req.side, rate, req.limitRate)) {
        throw new LiquidityError(`${req.lp} price moved: ${rate} is beyond the limit ${req.limitRate}`);
      }
    }
    let crossQty: bigint;
    let crossSide: 'BUY' | 'SELL';
    if (!route.inverted) {
      // XAUUSD: the bank buys gold with dollars, in ounces.
      crossSide = req.side;
      crossQty = qtyOf(divRound(qty * PRICE_SCALE, route.unit, 'HALF_UP'), route.crossDecimals);
    } else {
      // USDCHF: buying francs is selling dollars; the dollar amount comes from the LP's current price.
      crossSide = req.side === 'BUY' ? 'SELL' : 'BUY';
      const quote = (await this.inner.quotes(route.cross)).find((q) => q.lp === crossLp);
      if (!quote) throw new LiquidityError(`${crossLp} does not quote ${route.cross}`);
      const rate = parsePrice(crossSide === 'SELL' ? quote.bid : quote.ask);
      crossQty = qtyOf(divRound(qty * PRICE_SCALE, rate, 'HALF_UP'), route.crossDecimals);
    }
    if (crossQty <= 0n) throw new LiquidityError(`${req.qty} is below the smallest ${route.cross} trade`);
    // The cross: a rejection here means nothing traded.
    const cross = await this.inner.execute({ lp: crossLp, pair: route.cross, side: crossSide, qty: formatDecimal(crossQty, 8, 0), ref: legRef(req.ref, 1) });
    // From here on the cross has traded: whatever happens, the outcome is never a rejection.
    try {
      return await this.complete(req, legs, cross, false);
    } catch (err) {
      throw asUnknown(err, `${route.cross} traded (${cross.tradeRef})`);
    }
  }

  /**
   * The funding leg for a traded cross. `lookup`: the leg may have been sent before, so it is looked up first everywhere
   * it may have gone (the funding LP, every LP that quoted the funding pair, every LP it was sent to); a lookup that
   * fails makes the outcome unknown, nothing is sent then. Fresh from `execute`, the leg was never sent and goes
   * straight out. It is sent to the funding LP first, then to the others by price, never to an LP switched off.
   * `lookupOnly` (reconciliation): a leg not found is reported as unknown, never sent.
   */
  private async complete(
    req: LpExecutionRequest,
    legs: { route: SyntheticRoute; fundingLp: string },
    cross: LpExecution,
    lookup: boolean,
    lookupOnly = false,
  ): Promise<LpExecution> {
    const { route, fundingLp } = legs;
    const usd = route.inverted ? dec8(cross.qty) : qtyOf(divRound(dec8(cross.qty) * parsePrice(cross.rate), PRICE_SCALE, 'HALF_UP'), 2);
    const ref = legRef(req.ref, 2);
    const quoting = await this.inner
      .quotes(route.funding)
      .then((qs) => [...qs].sort((a, b) => (req.side === 'BUY' ? cmp(a.ask, b.ask) : cmp(b.bid, a.bid))).map((q) => q.lp))
      .catch(() => [] as string[]);
    const known = this.fundingLps.get(route.funding) ?? new Set<string>();
    for (const lp of quoting) known.add(lp);
    this.fundingLps.set(route.funding, known);
    const sent = this.sentTo.get(ref) ?? new Set<string>();
    this.sentTo.set(ref, sent);

    let funding: LpExecution | undefined;
    if (lookup) {
      const searched = new Set([fundingLp, ...sent, ...known]);
      for (const lp of searched) {
        try {
          funding = await this.inner.findExecution(lp, ref);
        } catch (err) {
          throw new LiquidityOutcomeUnknownError(`${route.funding} leg lookup at ${lp} failed: ${(err as Error).message}`);
        }
        if (funding) break;
      }
    }
    if (!funding && lookupOnly) {
      throw new LiquidityOutcomeUnknownError(
        `${route.cross} traded (${cross.tradeRef}) but its ${route.funding} leg was not found; not completed (lookup only)`,
      );
    }
    const excluded = new Set(req.excludeLps ?? []);
    const candidates = [fundingLp, ...quoting.filter((lp) => lp !== fundingLp)].filter((lp) => !excluded.has(lp));
    for (const lp of candidates) {
      if (funding) break;
      sent.add(lp);
      try {
        funding = await this.inner.execute({ lp, pair: route.funding, side: req.side, qty: formatDecimal(usd, 8, 0), ref });
      } catch (err) {
        if (!(err instanceof LiquidityError)) throw err;
      }
    }
    if (!funding) {
      throw new LiquidityOutcomeUnknownError(
        `${route.cross} traded (${cross.tradeRef}) but no LP took the ${route.funding} leg; it is retried on lookup`,
      );
    }
    this.sentTo.delete(ref);
    // Quote currency per bank unit: the dollars' value in the quote currency over the quantity asked for.
    const quoteValue = dec8(funding.qty) * parsePrice(funding.rate);
    const rate = divRound(quoteValue, dec8(req.qty), 'HALF_UP');
    return {
      ...req,
      rate: formatPrice(rate),
      tradeRef: `${cross.tradeRef}${SEP}${funding.tradeRef}`,
      at: funding.at,
    };
  }

  /** A synthetic LP name joins its legs' LPs (`LP-A+LP-B`): complete only if every leg's LP is. */
  lookupComplete(lp: string) {
    return lp.split('+').every((l) => this.inner.lookupComplete?.(l) ?? true);
  }

  /**
   * A synthetic trade needs the original request (`request`) to be rebuilt: without it only direct trades
   * can be found. A cross found without its funding leg has the funding leg completed here (unless `lookupOnly`).
   */

  async findExecution(lp: string, ref: string, request?: Omit<LpExecutionRequest, 'lp' | 'ref'>, options?: FindExecutionOptions) {
    const legs = request ? this.legs(lp, request.pair) : undefined;
    if (!legs || !request) return this.inner.findExecution(lp, ref, undefined, options);
    const cross = await this.inner.findExecution(legs.crossLp, legRef(ref, 1), undefined, options);
    if (!cross) return undefined;
    return this.complete({ ...request, lp, ref }, legs, cross, true, options?.lookupOnly);
  }
}

/** After the cross traded, any failure is an unknown outcome (never a rejection that would send the clip elsewhere). */
function asUnknown(err: unknown, context: string): Error {
  if (err instanceof LiquidityOutcomeUnknownError) return err;
  return new LiquidityOutcomeUnknownError(`${context}; the funding leg failed: ${(err as Error)?.message ?? String(err)}`);
}

const cmp = (a: string, b: string) => {
  const x = parsePrice(a);
  const y = parsePrice(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

/** Synthetic bid/ask (PRICE_SCALE) from a cross quote and a funding quote, rounded against the bank. */
export function combine(route: SyntheticRoute, cross: Pick<LpQuote, 'bid' | 'ask'>, funding: Pick<LpQuote, 'bid' | 'ask'>) {
  try {
    const cb = parsePrice(cross.bid);
    const ca = parsePrice(cross.ask);
    const fb = parsePrice(funding.bid);
    const fa = parsePrice(funding.ask);
    if (cb <= 0n || ca <= 0n || fb <= 0n || fa <= 0n) return undefined;
    if (route.inverted) {
      // CHFTRY = USDTRY / USDCHF: the bank buying francs sells dollars at the cross bid.
      return { bid: divRound(fb * PRICE_SCALE, ca, 'DOWN'), ask: divRound(fa * PRICE_SCALE, cb, 'UP') };
    }
    // XAUTRY per gram = XAUUSD per ounce × USDTRY ÷ grams per ounce.
    return { bid: divRound(cb * fb, route.unit, 'DOWN'), ask: divRound(ca * fa, route.unit, 'UP') };
  } catch {
    return undefined;
  }
}
