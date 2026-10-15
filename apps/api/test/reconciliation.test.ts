import { afterEach, describe, expect, it } from 'vitest';
import { MockCoreBank, type FxTransactionRequest } from '@p2p/core-adapter';
import { OPS, startHarness, type Harness } from './helpers.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
  h = undefined as unknown as Harness;
});

/** The mock core's postings by idempotency key (tests reach in to tamper with core banking's side). */
type Txn = { txnRef: string; reversed: boolean; request: FxTransactionRequest; postedAt: string };
const coreTxns = (h: Harness) => (h.bank as unknown as { txnsByKey: Map<string, Txn> }).txnsByKey;
const lpExecutions = (h: Harness) => (h.liquidity as unknown as { executions: Map<string, { qty: string; rate: string }> }).executions;

/** A P2P fill between alice (seller) and bob (buyer), a bank deal for carol, and a manual hedge. */
async function day(h: Harness) {
  h.customer('alice', { USD: '1000', TRY: '0' });
  h.customer('bob', { USD: '0', TRY: '100000' });
  h.customer('carol', { USD: '0', TRY: '100000' });
  const [alice, bob, carol] = await Promise.all(['alice', 'bob', 'carol'].map((r) => h.login(r)));
  await h.place(alice, { side: 'SELL', qty: '1000', price: '49.15' });
  await h.place(bob, { side: 'BUY', qty: '1000', price: '49.15' });
  const q = await h.req('POST', '/v1/bank/quotes', carol, { pair: 'USDTRY', side: 'BUY', qty: '100' });
  expect((await h.req('POST', '/v1/bank/deals', carol, { quoteId: q.body.id })).status).toBe(201);
  expect((await h.req('POST', '/ops/dealing/hedges', OPS, { pair: 'USDTRY', side: 'BUY', qty: '100' })).status).toBe(200);
  const { rows } = await h.ctx.db.query(`select fill_id::text from settlements limit 1`);
  return { fillId: rows[0].fill_id as string };
}

/** A manual run around now (platform rows and mock postings carry the real time, not the harness clock). */
async function run(h: Harness) {
  const res = await h.req('POST', '/ops/reconciliation/runs', OPS, {
    from: new Date(Date.now() - 3_600_000).toISOString(),
    to: new Date(Date.now() + 60_000).toISOString(),
  });
  expect(res.status).toBe(200);
  return res.body as { id: string; status: string; coreListing: boolean; summary: any; items: { severity: string; kind: string; source: string; ref: string; details: any }[] };
}

describe('reconciliation', () => {
  it('finds nothing when the platform, core banking and the LPs agree, and totals match per currency', async () => {
    h = await startHarness();
    await day(h);
    const r = await run(h);
    expect(r.status).toBe('CLEAN');
    expect(r.coreListing).toBe(true);
    expect(r.items).toEqual([]);
    expect(r.summary.checked).toEqual({ settlementLegs: 2, bankDeals: 1, hedges: 1, corePostings: 3 });
    // 1,000 USD bought from alice and sold to bob, 100 USD sold to carol: platform and core agree.
    expect(r.summary.totals.USD).toEqual({ platformBought: '100000', platformSold: '110000', coreBought: '100000', coreSold: '110000' });

    // Listed, readable, and on the readiness check.
    expect((await h.req('GET', '/ops/reconciliation/runs', OPS)).body[0]).toMatchObject({ id: r.id, status: 'CLEAN', trigger: 'MANUAL' });
    expect((await h.req('GET', `/ops/reconciliation/runs/${r.id}`, OPS)).body.items).toEqual([]);
    expect((await h.req('GET', '/ready')).body.reconciliation).toMatchObject({ runId: r.id, status: 'CLEAN', breaks: 0 });
    const { rows } = await h.ctx.db.query(`select action from audit_log where action = 'reconciliation.run'`);
    expect(rows).toHaveLength(1);
  });

  it('reports a core banking posting the platform does not know', async () => {
    h = await startHarness();
    await day(h);
    // Someone posts an FX transaction through the platform's channel by hand.
    const sample = [...coreTxns(h).values()].find((t) => t.request.leg === 'BANK_SELL')!.request;
    await h.bank.postFxTransaction({ ...sample, holdIds: [], idempotencyKey: 'manual:1', reference: 'MANUAL-1' });
    const r = await run(h);
    expect(r.status).toBe('BREAKS');
    expect(r.items).toEqual([expect.objectContaining({ severity: 'BREAK', kind: 'UNKNOWN_IN_PLATFORM', source: 'CORE' })]);
  });

  it('reports an earlier retry round of a leg still booked next to the current one (double posting), once', async () => {
    h = await startHarness();
    const { fillId } = await day(h);
    // As after a retry: the leg now carries round 1's key and core booked it; round 0 should have been reversed but was not.
    const sell = coreTxns(h).get(`fill:${fillId}:BANK_SELL`)!.request;
    const r1 = `fill:${fillId}:BANK_SELL:r1`;
    const posted = await h.bank.postFxTransaction({ ...sell, holdIds: [], idempotencyKey: r1 });
    await h.ctx.db.query(`update settlements set idempotency_key = $1, retry_round = 1, core_txn_ref = $2 where fill_id = $3 and leg = 'BANK_SELL'`, [r1, posted.txnRef, fillId]);
    const r = await run(h);
    expect(r.items).toEqual([
      expect.objectContaining({ kind: 'DUPLICATE_POSTING', source: 'SETTLEMENT', details: expect.objectContaining({ earlierKey: `fill:${fillId}:BANK_SELL` }) }),
    ]);
    // Reversed as it should be: nothing to report.
    coreTxns(h).get(`fill:${fillId}:BANK_SELL`)!.reversed = true;
    expect((await run(h)).items).toEqual([]);
  });

  it('reports a core banking posting under a round the platform never issued', async () => {
    h = await startHarness();
    const { fillId } = await day(h);
    const sell = coreTxns(h).get(`fill:${fillId}:BANK_SELL`)!.request;
    await h.bank.postFxTransaction({ ...sell, holdIds: [], idempotencyKey: `fill:${fillId}:BANK_SELL:r1` });
    const r = await run(h);
    expect(r.items).toEqual([
      expect.objectContaining({ kind: 'DUPLICATE_POSTING', source: 'CORE', details: expect.objectContaining({ currentKey: `fill:${fillId}:BANK_SELL` }) }),
    ]);
  });

  it('checks a fill created before the window whose settlement finished in it', async () => {
    h = await startHarness();
    const { fillId } = await day(h);
    await h.ctx.db.query(`update fills set created_at = now() - interval '5 hours' where id = $1`, [fillId]);
    await h.ctx.db.query(`update settlements set created_at = now() - interval '5 hours', updated_at = now() where fill_id = $1`, [fillId]);
    coreTxns(h).get(`fill:${fillId}:BANK_BUY`)!.request.tax += 1n;
    const r = await run(h); // the window starts an hour ago
    expect(r.items).toEqual([expect.objectContaining({ kind: 'AMOUNT_MISMATCH', details: expect.objectContaining({ leg: 'BANK_BUY' }) })]);
  });

  it('reports a leg whose amounts differ in core banking, and one core banking does not have', async () => {
    h = await startHarness();
    const { fillId } = await day(h);
    coreTxns(h).get(`fill:${fillId}:BANK_BUY`)!.request.customerAmount += 100n;
    coreTxns(h).delete(`fill:${fillId}:BANK_SELL`);
    const r = await run(h);
    expect(r.status).toBe('BREAKS');
    const kinds = r.items.map((i) => [i.kind, i.details.leg]).sort();
    expect(kinds).toEqual([
      ['AMOUNT_MISMATCH', 'BANK_BUY'],
      ['MISSING_IN_CORE', 'BANK_SELL'],
    ]);
    const mismatch = r.items.find((i) => i.kind === 'AMOUNT_MISMATCH')!;
    expect(Object.keys(mismatch.details.diffs)).toEqual(['customerAmount']);
    expect(r.summary.byKind).toEqual({ AMOUNT_MISMATCH: 1, MISSING_IN_CORE: 1 });
  });

  it('reports a settled leg core banking reversed and a deal the platform rejected but core banking booked', async () => {
    h = await startHarness();
    const { fillId } = await day(h);
    coreTxns(h).get(`fill:${fillId}:BANK_BUY`)!.reversed = true;
    await h.ctx.db.query(`update bank_deals set status = 'REJECTED'`);
    const r = await run(h);
    expect(r.items.map((i) => i.kind).sort()).toEqual(['BOOKED_BUT_NOT_SETTLED', 'REVERSED_IN_CORE']);
    expect(r.items.find((i) => i.kind === 'BOOKED_BUT_NOT_SETTLED')!.source).toBe('BANK_DEAL');
  });

  it('checks hedges against the LP: missing there, or executed although the platform counts it rejected', async () => {
    h = await startHarness();
    await day(h);
    expect((await h.req('POST', '/ops/dealing/hedges', OPS, { pair: 'USDTRY', side: 'SELL', qty: '50' })).status).toBe(200);
    const { rows } = await h.ctx.db.query(`select id::text, lp, lp_ref from hedges order by seq`);
    lpExecutions(h).delete(`${rows[0].lp}:${rows[0].lp_ref}`);
    await h.ctx.db.query(`update hedges set status = 'REJECTED' where id::text = $1`, [rows[1].id]);
    const r = await run(h);
    expect(r.items.map((i) => [i.kind, i.ref]).sort()).toEqual(
      [
        ['HEDGE_EXECUTED_BUT_REJECTED', rows[1].id],
        ['HEDGE_MISSING_AT_LP', rows[0].id],
      ].sort(),
    );
  });

  it('a hedge an LP with a capped search does not find is an open item, not a break', async () => {
    h = await startHarness();
    await day(h);
    const { rows } = await h.ctx.db.query(`select lp, lp_ref from hedges`);
    lpExecutions(h).delete(`${rows[0].lp}:${rows[0].lp_ref}`);
    (h.liquidity as unknown as { lookupComplete: (lp: string) => boolean }).lookupComplete = (lp) => lp !== rows[0].lp;
    const r = await run(h);
    expect(r.items).toEqual([expect.objectContaining({ severity: 'OPEN_ITEM', kind: 'HEDGE_NOT_FOUND_AT_LP' })]);
  });

  it('reports a hedge whose LP execution differs in quantity or rate', async () => {
    h = await startHarness();
    await day(h);
    const { rows } = await h.ctx.db.query(`select lp, lp_ref from hedges`);
    const exec = lpExecutions(h).get(`${rows[0].lp}:${rows[0].lp_ref}`)!;
    exec.qty = '90';
    exec.rate = '50';
    const r = await run(h);
    expect(r.items).toEqual([expect.objectContaining({ kind: 'HEDGE_MISMATCH', details: expect.objectContaining({ fields: ['qty', 'rate'] }) })]);
  });

  it('lists records still in flight past the grace time as open items, not breaks', async () => {
    h = await startHarness();
    await day(h);
    // Stuck for two hours although recovery touched it a moment ago (updated_at), next to a leg created just now.
    await h.ctx.db.query(`update settlements set status = 'UNKNOWN_OUTCOME', created_at = now() - interval '2 hours', updated_at = now() where leg = 'BANK_SELL'`);
    await h.ctx.db.query(`update settlements set status = 'PENDING', updated_at = now() where leg = 'BANK_BUY'`);
    const r = await run(h);
    expect(r.status).toBe('OPEN_ITEMS');
    expect(r.items).toEqual([expect.objectContaining({ severity: 'OPEN_ITEM', kind: 'OPEN_SETTLEMENT', details: expect.objectContaining({ leg: 'BANK_SELL' }) })]);
  });

  it('without a core banking listing, still finds what is missing by key (and says it could not list)', async () => {
    const bank = new MockCoreBank();
    bank.setReferenceRate('USDTRY', '49.15');
    (bank as unknown as { listFxTransactions?: unknown }).listFxTransactions = undefined;
    h = await startHarness({ bank });
    const { fillId } = await day(h);
    coreTxns(h).delete(`fill:${fillId}:BANK_SELL`);
    const r = await run(h);
    expect(r.coreListing).toBe(false);
    expect(r.summary.checked.corePostings).toBeNull();
    expect(r.items).toEqual([expect.objectContaining({ kind: 'MISSING_IN_CORE' })]);
  });

  it('runs once a day after its time, catching up on yesterday when started before it', async () => {
    h = await startHarness();
    const runs = async () => (await h.ctx.db.query(`select trigger, window_from, window_to from recon_runs order by started_at`)).rows;
    // 12:00 in Istanbul, before today's 23:30: yesterday's run is due.
    await h.ctx.reconciliation.runDailyIfDue();
    expect(await runs()).toEqual([{ trigger: 'SCHEDULED', window_from: new Date('2026-10-03T20:30:00Z'), window_to: new Date('2026-10-04T20:30:00Z') }]);
    await h.ctx.reconciliation.runDailyIfDue();
    expect(await runs()).toHaveLength(1);
    // After 23:30 today: today's run.
    h.clock.now = new Date('2026-10-05T20:31:00Z');
    await h.ctx.scheduler.tick();
    await h.ctx.reconciliation.idle();
    expect((await runs()).map((r) => r.window_to)).toEqual([new Date('2026-10-04T20:30:00Z'), new Date('2026-10-05T20:30:00Z')]);
    // Switched off: nothing more.
    await h.setConfig((c) => ({ ...c, reconciliation: { ...c.reconciliation, enabled: false } }));
    h.clock.now = new Date('2026-10-06T20:31:00Z');
    expect(await h.ctx.reconciliation.runDailyIfDue()).toBeUndefined();
  });

  it('does not retry a failed daily run on every tick', async () => {
    h = await startHarness();
    (h.bank as unknown as { listFxTransactions: () => Promise<never> }).listFxTransactions = async () => {
      throw new Error('core banking down');
    };
    for (let i = 0; i < 3; i++) await h.ctx.reconciliation.runDailyIfDue();
    const count = async () => (await h.ctx.db.query(`select count(*)::int as n from recon_runs where status = 'FAILED'`)).rows[0].n;
    expect(await count()).toBe(1);
    expect((await h.ctx.db.query(`select error from recon_runs`)).rows[0].error).toBe('core banking down');
    expect((await h.req('GET', '/ready')).body.reconciliation).toMatchObject({ status: 'FAILED' });
    // Tried again 30 minutes later, three attempts in all, then left to operations.
    const age = () => h.ctx.db.query(`update recon_runs set started_at = started_at - interval '31 minutes'`);
    await age();
    await h.ctx.reconciliation.runDailyIfDue();
    expect(await count()).toBe(2);
    await age();
    await h.ctx.reconciliation.runDailyIfDue();
    await age();
    await h.ctx.reconciliation.runDailyIfDue();
    expect(await count()).toBe(3);
  });

  it('a run interrupted by a stop does not block the day once it is stale', async () => {
    h = await startHarness();
    await h.ctx.db.query(
      `insert into recon_runs (window_from, window_to, trigger, actor, status, started_at)
       values ('2026-10-03T20:30:00Z', '2026-10-04T20:30:00Z', 'SCHEDULED', 'system', 'RUNNING', now() - interval '7 hours')`,
    );
    expect(await h.ctx.reconciliation.runDailyIfDue()).toBeDefined();
    const { rows } = await h.ctx.db.query(`select status, error from recon_runs order by started_at`);
    expect(rows).toEqual([{ status: 'FAILED', error: 'interrupted' }, { status: 'CLEAN', error: null }]);
  });

  it('without a listing: a rejected deal core banking booked is a break, a reversed leg is unverifiable', async () => {
    const bank = new MockCoreBank();
    bank.setReferenceRate('USDTRY', '49.15');
    (bank as unknown as { listFxTransactions?: unknown }).listFxTransactions = undefined;
    h = await startHarness({ bank });
    await day(h);
    await h.ctx.db.query(`update bank_deals set status = 'REJECTED'`);
    await h.ctx.db.query(`update settlements set status = 'REVERSED' where leg = 'BANK_BUY'`);
    const r = await run(h);
    expect(r.items.map((i) => [i.severity, i.kind, i.source]).sort()).toEqual([
      ['BREAK', 'BOOKED_BUT_NOT_SETTLED', 'BANK_DEAL'],
      ['OPEN_ITEM', 'REVERSAL_NOT_VERIFIABLE', 'SETTLEMENT'],
    ]);
  });

  it('does not report a leg operations just retried as stuck', async () => {
    h = await startHarness();
    const { fillId } = await day(h);
    await h.ctx.db.query(`update fills set created_at = now() - interval '3 hours' where id = $1`, [fillId]);
    await h.ctx.db.query(`update settlements set status = 'PENDING', created_at = now() - interval '3 hours', updated_at = now(), retried_at = now() where fill_id = $1`, [fillId]);
    expect((await run(h)).items).toEqual([]);
    // Without the retry it is stuck for three hours.
    await h.ctx.db.query(`update settlements set retried_at = null where fill_id = $1`, [fillId]);
    expect((await run(h)).items.map((i) => i.kind)).toEqual(['OPEN_SETTLEMENT', 'OPEN_SETTLEMENT']);
  });

  it('refuses a second run while one is running, and a reversed range', async () => {
    h = await startHarness();
    await h.ctx.db.query(`insert into recon_runs (window_from, window_to, trigger, actor, status) values (now(), now(), 'MANUAL', 'x', 'RUNNING')`);
    const busy = await h.req('POST', '/ops/reconciliation/runs', OPS, {});
    expect(busy.status).toBe(409);
    expect(busy.body.error).toBe('RECONCILIATION_RUNNING');
    const reversed = await h.req('POST', '/ops/reconciliation/runs', OPS, { from: '2026-10-05T10:00:00Z', to: '2026-10-05T09:00:00Z' });
    expect(reversed.status).toBe(400);
  });
});
