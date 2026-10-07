import { createHash } from 'node:crypto';
import {
  currentOrNextSessionClose,
  findPair,
  formatDecimal,
  formatPrice,
  isMarketOpen,
  parseDecimal,
  parsePrice,
  type BankConfig,
  type PairConfig,
  type PlaceOrderRequest,
  type QuoteRequest,
  type Side,
} from '@p2p/shared';
import { priceSide, pricingParams, toBreakdown, toSnapshot } from '@p2p/pricing';
import { CoreBankingError, type CoreAccount, type CoreBankingAdapter } from '@p2p/core-adapter';
import { tx, type Db } from './db/pool.js';
import { reserveDailyLimit } from './limits.js';
import type { Session } from './auth.js';
import type { ConfigService } from './config-service.js';
import type { Exchange } from './engine/exchange.js';
import { ApiError, badRequest, conflict, unprocessable } from './errors.js';
import { loadOrder, orderView, requirementFor, type OrderRow } from './orders.js';
import { audit } from './audit.js';
import { appendEvent } from './event-store.js';
import type { PriceEngine } from './dealing/price-engine.js';

const DAY_MS = 86_400_000;
/** A market order lives for one pass of matching; this is only its bookkeeping expiry. */
const MARKET_ORDER_TTL_MS = 60_000;

/** The kill switch: why new entries of this kind are refused right now, if they are. */
export function haltReason(config: BankConfig, pair: string, who: 'customer' | 'bank'): string | undefined {
  const k = config.killSwitch;
  if (k.allTrading) return 'trading is halted';
  if (k.haltedPairs.includes(pair)) return `${pair} is halted`;
  if (who === 'customer' && k.newCustomerOrders) return 'new orders are not accepted right now';
  return undefined;
}

/**
 * A market order's protection price: the LP price on the side it takes, moved by the bank's maximum slippage and
 * rounded to the tick against the customer's favour (so the order never trades beyond it). Undefined without a
 * live LP price: a stale price is never used as protection.
 */
export function protectionPrice(pair: PairConfig, side: Side, lp: { bid: bigint; ask: bigint }, maxSlippageBps: number): bigint {
  const tick = parsePrice(pair.tickSize);
  const bps = BigInt(maxSlippageBps);
  if (side === 'BUY') {
    const p = (lp.ask * (10_000n + bps) + 9_999n) / 10_000n;
    return ((p + tick - 1n) / tick) * tick;
  }
  const p = (lp.bid * (10_000n - bps)) / 10_000n;
  return (p / tick) * tick;
}

/**
 * Order entry: validation (pair, tick, minimum, price band, validity, trading hours,
 * limits), idempotency, the balance check or hold, then hand-off to the matching worker.
 */
export class OrderEntry {
  constructor(
    private readonly db: Db,
    private readonly core: CoreBankingAdapter,
    private readonly config: ConfigService,
    private readonly exchange: Exchange,
    private readonly prices: PriceEngine,
    private readonly clock: () => Date,
  ) {}

  /**
   * Full breakdown for the confirmation screen. Same maths as the fill. A market order is priced at its protection
   * price (the worst case the customer can get), with an estimate of the average price the book gives now.
   */
  async quote(body: QuoteRequest) {
    const config = this.config.get().data;
    const { pair, qty, price } = await this.validatePriceAndQty(config, body);
    const params = pricingParams(config, pair, body.side);
    const breakdown = toBreakdown(pair, priceSide(qty, price, params), params);
    if (body.type !== 'MARKET') return breakdown;
    return { ...breakdown, type: 'MARKET' as const, protectionPrice: formatPrice(price), estimate: this.estimate(pair, body.side, qty, price) };
  }

  /** What the visible book would give a market order now, within its protection price. */
  private estimate(pair: PairConfig, side: Side, qty: bigint, limit: bigint) {
    const book = this.exchange.levels(pair.symbol, side === 'BUY' ? 'SELL' : 'BUY');
    let left = qty;
    let value = 0n;
    for (const l of book) {
      if (left === 0n || (side === 'BUY' ? l.price > limit : l.price < limit)) break;
      const take = l.qty < left ? l.qty : left;
      value += take * l.price;
      left -= take;
    }
    const filled = qty - left;
    return { averagePrice: filled > 0n ? formatPrice(value / filled) : '0', fillableQty: formatDecimal(filled, pair.baseDecimals) };
  }

  /** A customer's order. The bank's own liquidity (ladder, bot) enters through `Exchange.replaceLiquidity`. */
  async place(session: Session, body: PlaceOrderRequest, idempotencyKey: string | undefined) {
    // Nothing is recorded or held on an instance that cannot match the order.
    if (!this.exchange.running) throw new ApiError(503, 'MATCHING_UNAVAILABLE', 'matching is not running on this instance');
    if (!idempotencyKey || idempotencyKey.length > 200) throw badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required');
    const requestHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');

    // A retried request returns the original result.
    const prior = await this.db.query('select id, request_hash from orders where customer_id = $1 and idempotency_key = $2', [
      session.customerId,
      idempotencyKey,
    ]);
    if (prior.rows.length) return this.replay(prior.rows[0], requestHash);

    const { data: config, version } = this.config.get();
    const now = this.clock();
    const halted = haltReason(config, body.pair, 'customer');
    if (halted) throw unprocessable('TRADING_HALTED', halted);
    const market = body.type === 'MARKET';
    const { pair, qty, price: current } = await this.validatePriceAndQty(config, body);
    const price = market ? this.bindProtection(pair, body, current) : current;
    const params = pricingParams(config, pair, body.side);
    const pricing = priceSide(qty, price, params);

    const validity = market ? 'IOC' : body.validity!;
    if (!market && !config.validity.options.includes(body.validity!)) {
      throw badRequest('VALIDITY_NOT_ALLOWED', `validity ${body.validity} is not offered`);
    }
    const expiresAt = market ? new Date(now.getTime() + MARKET_ORDER_TTL_MS) : this.expiry(config, body, now);
    const open = isMarketOpen(now, config.tradingHours);
    // A market order is for now: it never waits for the session to open.
    if (!open && (market || config.tradingHours.outsideHours === 'reject')) throw unprocessable('MARKET_CLOSED', 'the market is closed');

    this.checkOrderLimit(config, session, pricing.notional, pair);

    const accounts = await this.core.getAccounts(session.customerRef);
    const fxAccount = pickAccount(accounts, pair.base, body.fxAccountId);
    const tryAccount = pickAccount(accounts, pair.quote, body.tryAccountId);

    // The daily limit is checked and the order recorded in one transaction, under the customer's limit lock.
    const insert = await tx(this.db, async (client) => {
      await reserveDailyLimit(client, config, session, pricing.notional, pair, now);
      return client.query(
        `insert into orders (customer_id, principal_id, source, order_type, pair, side, book_price, qty, validity, expires_at, fx_account_id,
           try_account_id, status, pricing, config_version, balance_mode, notional, idempotency_key, request_hash)
         values ($1, (select principal_id from customers where id = $1), 'CUSTOMER', $2, $3, $4, $5, $6, $7, $8, $9, $10, 'NEW', $11, $12, $13, $14, $15, $16)
         on conflict (customer_id, idempotency_key) do nothing
         returning id`,
        [
          session.customerId, market ? 'MARKET' : 'LIMIT', pair.symbol, body.side, formatPrice(price, 8), qty, validity, expiresAt, fxAccount.id,
          tryAccount.id, toSnapshot(params), version, config.balanceMode, pricing.notional, idempotencyKey, requestHash,
        ],
      );
    });
    if (!insert.rows.length) {
      // Lost a race with a concurrent request carrying the same key.
      const again = await this.db.query('select id, request_hash from orders where customer_id = $1 and idempotency_key = $2', [
        session.customerId,
        idempotencyKey,
      ]);
      return this.replay(again.rows[0], requestHash);
    }
    const orderId: string = insert.rows[0].id;
    const row = (await loadOrder(this.db, orderId))!;

    // Funds: hold now (block) or just check (no_block).
    const account = body.side === 'SELL' ? fxAccount : tryAccount;
    const needed = requirementFor(row, qty);
    let holdId: string | null = null;
    try {
      if (config.balanceMode === 'block') {
        holdId = (await this.core.placeHold(account.id, needed, `order:${orderId}`)).holdId;
      } else if (account.available < needed) {
        throw new CoreBankingError('INSUFFICIENT_FUNDS', 'insufficient available balance');
      }
    } catch (err) {
      const reason = err instanceof CoreBankingError && err.code === 'INSUFFICIENT_FUNDS' ? 'INSUFFICIENT_BALANCE' : 'CORE_UNAVAILABLE';
      await this.db.query(`update orders set status = 'REJECTED', cancel_reason = $2, updated_at = now() where id = $1`, [orderId, reason]);
      await audit(this.db, session.customerRef, 'order.rejected', { orderId, reason });
      // Only a definite refusal proves no hold was placed. After anything else (timeout, lost response) the hold
      // may exist without its id: it is found by the order's reference and released, or queued until it is.
      const definite = err instanceof CoreBankingError && err.code !== 'UNAVAILABLE';
      if (config.balanceMode === 'block' && !definite) await this.exchange.releaseHoldsByRef(`order:${orderId}`);
      const rejected = (await loadOrder(this.db, orderId))!;
      throw unprocessable(reason, reason === 'INSUFFICIENT_BALANCE' ? 'insufficient balance' : 'core banking unavailable', {
        order: orderView(rejected, config),
      });
    }

    const status = open ? 'OPEN' : 'QUEUED';
    const moved = await tx(this.db, async (client) => {
      const res = await client.query(`update orders set status = $2, hold_id = $3, updated_at = now() where id = $1 and status = 'NEW'`, [orderId, status, holdId]);
      if (res.rowCount === 1) {
        await appendEvent(client, {
          type: 'OrderAccepted', aggregateType: 'order', aggregateId: orderId, pair: pair.symbol, correlationId: idempotencyKey, configVersion: version,
          payload: { source: 'CUSTOMER', type: market ? 'MARKET' : 'LIMIT', side: body.side, price: formatPrice(price), qty: qty.toString(), validity, status },
        });
      }
      return res;
    });
    if (moved.rowCount !== 1) {
      // Rejected meanwhile (e.g. a restart treated the entry as interrupted): give the hold back.
      if (holdId) await this.exchange.releaseHold(holdId);
      throw new ApiError(503, 'ENTRY_INTERRUPTED', 'order entry was interrupted, please try again');
    }
    await audit(this.db, session.customerRef, 'order.placed', { orderId, pair: pair.symbol, type: market ? 'MARKET' : 'LIMIT', side: body.side, qty: body.qty, price: formatPrice(price), validity, status });

    if (status === 'OPEN') await this.exchange.submit(orderId, pair.symbol);
    return { order: orderView((await loadOrder(this.db, orderId))!, config), replayed: false };
  }

  private async replay(prior: { id: string; request_hash: string }, requestHash: string) {
    if (prior.request_hash !== requestHash) throw conflict('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was used for a different order');
    const row = (await loadOrder(this.db, prior.id)) as OrderRow;
    const view = orderView(row, this.config.get().data);
    if (row.status === 'REJECTED') throw unprocessable(row.cancel_reason ?? 'REJECTED', 'order was rejected', { order: view });
    return { order: view, replayed: true };
  }

  private async validatePriceAndQty(config: BankConfig, body: QuoteRequest) {
    const pair = findPair(config, body.pair);
    if (!pair || !pair.enabled) throw badRequest('UNKNOWN_PAIR', `pair ${body.pair} is not available`);
    const qty = parseOr(body.qty, pair.baseDecimals, 'INVALID_QTY', `quantity must have at most ${pair.baseDecimals} decimals`);
    if (qty < parseDecimal(pair.minQty, pair.baseDecimals)) throw badRequest('QTY_TOO_SMALL', `minimum quantity is ${pair.minQty}`);
    const price = body.type === 'MARKET' ? this.marketProtection(config, pair, body.side) : parseOr(body.price!, 8, 'INVALID_PRICE', 'price has too many decimals');
    const tick = parsePrice(pair.tickSize);
    if (price <= 0n || price % tick !== 0n) throw badRequest('INVALID_PRICE', `price must be a positive multiple of ${pair.tickSize}`);
    await this.checkPriceBand(pair, price);
    return { pair, qty, price };
  }

  /**
   * A market order trades within the protection price the customer confirmed. If the protection the bank would give
   * now is worse for them (higher to buy, lower to sell), the order is refused so they can confirm the new one; if it
   * is better, the better one is used.
   */
  private bindProtection(pair: PairConfig, body: PlaceOrderRequest, current: bigint): bigint {
    const confirmed = parseOr(body.protectionPrice ?? '', 8, 'PROTECTION_PRICE_REQUIRED', 'the confirmed protection price is required for a market order');
    const worse = body.side === 'BUY' ? current > confirmed : current < confirmed;
    if (worse) {
      throw new ApiError(409, 'PROTECTION_PRICE_CHANGED', 'the price moved against you since you confirmed; review the new protection price', {
        confirmed: formatPrice(confirmed),
        protectionPrice: formatPrice(current),
      });
    }
    return current;
  }

  /** The protection price a market order would get now; refused without a live LP price. */
  private marketProtection(config: BankConfig, pair: PairConfig, side: Side): bigint {
    if (!config.marketOrders.enabled) throw unprocessable('MARKET_ORDERS_DISABLED', 'market orders are not offered');
    const lp = this.prices.fresh(pair.symbol);
    if (!lp) throw new ApiError(503, 'PRICE_PROTECTION_UNAVAILABLE', 'no live price to protect a market order; place a limit order');
    return protectionPrice(pair, side, lp, config.marketOrders.maxSlippageBps);
  }

  private async checkPriceBand(pair: PairConfig, price: bigint) {
    let ref: bigint;
    try {
      ref = parsePrice((await this.core.getReferenceRate(pair.symbol)).rate);
    } catch {
      throw new ApiError(503, 'REFERENCE_RATE_UNAVAILABLE', `no reference rate for ${pair.symbol}`);
    }
    const band = parsePrice(pair.priceBandPct); // percent, PRICE_SCALE units
    const diff = price > ref ? price - ref : ref - price;
    // diff / ref × 100 > bandPct  ⇔  diff × 100 × SCALE > band × ref
    if (diff * 100n * 10n ** 8n > band * ref) {
      throw unprocessable('PRICE_OUT_OF_BAND', `price must be within ±${pair.priceBandPct}% of the reference rate`);
    }
  }

  private expiry(config: BankConfig, body: PlaceOrderRequest, now: Date): Date {
    const cap = new Date(now.getTime() + config.validity.maxValidityDays * DAY_MS);
    if (body.validity === 'DAY') return currentOrNextSessionClose(now, config.tradingHours);
    if (body.validity === 'GTC') return cap;
    if (!body.expiresAt) throw badRequest('EXPIRES_AT_REQUIRED', 'expiresAt is required for GTD orders');
    const at = new Date(body.expiresAt);
    if (at <= now) throw badRequest('INVALID_EXPIRY', 'expiresAt must be in the future');
    if (at > cap) throw badRequest('INVALID_EXPIRY', `orders can be valid for at most ${config.validity.maxValidityDays} days`);
    return at;
  }

  private checkOrderLimit(config: BankConfig, session: Session, notional: bigint, pair: PairConfig) {
    const limits = config.limits.segments[session.segment] ?? config.limits.default;
    if (notional > parseDecimal(limits.maxOrderNotional, pair.quoteDecimals)) {
      throw unprocessable('ORDER_LIMIT_EXCEEDED', `order value exceeds the limit of ${limits.maxOrderNotional} ${pair.quote}`);
    }
  }
}

function parseOr(value: string, decimals: number, code: string, message: string) {
  try {
    return parseDecimal(value, decimals);
  } catch {
    throw badRequest(code, message);
  }
}

function pickAccount(accounts: CoreAccount[], currency: string, id?: string): CoreAccount {
  const acc = id ? accounts.find((a) => a.id === id) : accounts.find((a) => a.currency === currency);
  if (!acc) throw unprocessable('ACCOUNT_NOT_FOUND', `no ${currency} account${id ? ` ${id}` : ''} for this customer`);
  if (acc.currency !== currency) throw badRequest('ACCOUNT_CURRENCY_MISMATCH', `account ${acc.id} is not a ${currency} account`);
  return acc;
}
