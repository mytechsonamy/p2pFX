import { findPair, formatDecimal, localParts, parsePrice, zonedTime } from '@p2p/shared';
import type { CoreBankingAdapter, CoreFxTransactionRecord, FxLeg, LiquidityAdapter } from '@p2p/core-adapter';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from './db/pool.js';
import type { ConfigService } from './config-service.js';
import { audit } from './audit.js';
import { ApiError } from './errors.js';
import { SettlementService } from './settlement.js';

/**
 * Reconciliation: the platform's records against core banking and the LPs, for a time window.
 *
 * Platform → core banking: every settlement leg and bank deal created in the window is looked up by its idempotency
 * key. A settled one must be booked, not reversed, under the same txnRef and with the same amounts; a reversed one must
 * be reversed; a failed or rejected one must not be booked. Core banking → platform (when the adapter can list
 * postings): every posting in the window must carry a key the platform knows; a posting under an older retry round of a
 * fill must have been reversed. Hedges: every clip the platform counts as DONE must be at its LP with the same side,
 * quantity, trade reference and rate; a clip the platform counts as REJECTED must not be.
 *
 * Records still in flight past `openItemAfterMinutes` are open items. Nothing is changed: the run only reports.
 */

export type Severity = 'BREAK' | 'OPEN_ITEM';
export type BreakSource = 'SETTLEMENT' | 'BANK_DEAL' | 'HEDGE' | 'CORE';

export interface ReconBreak {
  severity: Severity;
  kind: string;
  source: BreakSource;
  ref: string;
  details: Record<string, unknown>;
}

export type ReconStatus = 'RUNNING' | 'CLEAN' | 'OPEN_ITEMS' | 'BREAKS' | 'FAILED';

/** A run left RUNNING longer than this (database time) was interrupted (process stopped) and is closed as FAILED. */
const STALE_RUN_HOURS = 6;
/** A scheduled run that failed is tried again after this long, at most MAX_DAILY_ATTEMPTS times per day. */
const DAILY_RETRY_MS = 30 * 60_000;
const MAX_DAILY_ATTEMPTS = 3;
/** Records created before the window that are still open (or changed in it) are looked at this far back. */
const CARRY_DAYS = 31;
/** A DONE hedge the LP does not find is a break only this soon after it was made (LP searches can be capped). */
const LP_SEARCH_HORIZON_MS = 24 * 3_600_000;
const FILL_KEY = /^fill:([0-9a-f-]{36}):(BANK_BUY|BANK_SELL)(?::r(\d+))?$/;
const DEAL_KEY = /^deal:([0-9a-f-]{36})$/;

const replacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

export class ReconciliationService {
  constructor(
    private readonly db: Db,
    private readonly core: CoreBankingAdapter,
    private readonly lp: LiquidityAdapter,
    private readonly config: ConfigService,
    private readonly clock: () => Date,
    private readonly log: FastifyBaseLogger,
  ) {}

  /**
   * Scheduler: starts today's run once `dailyAt` has passed and no scheduled run covers the window ending at it.
   * Returns the run id when one ran.
   */
  async runDailyIfDue(): Promise<string | undefined> {
    const c = this.config.get().data;
    if (!c.reconciliation.enabled) return undefined;
    const now = this.clock();
    const tz = c.tradingHours.timezone;
    const at = (d: Date) => {
      const p = localParts(d, tz);
      return zonedTime(p.year, p.month, p.day, c.reconciliation.dailyAt, tz);
    };
    // Today's run once its time has passed; before that, yesterday's (caught up if the service was down at the time).
    let due = at(now);
    if (now < due) due = at(new Date(now.getTime() - 24 * 3_600_000));
    if (now < due) return undefined;
    // A run interrupted by a stop or a crash is closed first, so it neither blocks the day nor counts as done.
    await this.closeStaleRuns();
    const { rows } = await this.db.query(
      `select status, started_at from recon_runs where trigger = 'SCHEDULED' and window_to = $1 order by started_at desc`,
      [due],
    );
    if (rows.some((r) => r.status !== 'FAILED')) return undefined;
    // A failed run is tried again later, a few times, not on every scheduler tick.
    if (rows.length >= MAX_DAILY_ATTEMPTS) return undefined;
    if (rows.length && Date.now() - new Date(rows[0].started_at).getTime() < DAILY_RETRY_MS) return undefined;
    const from = new Date(due.getTime() - c.reconciliation.lookbackHours * 3_600_000);
    const run = await this.run(from, due, 'SCHEDULED', 'system');
    if (run.status === 'FAILED' && rows.length + 1 >= MAX_DAILY_ATTEMPTS) {
      this.log.error({ windowTo: due, attempts: rows.length + 1 }, 'daily reconciliation failed every attempt; run it from operations');
    }
    return run.id;
  }

  private daily?: Promise<unknown>;

  /**
   * Scheduler: starts the daily run in the background (one at a time), so a long run does not hold up order expiry,
   * settlement recovery and the rest of the tick.
   */
  startDailyIfDue() {
    if (this.daily) return;
    this.daily = this.runDailyIfDue()
      .catch((err) => this.log.error({ err }, 'daily reconciliation failed'))
      .finally(() => (this.daily = undefined));
  }

  /** Resolves when no background daily run is in progress (tests, shutdown). */
  async idle() {
    await this.daily;
  }

  /** Runs a reconciliation of [from, to) and returns the run with its breaks. */
  async run(from: Date, to: Date, trigger: 'SCHEDULED' | 'MANUAL', actor: string) {
    if (!(from < to)) throw new ApiError(400, 'INVALID_RANGE', 'from must be before to');
    await this.closeStaleRuns();
    let id: string;
    try {
      const { rows } = await this.db.query(
        `insert into recon_runs (window_from, window_to, trigger, actor, status) values ($1, $2, $3, $4, 'RUNNING') returning id`,
        [from, to, trigger, actor],
      );
      id = rows[0].id;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new ApiError(409, 'RECONCILIATION_RUNNING', 'a reconciliation is already running');
      throw err;
    }
    try {
      const { breaks, summary, coreListing } = await this.check(from, to);
      const status: ReconStatus = breaks.some((b) => b.severity === 'BREAK') ? 'BREAKS' : breaks.length ? 'OPEN_ITEMS' : 'CLEAN';
      // The items and the result are written together: a run is either finished with all its items or failed.
      const client = await this.db.connect();
      try {
        await client.query('begin');
        for (let i = 0; i < breaks.length; i += 500) {
          const chunk = breaks.slice(i, i + 500);
          const values = chunk.map((_, j) => `($1, $${j * 5 + 2}, $${j * 5 + 3}, $${j * 5 + 4}, $${j * 5 + 5}, $${j * 5 + 6})`).join(', ');
          await client.query(
            `insert into recon_breaks (run_id, severity, kind, source, ref, details) values ${values}`,
            [id, ...chunk.flatMap((b) => [b.severity, b.kind, b.source, b.ref, JSON.stringify(b.details, replacer)])],
          );
        }
        await client.query(`update recon_runs set status = $2, core_listing = $3, summary = $4, finished_at = now() where id = $1`, [
          id,
          status,
          coreListing,
          JSON.stringify(summary, replacer),
        ]);
        await client.query('commit');
      } catch (err) {
        await client.query('rollback').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
      await audit(this.db, actor, 'reconciliation.run', { runId: id, trigger, from, to, status, breaks: summary.breaks, openItems: summary.openItems });
      if (status === 'BREAKS') this.log.error({ runId: id, breaks: summary.breaks, byKind: summary.byKind }, 'reconciliation found breaks');
      else if (status === 'OPEN_ITEMS') this.log.warn({ runId: id, openItems: summary.openItems }, 'reconciliation found open items');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.db.query(`update recon_runs set status = 'FAILED', error = $2, finished_at = now() where id = $1`, [id, message]);
      this.log.error({ err, runId: id }, 'reconciliation failed');
    }
    return this.get(id);
  }

  private async closeStaleRuns() {
    await this.db.query(
      `update recon_runs set status = 'FAILED', error = 'interrupted', finished_at = now()
        where status = 'RUNNING' and started_at < now() - make_interval(hours => $1)`,
      [STALE_RUN_HOURS],
    );
  }

  async get(id: string) {
    const { rows } = await this.db.query(`select * from recon_runs where id::text = $1`, [id]);
    if (!rows.length) throw new ApiError(404, 'NOT_FOUND', 'reconciliation run not found');
    const { rows: breaks } = await this.db.query(`select * from recon_breaks where run_id = $1 order by severity, kind, created_at`, [rows[0].id]);
    return { ...runView(rows[0]), items: breaks.map(breakView) };
  }

  async list(limit = 30) {
    const { rows } = await this.db.query(`select * from recon_runs order by started_at desc limit $1`, [Math.min(Math.max(limit, 1), 200)]);
    return rows.map(runView);
  }

  /** The last finished run (for readiness and the back office). */
  async latest() {
    const { rows } = await this.db.query(`select * from recon_runs where status <> 'RUNNING' order by started_at desc limit 1`);
    return rows.length ? runView(rows[0]) : undefined;
  }

  private async check(from: Date, to: Date) {
    const c = this.config.get().data;
    const openAfterMs = c.reconciliation.openItemAfterMinutes * 60_000;
    const now = Date.now();
    const breaks: ReconBreak[] = [];
    const add = (b: ReconBreak) => breaks.push(b);

    // Core banking's own list of postings in the window, by key, when the adapter offers one.
    let coreListing = false;
    const listed = new Map<string, CoreFxTransactionRecord>();
    let coreRecords: CoreFxTransactionRecord[] = [];
    if (this.core.listFxTransactions) {
      coreRecords = await this.core.listFxTransactions(from, to);
      for (const r of coreRecords) listed.set(r.idempotencyKey, r);
      coreListing = true;
    }
    /** The posting under this key: from the list, else asked for (a posting made after the window, a retry). */
    const lookup = async (key: string): Promise<CoreFxTransactionRecord | { txnRef: string; receiptRef: string; reversed?: undefined } | undefined> => {
      const hit = listed.get(key);
      if (hit) return hit;
      const found = await this.core.findFxTransaction(key);
      if (!found) return undefined;
      // A posting outside the listed window: read its details too when the adapter can list.
      if (this.core.listFxTransactions) {
        const at = new Date(found.postedAt);
        const around = await this.core.listFxTransactions(new Date(at.getTime() - 1000), new Date(at.getTime() + 1000));
        const exact = around.find((r) => r.idempotencyKey === key);
        if (exact) return exact;
      }
      return { txnRef: found.txnRef, receiptRef: found.receiptRef };
    };

    const carryFrom = new Date(from.getTime() - CARRY_DAYS * 24 * 3_600_000);
    /** Core postings already reported as a duplicate (found from both sides). */
    const duplicates = new Set<string>();

    // ---- settlement legs: of fills created in the window, and older ones still open or changed in the window ----
    // (a leg in flight at the previous cutoff is checked once it has an outcome, and reported while it has none)
    const { rows: legs } = await this.db.query(
      `select s.id, s.fill_id, s.leg, s.idempotency_key, s.status, s.core_txn_ref, s.retry_round, s.created_at, s.updated_at,
              f.pair, f.qty, f.buyer_commission, f.seller_commission, f.buyer_tax, f.seller_tax, f.buyer_total, f.seller_total,
              bc.customer_ref as buyer_ref, sc.customer_ref as seller_ref, f.created_at >= $1 as in_window,
              -- in flight since creation, or since operations last retried the fill
              greatest(s.created_at, (select max(a.created_at) from audit_log a
                                       where a.action = 'settlement.retry' and a.payload->>'fillId' = s.fill_id::text)) as open_since
         from settlements s
         join fills f on f.id = s.fill_id
         join orders b on b.id = f.buy_order_id join customers bc on bc.id = b.customer_id
         join orders o on o.id = f.sell_order_id join customers sc on sc.id = o.customer_id
        where (f.created_at >= $1 and f.created_at < $2)
           or (f.created_at >= $3 and f.created_at < $1
               and (s.updated_at >= $1 or s.status in ('PENDING', 'UNKNOWN_OUTCOME', 'REVERSAL_PENDING', 'FAILED_NEEDS_REVIEW')))
        order by f.seq, s.leg`,
      [from, to, carryFrom],
    );
    const totals = new Map<string, { platformBought: bigint; platformSold: bigint; coreBought: bigint; coreSold: bigint }>();
    const total = (ccy: string) => {
      let t = totals.get(ccy);
      if (!t) totals.set(ccy, (t = { platformBought: 0n, platformSold: 0n, coreBought: 0n, coreSold: 0n }));
      return t;
    };
    for (const s of legs) {
      const buyer = s.leg === 'BANK_SELL';
      const base = findPair(c, s.pair)?.base ?? String(s.pair).slice(0, 3);
      const expected = {
        leg: s.leg as FxLeg,
        customerRef: buyer ? s.buyer_ref : s.seller_ref,
        qty: BigInt(s.qty),
        customerAmount: BigInt(buyer ? s.buyer_total : s.seller_total),
        commission: BigInt(buyer ? s.buyer_commission : s.seller_commission),
        tax: BigInt(buyer ? s.buyer_tax : s.seller_tax),
        currency: base,
      };
      const ref = s.id as string;
      const base_ = { fillId: s.fill_id, leg: s.leg, idempotencyKey: s.idempotency_key, platformStatus: s.status };
      if (s.status === 'SETTLED' && s.in_window) {
        if (s.leg === 'BANK_BUY') total(base).platformBought += expected.qty;
        else total(base).platformSold += expected.qty;
      }
      await this.checkPosting(add, 'SETTLEMENT', ref, s.status, s.core_txn_ref, expected, base_, lookup, {
        open: ['PENDING', 'UNKNOWN_OUTCOME', 'REVERSAL_PENDING'].includes(s.status),
        // Measured from creation or the last operations retry, not updated_at: recovery touches a stuck leg every minute.
        stale: now - new Date(s.open_since).getTime() > openAfterMs,
        mustNotBeBooked: s.status === 'FAILED_NEEDS_REVIEW',
        mustBeReversed: s.status === 'REVERSED',
      });
      // Earlier retry rounds of the leg (a new round's key is issued only after the previous posting was reversed):
      // one still booked means the customer was booked twice.
      for (let round = 0; round < Number(s.retry_round ?? 0); round++) {
        const key = SettlementService.idempotencyKey(s.fill_id, s.leg, round);
        let core;
        try {
          core = await lookup(key);
        } catch (err) {
          add({ severity: 'OPEN_ITEM', kind: 'CORE_LOOKUP_FAILED', source: 'SETTLEMENT', ref, details: { ...base_, earlierKey: key, error: (err as Error).message } });
          continue;
        }
        if (!core || core.reversed === true) continue;
        if (core.reversed === false) {
          duplicates.add(core.txnRef);
          add({ severity: 'BREAK', kind: 'DUPLICATE_POSTING', source: 'SETTLEMENT', ref, details: { ...base_, earlierKey: key, txnRef: core.txnRef, note: 'an earlier retry round of this leg is still booked' } });
        } else {
          add({ severity: 'OPEN_ITEM', kind: 'REVERSAL_NOT_VERIFIABLE', source: 'SETTLEMENT', ref, details: { ...base_, earlierKey: key, txnRef: core.txnRef } });
        }
      }
    }

    // ---- bank deals created in the window ----
    const { rows: deals } = await this.db.query(
      `select d.*, c.customer_ref, d.created_at >= $1 as in_window,
              greatest(d.created_at, (select max(a.created_at) from audit_log a
                                       where a.action = 'dealing.retry' and a.payload->>'dealId' = d.id::text)) as open_since
         from bank_deals d join customers c on c.id = d.customer_id
        where (d.created_at >= $1 and d.created_at < $2)
           or (d.created_at >= $3 and d.created_at < $1 and (d.updated_at >= $1 or d.status in ('PENDING', 'FAILED_NEEDS_REVIEW')))
        order by d.seq`,
      [from, to, carryFrom],
    );
    for (const d of deals) {
      const base = findPair(c, d.pair)?.base ?? String(d.pair).slice(0, 3);
      const leg: FxLeg = d.side === 'BUY' ? 'BANK_SELL' : 'BANK_BUY';
      const expected = {
        leg,
        customerRef: d.customer_ref,
        qty: BigInt(d.qty),
        customerAmount: BigInt(d.total),
        commission: 0n,
        tax: BigInt(d.tax),
        currency: base,
      };
      if (d.status === 'SETTLED' && d.in_window) {
        if (leg === 'BANK_BUY') total(base).platformBought += expected.qty;
        else total(base).platformSold += expected.qty;
      }
      await this.checkPosting(add, 'BANK_DEAL', d.id, d.status, d.core_txn_ref, expected, { dealId: d.id, idempotencyKey: `deal:${d.id}`, platformStatus: d.status }, lookup, {
        open: d.status === 'PENDING',
        stale: now - new Date(d.open_since).getTime() > openAfterMs,
        mustNotBeBooked: d.status === 'REJECTED' || d.status === 'FAILED_NEEDS_REVIEW',
        mustBeReversed: false,
        key: `deal:${d.id}`,
      });
    }

    // ---- core banking → platform: postings the platform does not know, or stale retry rounds still booked ----
    if (coreListing) {
      const fillIds = new Set<string>();
      const dealIds = new Set<string>();
      for (const r of coreRecords) {
        if (r.idempotencyKey.startsWith('reverse:')) continue;
        const f = FILL_KEY.exec(r.idempotencyKey);
        if (f) fillIds.add(f[1]);
        const d = DEAL_KEY.exec(r.idempotencyKey);
        if (d) dealIds.add(d[1]);
        if (!r.reversed) {
          const ccy = r.currency;
          if (r.leg === 'BANK_BUY') total(ccy).coreBought += r.qty;
          else total(ccy).coreSold += r.qty;
        }
      }
      const current = new Map<string, string>();
      if (fillIds.size) {
        const { rows } = await this.db.query(`select fill_id::text, leg, idempotency_key from settlements where fill_id::text = any($1)`, [[...fillIds]]);
        for (const r of rows) current.set(`${r.fill_id}:${r.leg}`, r.idempotency_key);
      }
      const knownDeals = new Set<string>();
      if (dealIds.size) {
        const { rows } = await this.db.query(`select id::text from bank_deals where id::text = any($1)`, [[...dealIds]]);
        for (const r of rows) knownDeals.add(r.id);
      }
      for (const r of coreRecords) {
        // A reversal posting of a key the platform issued (if core banking lists those separately).
        if (r.idempotencyKey.startsWith('reverse:')) continue;
        if (duplicates.has(r.txnRef)) continue;
        const record = { txnRef: r.txnRef, idempotencyKey: r.idempotencyKey, reference: r.reference, leg: r.leg, customerRef: r.customerRef, currency: r.currency, qty: r.qty, customerAmount: r.customerAmount, postedAt: r.postedAt, reversed: r.reversed };
        const f = FILL_KEY.exec(r.idempotencyKey);
        const d = DEAL_KEY.exec(r.idempotencyKey);
        if (f) {
          const currentKey = current.get(`${f[1]}:${f[2]}`);
          if (!currentKey) {
            add({ severity: 'BREAK', kind: 'UNKNOWN_IN_PLATFORM', source: 'CORE', ref: r.txnRef, details: { ...record, note: 'no such fill leg on the platform' } });
          } else if (currentKey !== r.idempotencyKey && !r.reversed) {
            add({ severity: 'BREAK', kind: 'DUPLICATE_POSTING', source: 'CORE', ref: r.txnRef, details: { ...record, currentKey, note: 'an earlier retry round of this leg is still booked' } });
          }
        } else if (d) {
          if (!knownDeals.has(d[1])) add({ severity: 'BREAK', kind: 'UNKNOWN_IN_PLATFORM', source: 'CORE', ref: r.txnRef, details: { ...record, note: 'no such bank deal on the platform' } });
        } else {
          add({ severity: 'BREAK', kind: 'UNKNOWN_IN_PLATFORM', source: 'CORE', ref: r.txnRef, details: { ...record, note: 'key not issued by the platform' } });
        }
      }
    }

    // ---- hedges created in the window, against the LPs ----
    // Hedges carry no update time: the day before the window is checked again (a clip in flight at the previous
    // cutoff is checked once resolved), and older clips still open are reported.
    const { rows: hedges } = await this.db.query(
      `select * from hedges
        where (created_at >= $1 and created_at < $2) or (created_at >= $3 and created_at < $1 and status in ('PENDING', 'UNKNOWN'))
        order by seq`,
      [new Date(from.getTime() - 24 * 3_600_000), to, carryFrom],
    );
    for (const h of hedges) {
      const decimals = findPair(c, h.pair)?.baseDecimals ?? 2;
      const sent = { pair: h.pair as string, side: h.side as 'BUY' | 'SELL', qty: formatDecimal(BigInt(h.qty), decimals) };
      const details = { hedgeId: h.id, lp: h.lp, lpRef: h.lp_ref, pair: h.pair, side: h.side, qty: sent.qty, rate: h.rate, platformStatus: h.status };
      if (h.status === 'PENDING' || h.status === 'UNKNOWN') {
        if (now - new Date(h.created_at).getTime() > openAfterMs) add({ severity: 'OPEN_ITEM', kind: 'OPEN_HEDGE', source: 'HEDGE', ref: h.id, details });
        continue;
      }
      if (!h.lp_ref) {
        // Clips recorded before references existed: nothing to look up by.
        if (h.status === 'DONE' && !h.lp_trade_ref) add({ severity: 'OPEN_ITEM', kind: 'HEDGE_NOT_VERIFIABLE', source: 'HEDGE', ref: h.id, details });
        continue;
      }
      let exec;
      try {
        // Lookup only: a two-leg synthetic hedge missing its second leg is reported, never completed from here.
        exec = await this.lp.findExecution(h.lp, h.lp_ref, sent, { lookupOnly: true });
      } catch (err) {
        add({ severity: 'OPEN_ITEM', kind: 'LP_LOOKUP_FAILED', source: 'HEDGE', ref: h.id, details: { ...details, error: (err as Error).message } });
        continue;
      }
      if (h.status === 'DONE') {
        if (!exec) {
          // Some LP APIs search recent activity only (Saxo: the last 500 order activities): an older clip they do
          // not find is unverified, not missing.
          const recent = now - new Date(h.created_at).getTime() <= LP_SEARCH_HORIZON_MS;
          add({ severity: recent ? 'BREAK' : 'OPEN_ITEM', kind: recent ? 'HEDGE_MISSING_AT_LP' : 'HEDGE_NOT_FOUND_AT_LP', source: 'HEDGE', ref: h.id, details });
          continue;
        }
        const diffs: string[] = [];
        if (exec.side !== h.side) diffs.push('side');
        if (exec.pair !== h.pair) diffs.push('pair');
        if (exec.qty !== sent.qty && safeDecimal(exec.qty, decimals) !== BigInt(h.qty)) diffs.push('qty');
        if (h.lp_trade_ref && exec.tradeRef !== h.lp_trade_ref) diffs.push('tradeRef');
        if (safePrice(exec.rate) !== safePrice(String(h.rate))) diffs.push('rate');
        if (diffs.length) add({ severity: 'BREAK', kind: 'HEDGE_MISMATCH', source: 'HEDGE', ref: h.id, details: { ...details, fields: diffs, lp: { side: exec.side, pair: exec.pair, qty: exec.qty, rate: exec.rate, tradeRef: exec.tradeRef } } });
      } else if (h.status === 'REJECTED' && exec) {
        add({ severity: 'BREAK', kind: 'HEDGE_EXECUTED_BUT_REJECTED', source: 'HEDGE', ref: h.id, details: { ...details, lp: { qty: exec.qty, rate: exec.rate, tradeRef: exec.tradeRef } } });
      }
    }

    const byKind: Record<string, number> = {};
    for (const b of breaks) byKind[b.kind] = (byKind[b.kind] ?? 0) + 1;
    const summary = {
      checked: { settlementLegs: legs.length, bankDeals: deals.length, hedges: hedges.length, corePostings: coreListing ? coreRecords.length : null },
      breaks: breaks.filter((b) => b.severity === 'BREAK').length,
      openItems: breaks.filter((b) => b.severity === 'OPEN_ITEM').length,
      byKind,
      // Base currency quantities, minor units: what the platform counts as booked against what core banking booked.
      totals: coreListing ? Object.fromEntries([...totals].map(([ccy, t]) => [ccy, t])) : undefined,
    };
    return { breaks, summary, coreListing };
  }

  /** Compares one platform posting (settlement leg or bank deal) with core banking. */
  private async checkPosting(
    add: (b: ReconBreak) => void,
    source: 'SETTLEMENT' | 'BANK_DEAL',
    ref: string,
    status: string,
    platformTxnRef: string | null,
    expected: { leg: FxLeg; customerRef: string; qty: bigint; customerAmount: bigint; commission: bigint; tax: bigint; currency: string },
    details: Record<string, unknown>,
    lookup: (key: string) => Promise<(Partial<CoreFxTransactionRecord> & { txnRef: string }) | undefined>,
    rules: { open: boolean; stale: boolean; mustNotBeBooked: boolean; mustBeReversed: boolean; key?: string },
  ) {
    const key = rules.key ?? (details.idempotencyKey as string);
    if (rules.open) {
      if (rules.stale) add({ severity: 'OPEN_ITEM', kind: source === 'SETTLEMENT' ? 'OPEN_SETTLEMENT' : 'OPEN_DEAL', source, ref, details });
      return;
    }
    let core;
    try {
      core = await lookup(key);
    } catch (err) {
      add({ severity: 'OPEN_ITEM', kind: 'CORE_LOOKUP_FAILED', source, ref, details: { ...details, error: (err as Error).message } });
      return;
    }
    const coreView = core && { txnRef: core.txnRef, reversed: core.reversed, postedAt: core.postedAt };
    // The platform never reverses a rejected deal or the failed leg itself: booked is a break, listed or not
    // (without a listing, reversed is unknown and taken as not reversed).
    if (rules.mustNotBeBooked) {
      if (core && core.reversed !== true) add({ severity: 'BREAK', kind: 'BOOKED_BUT_NOT_SETTLED', source, ref, details: { ...details, core: coreView } });
      return;
    }
    // A reversed leg must show reversed; without a listing that cannot be told, so it is unverifiable.

    if (rules.mustBeReversed) {
      if (!core) add({ severity: 'BREAK', kind: 'MISSING_IN_CORE', source, ref, details: { ...details, note: 'the platform reversed this leg but core banking has no posting under its key' } });
      else if (core.reversed === false) add({ severity: 'BREAK', kind: 'NOT_REVERSED_IN_CORE', source, ref, details: { ...details, core: coreView } });
      else if (core.reversed === undefined) add({ severity: 'OPEN_ITEM', kind: 'REVERSAL_NOT_VERIFIABLE', source, ref, details: { ...details, core: coreView } });
      return;
    }
    if (status !== 'SETTLED') return;
    if (!core) {
      add({ severity: 'BREAK', kind: 'MISSING_IN_CORE', source, ref, details: { ...details, platformTxnRef } });
      return;
    }
    if (core.reversed) add({ severity: 'BREAK', kind: 'REVERSED_IN_CORE', source, ref, details: { ...details, core: coreView } });
    if (platformTxnRef && core.txnRef !== platformTxnRef) add({ severity: 'BREAK', kind: 'TXN_REF_MISMATCH', source, ref, details: { ...details, platformTxnRef, core: coreView } });
    if (core.qty === undefined) return; // looked up by key only: no amounts to compare
    const diffs: Record<string, { platform: unknown; core: unknown }> = {};
    const cmp = (name: string, a: unknown, b: unknown) => {
      if (a !== b) diffs[name] = { platform: a, core: b };
    };
    cmp('leg', expected.leg, core.leg);
    cmp('customerRef', expected.customerRef, core.customerRef);
    cmp('currency', expected.currency, core.currency);
    cmp('qty', expected.qty, core.qty);
    cmp('customerAmount', expected.customerAmount, core.customerAmount);
    cmp('commission', expected.commission, core.commission);
    cmp('tax', expected.tax, core.tax);
    if (Object.keys(diffs).length) add({ severity: 'BREAK', kind: 'AMOUNT_MISMATCH', source, ref, details: { ...details, txnRef: core.txnRef, diffs } });
  }
}

function safePrice(v: string): bigint | undefined {
  try {
    return parsePrice(v);
  } catch {
    return undefined;
  }
}

function safeDecimal(v: string, decimals: number): bigint | undefined {
  const [i, f = ''] = v.split('.');
  if (!/^\d+$/.test(i) || !/^\d*$/.test(f) || f.length > decimals) return undefined;
  return BigInt(i + f.padEnd(decimals, '0'));
}

function runView(r: Record<string, any>) {
  return {
    id: r.id,
    from: r.window_from,
    to: r.window_to,
    trigger: r.trigger,
    actor: r.actor,
    status: r.status as ReconStatus,
    coreListing: r.core_listing,
    summary: r.summary,
    error: r.error,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

function breakView(r: Record<string, any>) {
  return { id: r.id, severity: r.severity as Severity, kind: r.kind, source: r.source as BreakSource, ref: r.ref, details: r.details };
}
