import { formatPrice, parsePrice, findPair } from '@p2p/shared';
import { CoreBankingError, type CoreBankingAdapter, type FxLeg, type FxTransactionRequest } from '@p2p/core-adapter';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from './db/pool.js';
import { audit } from './audit.js';
import { ApiError, conflict } from './errors.js';
import type { ConfigService } from './config-service.js';

export interface SettlementOptions {
  /** Attempts per leg before the fill is sent to operations review. */
  attempts: number;
  /** Backoff before attempt n is baseDelayMs × 2^(n−2). */
  baseDelayMs: number;
}

export type SettlementOutcome = 'SETTLED' | 'FAILED_NEEDS_REVIEW' | 'UNKNOWN_OUTCOME';

const LEGS: FxLeg[] = ['BANK_BUY', 'BANK_SELL'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How one leg ended: posted, definitely not posted, or unknown (timeouts and the lookup failed too). */
type LegResult = { ok: true; txnRef: string; receiptRef: string } | { ok: false; unknown: boolean; error: string };

/**
 * Settles a fill as two bank FX transactions in core banking:
 *   BANK_BUY  — the bank buys the FX from the seller
 *   BANK_SELL — the bank sells the FX to the buyer
 * Each leg has a deterministic idempotency key, so retries and restarts are safe.
 *
 * A timeout or lost response is not a failure: the posting may have been booked. After the
 * attempts run out the leg is looked up by its key; only a leg core banking confirms it does not
 * have is a failure. If the lookup fails too, the leg is UNKNOWN_OUTCOME: nothing is reversed and
 * no new key is ever issued for it until a lookup settles the question.
 * A leg that definitely failed reverses any posted leg and sends the fill to FAILED_NEEDS_REVIEW.
 */
export class SettlementService {
  constructor(
    private readonly db: Db,
    private readonly core: CoreBankingAdapter,
    private readonly config: ConfigService,
    private readonly log: FastifyBaseLogger,
    /** Overrides `settlement` from the bank configuration (tests). */
    private readonly override?: SettlementOptions,
  ) {}

  private get opts(): SettlementOptions {
    return this.override ?? this.config.get().data.settlement;
  }

  static idempotencyKey(fillId: string, leg: FxLeg, round = 0) {
    return round === 0 ? `fill:${fillId}:${leg}` : `fill:${fillId}:${leg}:r${round}`;
  }

  async settle(fillId: string): Promise<SettlementOutcome> {
    const fill = await this.loadFill(fillId);
    const { rows: legs } = await this.db.query('select * from settlements where fill_id = $1', [fillId]);

    for (const leg of LEGS) {
      const s = legs.find((l) => l.leg === leg);
      if (!s || s.status !== 'PENDING') continue;
      const res = await this.post(s, this.request(fill, leg, s.idempotency_key, s.hold_ids));
      if (res.ok) continue;
      if (res.unknown) {
        await this.db.query(`update settlements set status = 'UNKNOWN_OUTCOME', last_error = $2, updated_at = now() where id = $1`, [s.id, res.error]);
        await audit(this.db, 'system', 'settlement.unknown', { fillId, leg, error: res.error });
        this.log.error({ fillId, leg, error: res.error }, 'settlement outcome unknown: needs a lookup before anything is re-sent');
        return 'UNKNOWN_OUTCOME';
      }
      await this.failFill(fillId, leg, res.error);
      return 'FAILED_NEEDS_REVIEW';
    }
    return 'SETTLED';
  }

  /** Posts one leg with retries on the same key, then resolves an unclear ending with a lookup. */
  private async post(s: Record<string, any>, req: FxTransactionRequest): Promise<LegResult> {
    let lastError = '';
    let unclear = false;
    for (let attempt = 1; attempt <= this.opts.attempts; attempt++) {
      if (attempt > 1) await sleep(this.opts.baseDelayMs * 2 ** (attempt - 2));
      try {
        const res = await this.core.postFxTransaction(req);
        await this.markSettled(s.id, res.txnRef, res.receiptRef);
        return { ok: true, ...res };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        await this.db.query('update settlements set attempts = attempts + 1, last_error = $2, updated_at = now() where id = $1', [s.id, lastError]);
        this.log.warn({ fillId: s.fill_id, leg: s.leg, attempt, err: lastError }, 'settlement leg failed');
        // Business rejections are definite and will not succeed on retry.
        if (err instanceof CoreBankingError && err.code !== 'UNAVAILABLE') return { ok: false, unknown: false, error: lastError };
        unclear = true;
      }
    }
    if (!unclear) return { ok: false, unknown: false, error: lastError };
    return this.lookup(s, lastError);
  }

  /** Asks core banking whether the leg's current key was booked. */
  private async lookup(s: Record<string, any>, lastError: string): Promise<LegResult> {
    try {
      const found = await this.core.findFxTransaction(s.idempotency_key);
      if (found) {
        await this.markSettled(s.id, found.txnRef, found.receiptRef);
        this.log.warn({ fillId: s.fill_id, leg: s.leg }, 'settlement leg was booked although the response was lost');
        return { ok: true, ...found };
      }
      return { ok: false, unknown: false, error: lastError };
    } catch (err) {
      return { ok: false, unknown: true, error: `${lastError}; lookup failed: ${(err as Error).message}` };
    }
  }

  private async markSettled(id: string, txnRef: string, receiptRef: string) {
    await this.db.query(
      `update settlements set status = 'SETTLED', core_txn_ref = $2, receipt_ref = $3, attempts = attempts + 1,
         last_error = null, updated_at = now() where id = $1`,
      [id, txnRef, receiptRef],
    );
  }

  /**
   * Operations: settles a fill that needs review. A failed or unknown leg is first looked up by its
   * current key; if core banking has it, it is marked settled and never re-sent. Only a leg core banking
   * confirms it does not have is posted again (same key), and only a leg proven reversed gets a new key.
   */
  async retry(fillId: string, actor: string): Promise<SettlementOutcome> {
    const { rows } = await this.db.query(
      `select * from settlements where fill_id = $1 and status in ('FAILED_NEEDS_REVIEW', 'UNKNOWN_OUTCOME', 'REVERSED') order by leg`,
      [fillId],
    );
    if (!rows.length) throw conflict('NOTHING_TO_RETRY', 'this fill has no failed, unknown or reversed leg');
    for (const r of rows) {
      if (r.status === 'REVERSED') {
        const round = r.retry_round + 1;
        await this.db.query(
          `update settlements set status = 'PENDING', retry_round = $2, idempotency_key = $3, attempts = 0,
             core_txn_ref = null, receipt_ref = null, reversal_ref = null, updated_at = now() where id = $1 and status = 'REVERSED'`,
          [r.id, round, SettlementService.idempotencyKey(fillId, r.leg, round)],
        );
        continue;
      }
      let found;
      try {
        found = await this.core.findFxTransaction(r.idempotency_key);
      } catch (err) {
        throw new ApiError(503, 'OUTCOME_UNKNOWN', `core banking lookup failed for ${r.leg}, nothing was re-sent: ${(err as Error).message}`);
      }
      if (found) await this.markSettled(r.id, found.txnRef, found.receiptRef);
      else await this.db.query(`update settlements set status = 'PENDING', attempts = 0, updated_at = now() where id = $1 and status = $2`, [r.id, r.status]);
    }
    await audit(this.db, actor, 'settlement.retry', { fillId, legs: rows.map((r) => r.leg) });
    return this.settle(fillId);
  }

  /** Settles fills left PENDING by a restart or an interrupted settlement (same keys, so it is safe to repeat). */
  async resumePending(olderThanMs = 0): Promise<void> {
    const { rows } = await this.db.query(
      `select distinct s.fill_id, f.seq from settlements s join fills f on f.id = s.fill_id
        where s.status = 'PENDING' and s.updated_at <= now() - make_interval(secs => $1::double precision / 1000) order by f.seq`,
      [olderThanMs],
    );
    for (const r of rows) {
      await this.settle(r.fill_id).catch((err) => this.log.error({ err, fillId: r.fill_id }, 'resuming settlement failed'));
    }
  }

  private async failFill(fillId: string, failedLeg: FxLeg, error: string) {
    await this.db.query(
      `update settlements set status = 'FAILED_NEEDS_REVIEW', last_error = $3, updated_at = now() where fill_id = $1 and leg = $2`,
      [fillId, failedLeg, error],
    );
    // A leg not attempted yet waits for the operations retry together with the failed one.
    await this.db.query(
      `update settlements set status = 'FAILED_NEEDS_REVIEW', last_error = 'not attempted: other leg failed', updated_at = now()
        where fill_id = $1 and status = 'PENDING'`,
      [fillId],
    );
    const { rows } = await this.db.query(`select * from settlements where fill_id = $1 and status = 'SETTLED'`, [fillId]);
    for (const s of rows) {
      try {
        const { reversalRef } = await this.core.reverseFxTransaction(s.core_txn_ref, `reverse:${s.idempotency_key}`);
        await this.db.query(`update settlements set status = 'REVERSED', reversal_ref = $2, updated_at = now() where id = $1`, [s.id, reversalRef]);
      } catch (err) {
        // Leave it SETTLED but flag it: operations must reverse it by hand.
        await this.db.query(`update settlements set last_error = $2, updated_at = now() where id = $1`, [
          s.id,
          `reversal failed: ${(err as Error).message}`,
        ]);
        this.log.error({ fillId, leg: s.leg, err }, 'reversal failed');
      }
    }
    await audit(this.db, 'system', 'settlement.failed', { fillId, failedLeg, error });
    this.log.error({ fillId, failedLeg, error }, 'fill needs operations review');
  }

  private async loadFill(fillId: string) {
    const { rows } = await this.db.query(
      `select f.*, b.customer_id as buyer_id, bc.customer_ref as buyer_ref, b.fx_account_id as buyer_fx, b.try_account_id as buyer_try,
              s.customer_id as seller_id, sc.customer_ref as seller_ref, s.fx_account_id as seller_fx, s.try_account_id as seller_try
         from fills f
         join orders b on b.id = f.buy_order_id join customers bc on bc.id = b.customer_id
         join orders s on s.id = f.sell_order_id join customers sc on sc.id = s.customer_id
        where f.id = $1`,
      [fillId],
    );
    return rows[0];
  }

  private request(fill: Record<string, any>, leg: FxLeg, idempotencyKey: string, holdIds: string[]): FxTransactionRequest {
    const pair = findPair(this.config.get().data, fill.pair);
    const base = pair?.base ?? fill.pair.slice(0, 3);
    const quote = pair?.quote ?? fill.pair.slice(3);
    const buyer = leg === 'BANK_SELL';
    return {
      leg,
      customerRef: buyer ? fill.buyer_ref : fill.seller_ref,
      fxAccountId: buyer ? fill.buyer_fx : fill.seller_fx,
      tryAccountId: buyer ? fill.buyer_try : fill.seller_try,
      currency: base,
      quoteCurrency: quote,
      qty: fill.qty,
      bookPrice: formatPrice(parsePrice(fill.book_price)),
      effectivePrice: formatPrice(parsePrice(buyer ? fill.buyer_effective_price : fill.seller_effective_price)),
      notional: fill.notional,
      commission: buyer ? fill.buyer_commission : fill.seller_commission,
      tax: buyer ? fill.buyer_tax : fill.seller_tax,
      customerAmount: buyer ? fill.buyer_total : fill.seller_total,
      holdIds,
      idempotencyKey,
      reference: `P2P-${String(fill.seq).padStart(8, '0')}`,
    };
  }
}
