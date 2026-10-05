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

/**
 * SETTLED: both legs booked. IN_PROGRESS: another worker holds the fill right now. REVERSAL_PENDING: a leg
 * is being reversed and core banking has not confirmed the reversal yet.
 */
export type SettlementOutcome = 'SETTLED' | 'FAILED_NEEDS_REVIEW' | 'UNKNOWN_OUTCOME' | 'REVERSAL_PENDING' | 'IN_PROGRESS';

/** Booking order: the bank buys from the seller before it sells to the buyer, and never the other way round. */
const LEGS: FxLeg[] = ['BANK_BUY', 'BANK_SELL'];
/** Advisory lock namespace for per-fill settlement (second key: hashtext(fill id)). */
const FILL_LOCK = 727277;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How one leg ended: posted, definitely not posted, or unknown (timeouts and the lookup failed too). */
type LegResult = { ok: true; txnRef: string; receiptRef: string } | { ok: false; unknown: boolean; error: string };

/**
 * Settles a fill as two bank FX transactions in core banking:
 *   BANK_BUY  — the bank buys the FX from the seller
 *   BANK_SELL — the bank sells the FX to the buyer
 * Each leg has a deterministic idempotency key, so retries and restarts are safe.
 *
 * The legs form one state machine per fill, run by one worker at a time (a Postgres advisory lock, so
 * matching, the scheduler, startup recovery and operations on any instance never interleave):
 * - Legs are worked strictly in order. A leg that is not SETTLED stops everything after it: BANK_SELL is
 *   never sent while BANK_BUY is unknown, failed or being reversed.
 * - A timeout or lost response is not a failure: the posting may have been booked. After the attempts run out
 *   the leg is looked up by its key; only a leg core banking confirms it does not have is a failure. If the
 *   lookup fails too, the leg is UNKNOWN_OUTCOME and the next run looks it up again (same key) before
 *   anything else happens.
 * - A leg that definitely failed sends the fill to FAILED_NEEDS_REVIEW and reverses the legs already booked.
 *   Each reversal is recorded (REVERSAL_PENDING) before it is sent and stays so until core banking confirms it
 *   under the same reversal key; until then nothing on the fill is re-sent.
 * - The outcome is read back from the stored legs, never assumed.
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

  static reversalKey(legIdempotencyKey: string) {
    return `reverse:${legIdempotencyKey}`;
  }

  /** Runs `fn` holding the fill's settlement lock; undefined if another worker holds it. */
  private async locked<T>(fillId: string, fn: () => Promise<T>): Promise<T | undefined> {
    const client = await this.db.connect();
    try {
      const { rows } = await client.query('select pg_try_advisory_lock($1, hashtext($2)) as ok', [FILL_LOCK, fillId]);
      if (!rows[0].ok) return undefined;
      try {
        return await fn();
      } finally {
        await client.query('select pg_advisory_unlock($1, hashtext($2))', [FILL_LOCK, fillId]);
      }
    } finally {
      client.release();
    }
  }

  async settle(fillId: string): Promise<SettlementOutcome> {
    return (await this.locked(fillId, () => this.run(fillId))) ?? 'IN_PROGRESS';
  }

  /** One pass of the fill's state machine. Call only while holding the fill's lock. */
  private async run(fillId: string): Promise<SettlementOutcome> {
    if (!(await this.settleReversals(fillId))) return 'REVERSAL_PENDING';
    const fill = await this.loadFill(fillId);

    for (const leg of LEGS) {
      const s = await this.loadLeg(fillId, leg);
      if (!s) throw new Error(`fill ${fillId} has no ${leg} leg`);
      if (s.status === 'SETTLED') continue;
      // Failed and reversed legs wait for operations; nothing after them may run.
      if (s.status !== 'PENDING' && s.status !== 'UNKNOWN_OUTCOME') break;

      let res: LegResult;
      if (s.status === 'UNKNOWN_OUTCOME') {
        res = await this.lookup(s, s.last_error ?? 'outcome unknown');
        // Core banking confirms it does not have the leg: it is sent again under the same key.
        if (!res.ok && !res.unknown) {
          await this.db.query(`update settlements set status = 'PENDING', updated_at = now() where id = $1 and status = 'UNKNOWN_OUTCOME'`, [s.id]);
          res = await this.post(s, this.request(fill, leg, s.idempotency_key, s.hold_ids));
        }
      } else {
        res = await this.post(s, this.request(fill, leg, s.idempotency_key, s.hold_ids));
      }
      if (res.ok) continue;
      if (res.unknown) {
        await this.db.query(`update settlements set status = 'UNKNOWN_OUTCOME', last_error = $2, updated_at = now() where id = $1`, [s.id, res.error]);
        await audit(this.db, 'system', 'settlement.unknown', { fillId, leg, error: res.error });
        this.log.error({ fillId, leg, error: res.error }, 'settlement outcome unknown: needs a lookup before anything is re-sent');
        break;
      }
      await this.failFill(fillId, leg, res.error);
      break;
    }
    return this.outcome(fillId);
  }

  /** The fill's outcome as the stored legs say it is. */
  private async outcome(fillId: string): Promise<SettlementOutcome> {
    const { rows } = await this.db.query('select status from settlements where fill_id = $1', [fillId]);
    const st = new Set(rows.map((r) => r.status as string));
    if (rows.length === LEGS.length && st.size === 1 && st.has('SETTLED')) return 'SETTLED';
    if (st.has('REVERSAL_PENDING')) return 'REVERSAL_PENDING';
    if (st.has('FAILED_NEEDS_REVIEW') || st.has('REVERSED')) return 'FAILED_NEEDS_REVIEW';
    if (st.has('UNKNOWN_OUTCOME')) return 'UNKNOWN_OUTCOME';
    return 'IN_PROGRESS';
  }

  private async loadLeg(fillId: string, leg: FxLeg) {
    const { rows } = await this.db.query('select * from settlements where fill_id = $1 and leg = $2', [fillId, leg]);
    return rows[0] as Record<string, any> | undefined;
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
   * Operations: settles a fill that needs review. Reversals still in flight are confirmed first; while one is
   * not confirmed nothing is re-sent. A failed or unknown leg is then looked up by its current key; if core
   * banking has it, it is marked settled and never re-sent. Only a leg core banking confirms it does not have
   * is posted again (same key), and only a leg confirmed reversed gets a new key.
   */
  async retry(fillId: string, actor: string): Promise<SettlementOutcome> {
    const result = await this.locked(fillId, async () => {
      if (!(await this.settleReversals(fillId))) {
        throw conflict('REVERSAL_PENDING', 'a reversal of this fill is not confirmed by core banking yet; nothing was re-sent');
      }
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
      return this.run(fillId);
    });
    if (!result) throw conflict('SETTLEMENT_IN_PROGRESS', 'this fill is being settled right now, try again shortly');
    return result;
  }

  /**
   * Resumes fills a restart, a timeout or an interrupted settlement left open: PENDING legs, legs whose outcome
   * is unknown and reversals not confirmed yet (same keys throughout, so it is safe to repeat).
   */
  async resumePending(olderThanMs = 0): Promise<void> {
    const { rows } = await this.db.query(
      `select distinct s.fill_id, f.seq from settlements s join fills f on f.id = s.fill_id
        where s.status in ('PENDING', 'UNKNOWN_OUTCOME', 'REVERSAL_PENDING')
          and s.updated_at <= now() - make_interval(secs => $1::double precision / 1000) order by f.seq`,
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
    // The reversal intent is stored before anything is sent: a lost response or a crash leaves it pending, never SETTLED.
    await this.db.query(
      `update settlements set status = 'REVERSAL_PENDING', last_error = $2, updated_at = now() where fill_id = $1 and status = 'SETTLED'`,
      [fillId, `reversing: ${failedLeg} failed`],
    );
    await audit(this.db, 'system', 'settlement.failed', { fillId, failedLeg, error });
    this.log.error({ fillId, failedLeg, error }, 'fill needs operations review');
    await this.settleReversals(fillId);
  }

  /**
   * Sends (or re-sends, same reversal key) every pending reversal of the fill. True when none is left pending.
   * A reversal core banking definitely refuses leaves the leg booked (SETTLED) and flagged for operations.
   */
  private async settleReversals(fillId: string): Promise<boolean> {
    const { rows } = await this.db.query(`select * from settlements where fill_id = $1 and status = 'REVERSAL_PENDING'`, [fillId]);
    let clear = true;
    for (const s of rows) {
      try {
        const { reversalRef } = await this.core.reverseFxTransaction(s.core_txn_ref, SettlementService.reversalKey(s.idempotency_key));
        await this.db.query(`update settlements set status = 'REVERSED', reversal_ref = $2, last_error = null, updated_at = now() where id = $1`, [s.id, reversalRef]);
        await audit(this.db, 'system', 'settlement.reversed', { fillId, leg: s.leg, reversalRef });
      } catch (err) {
        const message = (err as Error).message;
        if (err instanceof CoreBankingError && err.code !== 'UNAVAILABLE') {
          // Definitely not reversed: the leg is still booked.
          await this.db.query(`update settlements set status = 'SETTLED', last_error = $2, updated_at = now() where id = $1`, [
            s.id,
            `reversal refused, leg stays booked: ${message}`,
          ]);
          await audit(this.db, 'system', 'settlement.reversal_refused', { fillId, leg: s.leg, error: message });
          this.log.error({ fillId, leg: s.leg, err }, 'reversal refused by core banking; the leg stays booked');
          continue;
        }
        clear = false;
        await this.db.query(`update settlements set last_error = $2, updated_at = now() where id = $1`, [s.id, `reversal outcome unknown: ${message}`]);
        this.log.error({ fillId, leg: s.leg, err }, 'reversal outcome unknown; retried with the same key before anything else happens');
      }
    }
    return clear;
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
