import { findPair, formatDecimal, formatPrice, parseDecimal, parsePrice, PRICE_SCALE, type BankConfig, type PairConfig } from '@p2p/shared';
import { commissionPerUnitOf } from '@p2p/pricing';
import type { CoreBankingAdapter } from '@p2p/core-adapter';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/pool.js';
import type { ConfigService } from '../config-service.js';
import type { Exchange, LiquidityCommand, LiquidityLevel } from '../engine/exchange.js';
import { segmentRates, type PriceEngine } from './price-engine.js';
import { haltReason } from '../order-entry.js';

type BookSide = 'asks' | 'bids';

export interface Level {
  price: bigint;
  qty: bigint;
}

export const LADDER_STRATEGY = 'bank-ladder';

/**
 * The bank's ladder for one side of a pair. Asks start `startPct` above the anchor segment's buy rate and step
 * outwards; bids mirror it below the sell rate. With `includeCommission` (Bank L1 parity), the customer's commission
 * is taken out of the book price, so that what the customer pays (or receives) on a level is never better than the
 * bank's own Direct rate for that segment.
 */
export function ladderLevels(config: BankConfig, pair: PairConfig, side: BookSide, anchor: bigint): Level[] {
  const ladder = config.bankBook.pairs[pair.symbol]?.[side];
  if (!ladder?.enabled) return [];
  const tick = parsePrice(pair.tickSize);
  const start = parsePrice(ladder.startPct);
  const step = parsePrice(ladder.stepPct);
  // percent in PRICE_SCALE units → fraction: anchor × pct / (100 × PRICE_SCALE)
  const away = (pct: bigint) => (anchor * pct) / (100n * PRICE_SCALE);
  return ladder.levels.map((q, i) => {
    const distance = away(start + step * BigInt(i));
    const qty = parseDecimal(q, pair.baseDecimals);
    if (side === 'asks') {
      const commission = config.bankBook.includeCommission ? commissionPerUnitOf(pair, 'BUY', anchor + distance) : 0n;
      const price = anchor + distance - commission;
      return { price: ((price + tick - 1n) / tick) * tick, qty };
    }
    const commission = config.bankBook.includeCommission ? commissionPerUnitOf(pair, 'SELL', anchor - distance) : 0n;
    const price = anchor - distance + commission;
    return { price: (price / tick) * tick, qty };
  });
}

/** The bank's trading account in core banking (its ladder and bot orders are booked there). */
export class BankAccount {
  private cached?: { ref: string; customerId: string; accounts: Map<string, string> };

  constructor(
    private readonly db: Db,
    private readonly core: CoreBankingAdapter,
  ) {}

  async for(config: BankConfig, pair: PairConfig): Promise<LiquidityCommand['account'] | undefined> {
    const ref = config.bankBook.customerRef;
    if (this.cached?.ref !== ref) {
      const { rows } = await this.db.query(
        `insert into customers (customer_ref, segment) values ($1, 'bank')
         on conflict (customer_ref) do update set last_seen_at = now() returning id`,
        [ref],
      );
      const accounts = await this.core.getAccounts(ref);
      this.cached = { ref, customerId: rows[0].id, accounts: new Map(accounts.map((a) => [a.currency, a.id])) };
    }
    const fx = this.cached.accounts.get(pair.base);
    const tl = this.cached.accounts.get(pair.quote);
    if (!fx || !tl) return undefined;
    return { customerId: this.cached.customerId, fxAccountId: fx, tryAccountId: tl };
  }
}

interface PairState {
  anchors: { ask: bigint; bid: bigint };
  config: BankConfig;
  placed: number;
}

/**
 * Market making with the bank's own account (BANK_MM): keeps the configured ladder resting in the P2P book and
 * replaces it as one generation when the bank's rate moves, the configuration changes or customers took levels.
 * A stale LP price, the channel switched off, a halt or a disabled pair withdraw it. The position it builds is
 * the bank's, updated as fills commit; inventory limits cut levels when the generation goes in.
 */
export class BankBook {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private readonly state = new Map<string, PairState>();

  constructor(
    private readonly db: Db,
    private readonly config: ConfigService,
    private readonly exchange: Exchange,
    private readonly prices: PriceEngine,
    private readonly account: BankAccount,
    private readonly log: FastifyBaseLogger,
  ) {}

  start(intervalMs: number) {
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.log.error({ err }, 'bank book tick failed'));
    }, intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass over every pair. Safe to call directly (tests). */
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const config = this.config.get().data;
      for (const pair of config.pairs) {
        try {
          await this.syncPair(config, pair);
        } catch (err) {
          this.log.warn({ err, pair: pair.symbol }, 'bank ladder not updated');
        }
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * Withdraws the ladder at once wherever it may not rest any more (the channel switched off, a halt, the pair
   * closed); places nothing. Runs on every configuration change.
   */
  async enforce() {
    const config = this.config.get().data;
    for (const pair of config.pairs) {
      const off = !config.channels.bankMarketMaker || !pair.enabled || !config.bankBook.pairs[pair.symbol] || !!haltReason(config, pair.symbol, 'bank');
      if (off && this.exchange.liquidity(pair.symbol, 'BANK_MM', LADDER_STRATEGY).length) {
        this.state.delete(pair.symbol);
        await this.withdraw(pair.symbol, 'BANK_MM', LADDER_STRATEGY);
      }
    }
  }

  private async syncPair(config: BankConfig, pair: PairConfig) {
    const live = this.exchange.liquidity(pair.symbol, 'BANK_MM', LADDER_STRATEGY);
    // A stale or missing LP price withdraws the bank's orders: the bank never rests prices it cannot hedge at.
    const agg = this.prices.fresh(pair.symbol);
    const wanted = config.channels.bankMarketMaker && pair.enabled && agg && config.bankBook.pairs[pair.symbol] && !haltReason(config, pair.symbol, 'bank');
    const account = wanted ? await this.account.for(config, pair) : undefined;
    if (!wanted || !account) {
      this.state.delete(pair.symbol);
      if (live.length) await this.withdraw(pair.symbol, 'BANK_MM', LADDER_STRATEGY);
      return;
    }

    const rates = segmentRates(config, pair, agg, config.bankBook.anchorSegment);
    const anchors = { ask: rates.buy, bid: rates.sell };
    const prev = this.state.get(pair.symbol);
    const threshold = BigInt(config.bankBook.repricePips) * parsePrice(pair.pipSize);
    const moved = !prev || abs(anchors.ask - prev.anchors.ask) >= threshold || abs(anchors.bid - prev.anchors.bid) >= threshold;
    // Fewer resting orders than were placed, or a partial fill: customers took bank liquidity.
    const taken = !!prev && (live.length < prev.placed || live.some((o) => o.remaining < o.qty));
    if (!moved && !taken && prev?.config === config) return;

    const levels: LiquidityLevel[] = [
      ...ladderLevels(config, pair, 'asks', anchors.ask).map((l) => ({ side: 'SELL' as const, ...l })),
      ...ladderLevels(config, pair, 'bids', anchors.bid).map((l) => ({ side: 'BUY' as const, ...l })),
    ];
    const res = await this.exchange.replaceLiquidity({
      pair: pair.symbol, source: 'BANK_MM', strategyId: LADDER_STRATEGY, account, levels, generationId: await this.exchange.nextGenerationId(),
    });
    this.state.set(pair.symbol, { anchors, config, placed: res.placed });
    if (res.skipped) this.log.debug({ pair: pair.symbol, skipped: res.skipped }, 'bank ladder levels cut (inventory limit or price band)');
  }

  private async withdraw(pair: string, source: 'BANK_MM' | 'BOT_MM', strategyId: string) {
    const config = this.config.get().data;
    const p = findPair(config, pair);
    const account = p ? await this.account.for(config, p) : undefined;
    if (!account) return;
    await this.exchange.replaceLiquidity({ pair, source, strategyId, account, levels: [], reason: 'WITHDRAWN', generationId: await this.exchange.nextGenerationId() });
  }

  /** The bank's resting orders (ladder and bot) per pair and side, for the dealer screen. */
  async snapshot() {
    const config = this.config.get().data;
    const { rows } = await this.db.query(
      `select o.pair, o.side, o.source, o.strategy_id, o.book_price, o.qty, o.filled_qty from orders o
        where o.source in ('BANK_MM', 'BOT_MM') and o.status in ('OPEN', 'PARTIAL') order by o.pair, o.side, o.book_price, o.source`,
    );
    return rows.map((r) => {
      const pair = findPair(config, r.pair);
      const d = pair?.baseDecimals ?? 2;
      return {
        pair: r.pair, side: r.side, source: r.source, strategyId: r.strategy_id,
        price: formatPrice(parsePrice(r.book_price)), qty: formatDecimal(BigInt(r.qty) - BigInt(r.filled_qty), d),
      };
    });
  }
}

/**
 * The bank's algorithmic market maker (BOT_MM): a few levels per side around the LP mid so the board is never empty,
 * entered as one generation per pair for the bank (the principal). It shares the bank's inventory limit, never
 * trades with the bank's other liquidity (same principal) and never crosses the book (it only adds passive
 * levels). A stale feed, the channel switched off or a halt withdraw it.
 */
export class BotMarketMaker {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private last = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly exchange: Exchange,
    private readonly prices: PriceEngine,
    private readonly account: BankAccount,
    private readonly log: FastifyBaseLogger,
    private readonly clock: () => Date = () => new Date(),
    private readonly random: () => number = Math.random,
  ) {}

  /** Checks often; refreshes each `botMarketMaker.refreshMs`, and withdraws at once when it must. */
  start(intervalMs: number) {
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.log.error({ err }, 'bot market maker tick failed'));
    }, intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass over every pair (`force` ignores the refresh interval: tests). */
  async tick(force = true) {
    if (this.running) return;
    this.running = true;
    try {
      const config = this.config.get().data;
      const now = this.clock().getTime();
      const refresh = force || now - this.last >= config.botMarketMaker.refreshMs;
      if (refresh) this.last = now;
      for (const pair of config.pairs) {
        try {
          await this.syncPair(config, pair, refresh);
        } catch (err) {
          this.log.warn({ err, pair: pair.symbol }, 'bot levels not updated');
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** Withdraws the bot at once wherever it may not quote any more; places nothing. Runs on every configuration change. */
  async enforce() {
    const config = this.config.get().data;
    for (const pair of config.pairs) {
      const off = !config.channels.botMarketMaker || !pair.enabled || !!haltReason(config, pair.symbol, 'bank');
      if (off && this.exchange.liquidity(pair.symbol, 'BOT_MM', config.botMarketMaker.strategyId).length) await this.replace(config, pair, []);
    }
  }

  private async syncPair(config: BankConfig, pair: PairConfig, refresh: boolean) {
    const bot = config.botMarketMaker;
    const live = this.exchange.liquidity(pair.symbol, 'BOT_MM', bot.strategyId);
    const agg = this.prices.fresh(pair.symbol);
    const on = config.channels.botMarketMaker && pair.enabled && !!agg && !haltReason(config, pair.symbol, 'bank');
    if (!on) {
      if (live.length) await this.replace(config, pair, []);
      return;
    }
    if (!refresh && live.length) return;
    await this.replace(config, pair, this.levels(config, pair, agg));
  }

  /** Bot levels around the LP mid: never crossing the best opposite price of the rest of the book. */
  levels(config: BankConfig, pair: PairConfig, agg: { bid: bigint; ask: bigint }): LiquidityLevel[] {
    const bot = config.botMarketMaker;
    const pip = parsePrice(pair.pipSize);
    const tick = parsePrice(pair.tickSize);
    const mid = (agg.bid + agg.ask) / 2n;
    const lot = bot.lots[pair.base] ?? bot.lots.default;
    const out: LiquidityLevel[] = [];
    const best = (side: 'BUY' | 'SELL') => this.exchange.bestPrice(pair.symbol, side, { source: 'BOT_MM', strategyId: bot.strategyId });
    const bestBid = best('BUY');
    const bestAsk = best('SELL');
    for (const side of ['SELL', 'BUY'] as const) {
      let offset = BigInt(bot.offsetPips.min + Math.floor(this.random() * (bot.offsetPips.max - bot.offsetPips.min + 1)));
      for (let i = 0; i < bot.levels; i++) {
        let price = side === 'SELL' ? mid + offset * pip : mid - offset * pip;
        price = side === 'SELL' ? ((price + tick - 1n) / tick) * tick : (price / tick) * tick;
        // Passive only: an ask above the best bid, a bid below the best ask.
        if (side === 'SELL' && bestBid !== undefined && price <= bestBid) price = bestBid + tick;
        if (side === 'BUY' && bestAsk !== undefined && price >= bestAsk) price = bestAsk - tick;
        if (price > 0n && !out.some((l) => l.side === side && l.price === price)) out.push({ side, price, qty: this.lotQty(pair, lot) });
        offset += BigInt(bot.stepPips) + BigInt(Math.floor(this.random() * bot.stepPips));
      }
    }
    return out;
  }

  private lotQty(pair: PairConfig, lot: { min: string; max: string; step: string }): bigint {
    const min = parseDecimal(lot.min, pair.baseDecimals);
    const max = parseDecimal(lot.max, pair.baseDecimals);
    const step = parseDecimal(lot.step, pair.baseDecimals) || 1n;
    const steps = max > min ? (max - min) / step : 0n;
    return min + BigInt(Math.floor(this.random() * (Number(steps) + 1))) * step;
  }

  private async replace(config: BankConfig, pair: PairConfig, levels: LiquidityLevel[]) {
    const account = await this.account.for(config, pair);
    if (!account) return;
    await this.exchange.replaceLiquidity({
      pair: pair.symbol, source: 'BOT_MM', strategyId: config.botMarketMaker.strategyId, account, levels,
      reason: levels.length ? 'REPLACED' : 'WITHDRAWN', generationId: await this.exchange.nextGenerationId(),
    });
  }
}

const abs = (v: bigint) => (v < 0n ? -v : v);
