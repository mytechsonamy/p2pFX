import { createHash } from 'node:crypto';
import {
  currentOrNextSessionClose,
  findPair,
  isMarketOpen,
  parseDecimal,
  parsePrice,
  type BankConfig,
  type PairConfig,
  type PlaceOrderRequest,
  type QuoteRequest,
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

const DAY_MS = 86_400_000;

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
    private readonly clock: () => Date,
  ) {}

  /** Full breakdown for the confirmation screen. Same maths as the fill. */
  async quote(body: QuoteRequest) {
    const config = this.config.get().data;
    const { pair, qty, price } = await this.validatePriceAndQty(config, body);
    const params = pricingParams(config, pair, body.side);
    return toBreakdown(pair, priceSide(qty, price, params), params);
  }

  /**
   * `house`: the bank's own order (its market-making ladder). It pays no commission or tax to itself and is not
   * subject to customer segment limits.
   */
  async place(session: Session, body: PlaceOrderRequest, idempotencyKey: string | undefined, opts: { house?: boolean } = {}) {
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
    const { pair, qty, price } = await this.validatePriceAndQty(config, body);
    const params = opts.house ? { ...pricingParams(config, pair, body.side), commissionPerUnit: 0n, taxRate: 0n } : pricingParams(config, pair, body.side);
    const pricing = priceSide(qty, price, params);

    if (!config.validity.options.includes(body.validity)) {
      throw badRequest('VALIDITY_NOT_ALLOWED', `validity ${body.validity} is not offered`);
    }
    const expiresAt = this.expiry(config, body, now);
    const open = isMarketOpen(now, config.tradingHours);
    if (!open && config.tradingHours.outsideHours === 'reject') throw unprocessable('MARKET_CLOSED', 'the market is closed');

    if (!opts.house) this.checkOrderLimit(config, session, pricing.notional, pair);

    const accounts = await this.core.getAccounts(session.customerRef);
    const fxAccount = pickAccount(accounts, pair.base, body.fxAccountId);
    const tryAccount = pickAccount(accounts, pair.quote, body.tryAccountId);

    // The daily limit is checked and the order recorded in one transaction, under the customer's limit lock.
    const insert = await tx(this.db, async (client) => {
      if (!opts.house) await reserveDailyLimit(client, config, session, pricing.notional, pair, now);
      return client.query(
        `insert into orders (customer_id, pair, side, book_price, qty, validity, expires_at, fx_account_id, try_account_id,
           status, pricing, config_version, balance_mode, notional, idempotency_key, request_hash)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'NEW',$10,$11,$12,$13,$14,$15)
         on conflict (customer_id, idempotency_key) do nothing
         returning id`,
        [
          session.customerId, pair.symbol, body.side, body.price, qty, body.validity, expiresAt, fxAccount.id, tryAccount.id,
          toSnapshot(params), version, config.balanceMode, pricing.notional, idempotencyKey, requestHash,
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
      const rejected = (await loadOrder(this.db, orderId))!;
      throw unprocessable(reason, reason === 'INSUFFICIENT_BALANCE' ? 'insufficient balance' : 'core banking unavailable', {
        order: orderView(rejected, config),
      });
    }

    const status = open ? 'OPEN' : 'QUEUED';
    const moved = await this.db.query(`update orders set status = $2, hold_id = $3, updated_at = now() where id = $1 and status = 'NEW'`, [orderId, status, holdId]);
    if (moved.rowCount !== 1) {
      // Rejected meanwhile (e.g. a restart treated the entry as interrupted): give the hold back.
      if (holdId) await this.core.releaseHold(holdId).catch(() => {});
      throw new ApiError(503, 'ENTRY_INTERRUPTED', 'order entry was interrupted, please try again');
    }
    await audit(this.db, session.customerRef, 'order.placed', { orderId, pair: pair.symbol, side: body.side, qty: body.qty, price: body.price, validity: body.validity, status });

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
    const price = parseOr(body.price, 8, 'INVALID_PRICE', 'price has too many decimals');
    const tick = parsePrice(pair.tickSize);
    if (price <= 0n || price % tick !== 0n) throw badRequest('INVALID_PRICE', `price must be a positive multiple of ${pair.tickSize}`);
    await this.checkPriceBand(pair, price);
    return { pair, qty, price };
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
