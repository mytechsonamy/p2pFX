/**
 * Phase 0 simulation (product definition v1.1, section 12): replays a customer FX flow and an LP price path through
 * the same matching engine, pricing and bank liquidity rules as the API, in memory and deterministically, and
 * compares the result with the Direct-only baseline (the same flow dealt with the bank at its Direct rates).
 *
 * Scenarios switch the bank's ladder (BANK_MM) and bot (BOT_MM), change fees, ladder depth and customer
 * participation. Synthetic limit prices are an assumption, not demand: they are scenario parameters (how many
 * pips better than Direct a customer asks for), reported as such.
 */
import { findPair, parsePrice, valueOf, type BankConfig, type PairConfig, type Side } from '@p2p/shared';
import { OrderBook, matchIncoming, type BookOrder } from '@p2p/matching';
import { priceSide, pricingParams } from '@p2p/pricing';
import { autoHedgeQty } from './dealing/positions.js';
import { segmentRates } from './dealing/price-engine.js';
import { ladderLevels } from './dealing/bank-book.js';

/** One customer instruction. `limitPips`: a limit this many pips better than the Direct rate; absent: market. */
export interface FlowEvent {
  t: number;
  customer: string;
  side: Side;
  /** Base minor units. */
  qty: bigint;
  /** DIRECT: deals with the bank; BOARD: an order on the board. */
  channel: 'DIRECT' | 'BOARD';
  limitPips?: number;
  /** How long a resting limit waits before the customer gives up (ms). */
  patienceMs?: number;
}

/** LP mid at a moment (PRICE_SCALE units); the LP half spread is applied around it. */
export interface PricePoint {
  t: number;
  mid: bigint;
}

export interface SimulationInput {
  config: BankConfig;
  pair: string;
  prices: PricePoint[];
  flow: FlowEvent[];
  /** LP half spread in pips around the mid (default 50). */
  lpHalfSpreadPips?: number;
  /** Deterministic randomness for the bot (default: a fixed seed). */
  seed?: number;
}

export interface SimulationResult {
  pair: string;
  orders: number;
  /** Customer instructions that traded at all. */
  filledOrders: number;
  fillRate: number;
  volume: { c2c: bigint; c2bLadder: bigint; c2bBot: bigint; direct: bigint };
  customerLegVolume: bigint;
  /** Share of customer leg volume matched with another customer. */
  p2pMatchRatio: number;
  /** Quote minor units. */
  fees: bigint;
  directMargin: bigint;
  /** The bank's spread over the LP on its principal fills on the board (marked at the LP price of the moment). */
  principalContribution: bigint;
  /** What hedging cost against the LP mid. */
  hedgeCost: bigint;
  netRevenue: bigint;
  netRevenuePerLeg: bigint;
  /** All-in improvement against Direct for the same customer, side and moment (quote minor units, + = better). */
  priceImprovement: bigint;
  peakInventory: bigint;
  hedges: number;
  baseline: { directMargin: bigint; netRevenuePerLeg: bigint };
  /** Two bank orders never traded with each other (self trade prevention). */
  bankSelfTrades: number;
}

const BANK = 'BANK';

/** Small deterministic generator (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function simulate(input: SimulationInput): Promise<SimulationResult> {
  const { config } = input;
  const pair = findPair(config, input.pair);
  if (!pair) throw new Error(`unknown pair ${input.pair}`);
  const pip = parsePrice(pair.pipSize);
  const tick = parsePrice(pair.tickSize);
  const half = BigInt(input.lpHalfSpreadPips ?? 50) * pip;
  const random = rng(input.seed ?? 42);
  const book = new OrderBook();
  const owners = new Map<string, { source: 'CUSTOMER' | 'BANK_MM' | 'BOT_MM'; customer?: string; expires?: number; event?: FlowEvent }>();
  let seq = 0n;
  let id = 0;

  const r: SimulationResult = {
    pair: pair.symbol, orders: input.flow.length, filledOrders: 0, fillRate: 0,
    volume: { c2c: 0n, c2bLadder: 0n, c2bBot: 0n, direct: 0n }, customerLegVolume: 0n, p2pMatchRatio: 0,
    fees: 0n, directMargin: 0n, principalContribution: 0n, hedgeCost: 0n, netRevenue: 0n, netRevenuePerLeg: 0n,
    priceImprovement: 0n, peakInventory: 0n, hedges: 0, baseline: { directMargin: 0n, netRevenuePerLeg: 0n }, bankSelfTrades: 0,
  };
  let position = 0n;
  let legs = 0n;
  const filled = new Set<FlowEvent>();
  const money = (qty: bigint, price: bigint) => valueOf(qty, pair.baseDecimals, price, pair.quoteDecimals, 'HALF_UP');
  const abs = (v: bigint) => (v < 0n ? -v : v);
  const maxPos = config.inventory.maxPosition[pair.base] ? parsePrice(config.inventory.maxPosition[pair.base]) / 10n ** BigInt(8 - pair.baseDecimals) : undefined;
  const hedgeLimit = config.dealing.positionLimits[pair.base] ? parsePrice(config.dealing.positionLimits[pair.base]) / 10n ** BigInt(8 - pair.baseDecimals) : undefined;

  let pi = 0;
  const lpAt = (t: number) => {
    while (pi + 1 < input.prices.length && input.prices[pi + 1].t <= t) pi++;
    const mid = input.prices[pi].mid;
    return { mid, bid: mid - half, ask: mid + half };
  };

  const remove = (source: 'BANK_MM' | 'BOT_MM') => {
    for (const o of book.orders()) if (owners.get(o.id)?.source === source) book.remove(o.id);
  };
  const add = (o: Omit<BookOrder, 'id' | 'seq'>, owner: { source: 'CUSTOMER' | 'BANK_MM' | 'BOT_MM'; customer?: string; expires?: number; event?: FlowEvent }) => {
    const order: BookOrder = { ...o, id: `o${++id}`, seq: ++seq };
    owners.set(order.id, owner);
    return order;
  };

  /** A board fill: fees for customer sides, the bank's principal side moves its position. */
  const onFill = (taker: BookOrder, maker: BookOrder, qty: bigint, price: bigint, lp: { bid: bigint; ask: bigint }) => {
    const sides = [taker, maker].map((o) => ({ o, owner: owners.get(o.id)! }));
    const customers = sides.filter((s) => s.owner.source === 'CUSTOMER');
    if (customers.length === 0) r.bankSelfTrades++;
    for (const s of customers) {
      const p = priceSide(qty, price, pricingParams(config, pair, s.o.side));
      r.fees += p.commission;
      legs++;
      r.customerLegVolume += qty;
      // Against what the bank's Direct rate would have charged this customer at this moment.
      const direct = segmentRates(config, pair, lp, 'default');
      const directValue = money(qty, s.o.side === 'BUY' ? direct.buy : direct.sell);
      const paid = money(qty, p.effectivePrice);
      r.priceImprovement += s.o.side === 'BUY' ? directValue - paid : paid - directValue;
      if (s.owner.event) filled.add(s.owner.event);
    }
    if (customers.length === 2) r.volume.c2c += qty;
    const bank = sides.find((s) => s.owner.source !== 'CUSTOMER');
    if (bank && customers.length === 1) {
      if (bank.owner.source === 'BANK_MM') r.volume.c2bLadder += qty;
      else r.volume.c2bBot += qty;
      const delta = bank.o.side === 'BUY' ? qty : -qty;
      position += delta;
      // Bank sells above the LP ask / buys below the LP bid: that spread is what it keeps after hedging at the LP.
      r.principalContribution += bank.o.side === 'SELL' ? money(qty, price - lp.ask) : money(qty, lp.bid - price);
    }
  };

  const hedge = (lp: { mid: bigint; bid: bigint; ask: bigint }) => {
    if (!config.dealing.autoHedge || hedgeLimit === undefined) return;
    const qty = autoHedgeQty(position, hedgeLimit, config.dealing.hedging.targetPct);
    if (qty === 0n) return;
    r.hedges++;
    r.hedgeCost += money(qty, half);
    position += position > 0n ? -qty : qty;
  };

  const refreshLiquidity = (lp: { mid: bigint; bid: bigint; ask: bigint }) => {
    remove('BANK_MM');
    remove('BOT_MM');
    const room = (side: Side) => (maxPos === undefined ? undefined : side === 'BUY' ? maxPos - position : maxPos + position);
    const left: Record<Side, bigint | undefined> = { BUY: room('BUY'), SELL: room('SELL') };
    const place = (side: Side, price: bigint, qty: bigint, source: 'BANK_MM' | 'BOT_MM') => {
      const l = left[side];
      const q = l === undefined ? qty : l < qty ? l : qty;
      if (q <= 0n) return;
      if (l !== undefined) left[side] = l - q;
      const o = add({ principalId: BANK, side, price, remaining: q, source }, { source });
      // Bank liquidity is passive here: a level that would cross the book is skipped.
      const best = book.best(side === 'BUY' ? 'SELL' : 'BUY');
      if (best && (side === 'BUY' ? price >= best.price : price <= best.price)) return;
      book.add(o);
    };
    if (config.channels.bankMarketMaker && config.bankBook.pairs[pair.symbol]) {
      const rates = segmentRates(config, pair, lp, config.bankBook.anchorSegment);
      for (const l of ladderLevels(config, pair, 'asks', rates.buy)) place('SELL', l.price, l.qty, 'BANK_MM');
      for (const l of ladderLevels(config, pair, 'bids', rates.sell)) place('BUY', l.price, l.qty, 'BANK_MM');
    }
    if (config.channels.botMarketMaker) {
      const bot = config.botMarketMaker;
      const lot = bot.lots[pair.base] ?? bot.lots.default;
      const units = (v: string) => parsePrice(v) / 10n ** BigInt(8 - pair.baseDecimals);
      const min = units(lot.min);
      const step = units(lot.step) || 1n;
      const steps = (units(lot.max) - min) / step;
      for (const side of ['SELL', 'BUY'] as const) {
        let off = BigInt(bot.offsetPips.min + Math.floor(random() * (bot.offsetPips.max - bot.offsetPips.min + 1)));
        for (let i = 0; i < bot.levels; i++) {
          const raw = side === 'SELL' ? lp.mid + off * pip : lp.mid - off * pip;
          const price = side === 'SELL' ? ((raw + tick - 1n) / tick) * tick : (raw / tick) * tick;
          place(side, price, min + BigInt(Math.floor(random() * Number(steps + 1n))) * step, 'BOT_MM');
          off += BigInt(bot.stepPips);
        }
      }
    }
  };

  const expire = (t: number) => {
    for (const o of book.orders()) {
      const owner = owners.get(o.id)!;
      if (owner.source === 'CUSTOMER' && owner.expires !== undefined && owner.expires <= t) book.remove(o.id);
    }
  };

  const flow = [...input.flow].sort((a, b) => a.t - b.t);
  for (const e of flow) {
    const lp = lpAt(e.t);
    expire(e.t);
    hedge(lp);
    refreshLiquidity(lp);
    const direct = segmentRates(config, pair, lp, 'default');
    // Baseline: every instruction dealt with the bank at its Direct rate.
    const baseRate = e.side === 'BUY' ? direct.buy : direct.sell;
    r.baseline.directMargin += money(e.qty, e.side === 'BUY' ? baseRate - lp.ask : lp.bid - baseRate);

    if (e.channel === 'DIRECT') {
      if (!config.channels.bankDirect) continue;
      const delta = e.side === 'BUY' ? -e.qty : e.qty;
      if (maxPos !== undefined && abs(position + delta) > maxPos && abs(position + delta) >= abs(position)) continue;
      position += delta;
      r.volume.direct += e.qty;
      r.customerLegVolume += e.qty;
      legs++;
      r.directMargin += money(e.qty, e.side === 'BUY' ? baseRate - lp.ask : lp.bid - baseRate);
      filled.add(e);
    } else {
      const market = e.limitPips === undefined;
      const limit = market
        ? e.side === 'BUY' ? lp.ask * (10_000n + BigInt(config.marketOrders.maxSlippageBps)) / 10_000n : lp.bid * (10_000n - BigInt(config.marketOrders.maxSlippageBps)) / 10_000n
        : e.side === 'BUY' ? baseRate - BigInt(e.limitPips!) * pip : baseRate + BigInt(e.limitPips!) * pip;
      const price = e.side === 'BUY' ? (limit / tick) * tick : ((limit + tick - 1n) / tick) * tick;
      const taker = add({ principalId: e.customer, side: e.side, price, remaining: e.qty, source: 'CUSTOMER' }, {
        source: 'CUSTOMER', customer: e.customer, expires: e.t + (e.patienceMs ?? 60_000), event: e,
      });
      await matchIncoming(book, taker, (c) => {
        onFill(taker, c.maker, c.qty, c.price, lp);
        return { action: 'filled' };
      }, { selfTrade: config.selfTradePrevention, rest: !market });
    }
    r.peakInventory = abs(position) > r.peakInventory ? abs(position) : r.peakInventory;
  }

  r.filledOrders = filled.size;
  r.fillRate = flow.length ? filled.size / flow.length : 0;
  r.p2pMatchRatio = r.customerLegVolume ? Number((2n * r.volume.c2c * 10_000n) / r.customerLegVolume) / 10_000 : 0;
  r.netRevenue = r.fees + r.directMargin + r.principalContribution - r.hedgeCost;
  r.netRevenuePerLeg = legs ? r.netRevenue / legs : 0n;
  r.baseline.netRevenuePerLeg = flow.length ? r.baseline.directMargin / BigInt(flow.length) : 0n;
  return r;
}

/** A synthetic day: a mean-reverting LP path and a customer flow with the given participation assumptions. */
export function syntheticScenario(opts: {
  pair: PairConfig;
  start: bigint;
  events: number;
  seed?: number;
  /** Share of instructions that go to the board instead of Direct. */
  boardShare?: number;
  /** Share of board instructions that are limits (the rest market). */
  limitShare?: number;
  /** Buy share (one-sided flow stress: 0.9). */
  buyShare?: number;
  /** Largest improvement over Direct a limit asks for, in pips. */
  maxImprovementPips?: number;
  /** LP volatility per step as a fraction of the price. */
  volatility?: number;
}): { prices: PricePoint[]; flow: FlowEvent[] } {
  const random = rng(opts.seed ?? 7);
  const prices: PricePoint[] = [];
  const flow: FlowEvent[] = [];
  let mid = Number(opts.start);
  const vol = opts.volatility ?? 0.0001;
  const minQty = 100n * 10n ** BigInt(opts.pair.baseDecimals);
  for (let i = 0; i < opts.events; i++) {
    const t = i * 1000;
    mid += 0.05 * (Number(opts.start) - mid) + vol * Number(opts.start) * (random() * 2 - 1);
    prices.push({ t, mid: BigInt(Math.round(mid)) });
    const board = random() < (opts.boardShare ?? 0.6);
    const limit = random() < (opts.limitShare ?? 0.7);
    flow.push({
      t,
      customer: `c${Math.floor(random() * 50)}`,
      side: random() < (opts.buyShare ?? 0.5) ? 'BUY' : 'SELL',
      qty: minQty * BigInt(1 + Math.floor(random() * 30)),
      channel: board ? 'BOARD' : 'DIRECT',
      limitPips: board && limit ? Math.floor(random() * (opts.maxImprovementPips ?? 1500)) : undefined,
      patienceMs: 30_000 + Math.floor(random() * 120_000),
    });
  }
  return { prices, flow };
}
