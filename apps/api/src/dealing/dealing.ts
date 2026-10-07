import { findPair, formatDecimal, formatPrice, isMarketOpen, parseDecimal, parsePrice, taxRates, type BankConfig, type PairConfig } from '@p2p/shared';
import { priceSide, pricingParams, withoutCommission } from '@p2p/pricing';
import { CoreBankingError, type CoreAccount, type CoreBankingAdapter } from '@p2p/core-adapter';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { tx, type Db } from '../db/pool.js';
import { reserveDailyLimit } from '../limits.js';
import type { Session } from '../auth.js';
import type { ConfigService } from '../config-service.js';
import type { EventBus } from '../events.js';
import type { SettlementOptions } from '../settlement.js';
import { ApiError, badRequest, conflict, notFound, unprocessable } from '../errors.js';
import { audit } from '../audit.js';
import { segmentRates, type PriceEngine } from './price-engine.js';
import type { PositionKeeper } from './positions.js';
import { appendEvent } from '../event-store.js';
import { haltReason } from '../order-entry.js';

export const BankQuoteRequestSchema = z.object({
  pair: z.string(),
  side: z.enum(['BUY', 'SELL']),
  qty: z.string().regex(/^\d+(\.\d+)?$/),
});
export const BankDealRequestSchema = z.object({ quoteId: z.string().uuid() });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The customer's deals with the bank: a firm quote at the segment rate (valid a few seconds), then
 * execution as one core banking FX transaction and a position update (with auto-hedge).
 */
export class DealingService {
  constructor(
    private readonly db: Db,
    private readonly core: CoreBankingAdapter,
    private readonly config: ConfigService,
    private readonly prices: PriceEngine,
    private readonly positions: PositionKeeper,
    private readonly events: EventBus,
    private readonly clock: () => Date,
    private readonly log: FastifyBaseLogger,
    /** Overrides `settlement` from the bank configuration (tests). */
    private readonly settlementOverride?: SettlementOptions,
  ) {}

  /** The customer's segment rates, for the bank row on the board. */
  async rates(session: Session, pairSymbol: string) {
    const { pair, config } = this.pair(pairSymbol, 'view');
    const agg = await this.prices.current(pair.symbol);
    const r = segmentRates(config, pair, agg, session.segment);
    return { pair: pair.symbol, buy: formatPrice(r.buy), sell: formatPrice(r.sell), at: agg.at.toISOString() };
  }

  async quote(session: Session, body: z.infer<typeof BankQuoteRequestSchema>) {
    const { pair, config, version } = this.pair(body.pair, 'trade');
    const now = this.clock();
    if (!isMarketOpen(now, config.tradingHours)) throw unprocessable('MARKET_CLOSED', 'the market is closed');
    let qty: bigint;
    try {
      qty = parseDecimal(body.qty, pair.baseDecimals);
    } catch {
      throw badRequest('INVALID_QTY', `quantity must have at most ${pair.baseDecimals} decimals`);
    }
    if (qty < parseDecimal(pair.minQty, pair.baseDecimals)) throw badRequest('QTY_TOO_SMALL', `minimum quantity is ${pair.minQty}`);
    const max = config.dealing.maxDealQty[pair.base];
    if (max && qty > parseDecimal(max, pair.baseDecimals)) throw unprocessable('DEAL_TOO_LARGE', `the bank deals up to ${max} ${pair.base} at once`);

    const agg = await this.prices.current(pair.symbol);
    const r = segmentRates(config, pair, agg, session.segment);
    const rate = body.side === 'BUY' ? r.buy : r.sell;
    const lpRate = body.side === 'BUY' ? agg.ask : agg.bid;
    const s = priceSide(qty, rate, withoutCommission(pricingParams(config, pair, body.side)));
    const limits = config.limits.segments[session.segment] ?? config.limits.default;
    if (s.notional > parseDecimal(limits.maxOrderNotional, pair.quoteDecimals)) {
      throw unprocessable('ORDER_LIMIT_EXCEEDED', `deal value exceeds the limit of ${limits.maxOrderNotional} ${pair.quote}`);
    }
    // The customer buys: the bank sells (its position goes down), and the other way round.
    if (!this.positions.allows(pair.symbol, body.side === 'BUY' ? -qty : qty)) {
      throw unprocessable('INVENTORY_LIMIT', 'the bank cannot quote this side right now, try the board');
    }
    const expiresAt = new Date(now.getTime() + config.dealing.quoteTtlSeconds * 1000);
    const { rows } = await this.db.query(
      `insert into bank_quotes (customer_id, pair, side, qty, rate, lp_rate, segment, margin_pips, notional, tax, total, status, expires_at, config_version)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'OPEN', $12, $13) returning *`,
      [session.customerId, pair.symbol, body.side, qty, formatPrice(rate), formatPrice(lpRate), session.segment,
        body.side === 'BUY' ? r.buyPips : r.sellPips, s.notional, s.tax, s.total, expiresAt, version],
    );
    return quoteView(rows[0], pair, taxRates(config, pair)[body.side === 'BUY' ? 'buyRate' : 'sellRate']);
  }

  async execute(session: Session, quoteId: string) {
    const now = this.clock();
    const { rows: found } = await this.db.query('select * from bank_quotes where id = $1 and customer_id = $2', [quoteId, session.customerId]);
    const quote = found[0];
    if (!quote) throw notFound('quote not found');
    if (quote.status === 'EXECUTED') return this.executed(quote.id);
    if (new Date(quote.expires_at) <= now) throw new ApiError(410, 'QUOTE_EXPIRED', 'the quote has expired, ask for a new one');
    // Everything that can fail without side effects happens before the quote is used up.
    const { pair, config } = this.pair(quote.pair, 'trade');
    const accounts = await this.core.getAccounts(session.customerRef);
    const fx = pick(accounts, pair.base);
    const tl = pick(accounts, pair.quote);
    const margin = marginOf(pair, BigInt(quote.qty), parsePrice(quote.rate), parsePrice(quote.lp_rate));
    const delta = quote.side === 'BUY' ? -BigInt(quote.qty) : BigInt(quote.qty);
    // The deal is a principal execution: it reserves its place in the bank's inventory before anything is awaited,
    // through the same reservations the board's fills with the ladder and bot use.
    const reservation = this.positions.reserve(pair.symbol, delta);

    let deal;
    try {
      deal = await this.claim(quoteId, session, pair, config, margin, fx.id, tl.id, delta);
    } catch (err) {
      reservation.release();
      throw err;
    }
    if (!deal) {
      reservation.release();
      // Either a concurrent execute of the same quote won (it has the deal), or the quote ran out before the claim.
      const { rows } = await this.db.query('select status from bank_quotes where id = $1', [quoteId]);
      if (rows[0]?.status !== 'EXECUTED') throw new ApiError(410, 'QUOTE_EXPIRED', 'the quote has expired, ask for a new one');
      return this.executed(quoteId);
    }
    // Committed: the reservation becomes position (once), and auto-hedge looks at it (in the background).
    reservation.commit();
    // A deal core banking definitely rejects leaves the position again, inside settle (once, coordinated with reloads).
    const settled = await this.settle(deal, session.customerRef, pair);
    const view = dealView(settled, pair);
    if (settled.status === 'REJECTED') throw unprocessable('INSUFFICIENT_BALANCE', 'insufficient balance', { deal: view });
    // Only a deal that exists for the customer is announced (a rejected one is just the error above).
    await this.events.publish({ type: 'fill', customerId: session.customerId, fill: view }).catch((err) => this.log.warn({ err }, 'deal publish failed'));
    return view;
  }

  /**
   * Claiming the quote, the daily limit, the deal record and the bank's principal execution commit together: a used
   * quote always has its deal. Policy: a quote is valid until it is claimed. Validity is checked again at the claim,
   * with the clock read after the quote's row lock is taken (so neither a slow account lookup nor a wait on a
   * concurrent execute stretches it), not with the time the request arrived.
   */
  private claim(
    quoteId: string, session: Session, pair: PairConfig, config: BankConfig, margin: bigint, fxAccountId: string, tryAccountId: string, delta: bigint,
  ): Promise<Record<string, any> | undefined> {
    return tx(this.db, async (client) => {
      await client.query('select 1 from bank_quotes where id = $1 for update', [quoteId]);
      const claimedAt = this.clock();
      const { rows } = await client.query(
        `update bank_quotes set status = 'EXECUTED' where id = $1 and customer_id = $2 and status = 'OPEN' and expires_at > $3 returning *`,
        [quoteId, session.customerId, claimedAt],
      );
      const q = rows[0];
      if (!q) return undefined;
      await reserveDailyLimit(client, config, session, BigInt(q.notional), pair, claimedAt);
      const { rows: deals } = await client.query(
        `insert into bank_deals (quote_id, customer_id, pair, side, qty, rate, lp_rate, notional, tax, total, margin, fx_account_id, try_account_id, status)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'PENDING') returning *`,
        [q.id, session.customerId, q.pair, q.side, q.qty, q.rate, q.lp_rate, q.notional, q.tax, q.total, margin, fxAccountId, tryAccountId],
      );
      await audit(client, `customer:${session.customerId}`, 'dealing.deal', {
        dealId: deals[0].id, quoteId: q.id, pair: q.pair, side: q.side, rate: q.rate, claimedAt: claimedAt.toISOString(), expiresAt: new Date(q.expires_at).toISOString(),
      });
      const d = deals[0];
      const version = this.config.get().version;
      await client.query(
        `insert into principal_executions (channel, ref_id, pair, source, bank_side, qty, price, position_delta, reference, config_version)
         values ('DIRECT', $1, $2, 'BANK_DIRECT', $3, $4, $5, $6, $7, $8)`,
        [d.id, d.pair, d.side === 'BUY' ? 'SELL' : 'BUY', d.qty, d.rate, delta, JSON.stringify({ lpRate: d.lp_rate, quoteId }), version],
      );
      await appendEvent(client, {
        type: 'PrincipalExecutionCommitted', aggregateType: 'execution', aggregateId: d.id, correlationId: quoteId, configVersion: version,
        payload: { channel: 'DIRECT', source: 'BANK_DIRECT', pair: d.pair, bankSide: d.side === 'BUY' ? 'SELL' : 'BUY', qty: String(d.qty), price: String(d.rate), positionDelta: delta.toString() },
      });
      return d;
    });
  }

  /** Posts the deal to core banking: the bank sells to a buyer (BANK_SELL) or buys from a seller (BANK_BUY). */
  private async settle(deal: Record<string, any>, customerRef: string, pair: PairConfig) {
    const buyer = deal.side === 'BUY';
    let lastError = '';
    const policy = this.settlementOverride ?? this.config.get().data.settlement;
    for (let attempt = 1; attempt <= policy.attempts; attempt++) {
      if (attempt > 1) await sleep(policy.baseDelayMs * 2 ** (attempt - 2));
      try {
        const res = await this.core.postFxTransaction({
          leg: buyer ? 'BANK_SELL' : 'BANK_BUY',
          customerRef,
          fxAccountId: deal.fx_account_id,
          tryAccountId: deal.try_account_id,
          currency: pair.base,
          quoteCurrency: pair.quote,
          qty: BigInt(deal.qty),
          bookPrice: formatPrice(parsePrice(deal.rate)),
          effectivePrice: formatPrice(parsePrice(deal.rate)),
          notional: BigInt(deal.notional),
          commission: 0n,
          tax: BigInt(deal.tax),
          customerAmount: BigInt(deal.total),
          holdIds: [],
          idempotencyKey: `deal:${deal.id}`,
          reference: `BNK-${String(deal.seq).padStart(8, '0')}`,
        });
        return this.update(deal.id, 'SETTLED', null, res.txnRef, res.receiptRef);
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        this.log.warn({ dealId: deal.id, attempt, err: lastError }, 'bank deal posting failed');
        if (err instanceof CoreBankingError && err.code === 'INSUFFICIENT_FUNDS') return this.reject(deal, pair, lastError);
        if (err instanceof CoreBankingError && err.code !== 'UNAVAILABLE') break;
      }
    }
    // A timeout may still have been booked: ask core banking before calling it failed.
    try {
      const found = await this.core.findFxTransaction(`deal:${deal.id}`);
      if (found) return this.update(deal.id, 'SETTLED', null, found.txnRef, found.receiptRef);
    } catch (err) {
      lastError = `${lastError}; lookup failed: ${(err as Error).message}`;
    }
    await audit(this.db, 'system', 'dealing.failed', { dealId: deal.id, error: lastError });
    return this.update(deal.id, 'FAILED_NEEDS_REVIEW', lastError);
  }

  /**
   * Core banking definitely rejected the deal: it never happened. The status change and the position change are one
   * coordinated step (see PositionKeeper.beginReversal): the position moves back only if this call is the one that
   * moved the deal to REJECTED, so concurrent settlements of the same deal or a reload in between cannot apply it
   * twice.
   */
  private async reject(deal: Record<string, any>, pair: PairConfig, error: string) {
    const delta = deal.side === 'BUY' ? -BigInt(deal.qty) : BigInt(deal.qty);
    const reversal = this.positions.beginReversal(pair.symbol, delta);
    try {
      const { rows } = await this.db.query(
        `update bank_deals set status = 'REJECTED', last_error = $2, updated_at = now() where id = $1 and status <> 'REJECTED' returning *`,
        [deal.id, error],
      );
      if (rows[0]) {
        reversal.apply();
        return rows[0];
      }
      reversal.abandon();
      return (await this.db.query('select * from bank_deals where id = $1', [deal.id])).rows[0];
    } catch (err) {
      reversal.abandon();
      throw err;
    }
  }

  private async update(id: string, status: string, error: string | null, txnRef?: string, receiptRef?: string) {
    const { rows } = await this.db.query(
      `update bank_deals set status = $2, last_error = $3, core_txn_ref = coalesce($4, core_txn_ref), receipt_ref = coalesce($5, receipt_ref),
         updated_at = now() where id = $1 returning *`,
      [id, status, error, txnRef ?? null, receiptRef ?? null],
    );
    return rows[0];
  }

  /** A repeated execute: the quote's deal, so a client retry learns the outcome instead of an error. */
  private async executed(quoteId: string) {
    const { rows } = await this.db.query('select * from bank_deals where quote_id = $1', [quoteId]);
    const d = rows[0];
    if (!d) throw conflict('QUOTE_USED', 'this quote has already been executed');
    const { pair } = this.pair(d.pair);
    const view = dealView(d, pair);
    if (d.status === 'REJECTED') throw unprocessable('INSUFFICIENT_BALANCE', 'insufficient balance', { deal: view });
    return view;
  }

  /** Deals left PENDING by a restart or an interrupted request: posted again with their own key (safe to repeat). */
  async resumePending(olderThanMs = 0) {
    const { rows } = await this.db.query(
      `select d.*, c.customer_ref from bank_deals d join customers c on c.id = d.customer_id
        where d.status = 'PENDING' and d.updated_at <= now() - make_interval(secs => $1::double precision / 1000) order by d.seq`,
      [olderThanMs],
    );
    for (const d of rows) {
      const pair = findPair(this.config.get().data, d.pair);
      if (!pair) continue;
      await this.settle(d, d.customer_ref, pair).catch((err) => this.log.error({ err, dealId: d.id }, 'resuming deal failed'));
    }
  }

  /** Operations: posts a deal that failed with core banking down again (same idempotency key). */
  async retry(dealId: string, actor: string) {
    const { rows } = await this.db.query(
      `select d.*, c.customer_ref from bank_deals d join customers c on c.id = d.customer_id where d.id = $1`,
      [dealId],
    );
    const d = rows[0];
    if (!d) throw notFound('deal not found');
    if (d.status !== 'FAILED_NEEDS_REVIEW' && d.status !== 'PENDING') throw conflict('NOT_RETRYABLE', `deal is ${d.status}`);
    await audit(this.db, actor, 'dealing.retry', { dealId });
    const { pair } = this.pair(d.pair);
    const settled = await this.settle(d, d.customer_ref, pair);
    return dealView(settled, pair);
  }

  async recentDeals(limit = 20) {
    const c = this.config.get().data;
    const { rows } = await this.db.query(
      `select d.*, c.customer_ref, c.segment from bank_deals d join customers c on c.id = d.customer_id order by d.seq desc limit $1`,
      [limit],
    );
    return rows.map((r) => {
      const pair = findPair(c, r.pair)!;
      return { ...dealView(r, pair), customerRef: r.customer_ref, segment: r.segment, lpRate: formatPrice(parsePrice(r.lp_rate)), margin: formatDecimal(BigInt(r.margin), pair.quoteDecimals) };
    });
  }

  /** The pair, for showing rates (`view`), for a new quote or deal (`trade`: switches and halts apply) or for operations. */
  private pair(symbol: string, use: 'view' | 'trade' | 'ops' = 'ops') {
    const { data: config, version } = this.config.get();
    if (use !== 'ops' && !config.channels.bankDirect) throw new ApiError(404, 'DEALING_DISABLED', 'the bank does not quote right now');
    const halted = use === 'trade' && haltReason(config, symbol, 'bank');
    if (halted) throw new ApiError(503, 'TRADING_HALTED', halted);
    const pair = findPair(config, symbol);
    if (!pair || !pair.enabled) throw badRequest('UNKNOWN_PAIR', `pair ${symbol} is not available`);
    return { pair, config, version };
  }
}

/** The bank's margin: |deal rate − LP rate| × qty, quote minor units. */
function marginOf(pair: PairConfig, qty: bigint, rate: bigint, lpRate: bigint) {
  const diff = rate > lpRate ? rate - lpRate : lpRate - rate;
  return priceSide(qty, diff, { side: 'BUY', baseDecimals: pair.baseDecimals, quoteDecimals: pair.quoteDecimals, feeMode: 'PIPS', commissionPerUnit: 0n, commissionRate: 0n, taxRate: 0n, taxBase: 'book', rounding: 'HALF_UP' }).notional;
}

function pick(accounts: CoreAccount[], currency: string) {
  const acc = accounts.find((a) => a.currency === currency);
  if (!acc) throw unprocessable('ACCOUNT_NOT_FOUND', `no ${currency} account for this customer`);
  return acc;
}

function quoteView(r: Record<string, any>, pair: PairConfig, taxRate: string) {
  const money = (v: unknown) => formatDecimal(BigInt(v as string), pair.quoteDecimals);
  return {
    id: r.id,
    pair: r.pair,
    side: r.side,
    qty: formatDecimal(BigInt(r.qty), pair.baseDecimals),
    rate: formatPrice(parsePrice(r.rate)),
    notional: money(r.notional),
    taxRate,
    tax: money(r.tax),
    total: money(r.total),
    currency: pair.quote,
    expiresAt: new Date(r.expires_at).toISOString(),
  };
}

/** A bank deal in the customer's trade list, shaped like a P2P fill with the bank as counterparty. */
export function dealView(r: Record<string, any>, pair: PairConfig) {
  const money = (v: unknown) => formatDecimal(BigInt(v as string), pair.quoteDecimals);
  const rate = formatPrice(parsePrice(r.rate));
  return {
    id: r.id,
    pair: r.pair,
    side: r.side,
    orderId: null,
    liquidity: 'BANK' as const,
    counterparty: 'BANK' as const,
    qty: formatDecimal(BigInt(r.qty), pair.baseDecimals),
    bookPrice: rate,
    effectivePrice: rate,
    notional: money(r.notional),
    commission: formatDecimal(0n, pair.quoteDecimals),
    tax: money(r.tax),
    total: money(r.total),
    currency: pair.quote,
    settlementStatus: r.status,
    receiptRef: r.receipt_ref ?? undefined,
    createdAt: new Date(r.created_at).toISOString(),
  };
}
