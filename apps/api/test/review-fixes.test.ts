/**
 * Failure scenarios from the external review of c4a79ba: lost core responses, LP timeouts and database
 * errors around an LP trade, event failures after a fill commit, a stale book, expiry at match time and a
 * second matching instance. Each one must leave money and quantities consistent.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MockCoreBank, CoreBankingError, type FxTransactionRequest } from '@p2p/core-adapter';
import { OPS, startHarness, units, type Harness } from './helpers.js';

/** Core that books a posting but can lose the response, and whose lookups can fail. */
class LossyBank extends MockCoreBank {
  loseBankBuy = 0;
  failLookups = false;
  readonly booked: string[] = [];
  override async postFxTransaction(req: FxTransactionRequest) {
    const res = await super.postFxTransaction(req);
    if (!this.booked.includes(req.idempotencyKey)) this.booked.push(req.idempotencyKey);
    if (req.leg === 'BANK_BUY' && this.loseBankBuy > 0) {
      this.loseBankBuy--;
      throw new CoreBankingError('UNAVAILABLE', 'socket timeout (response lost after commit)');
    }
    return res;
  }
  override async findFxTransaction(key: string) {
    if (this.failLookups) throw new CoreBankingError('UNAVAILABLE', 'core banking down');
    return super.findFxTransaction(key);
  }
}

let h: Harness;
let other: Harness | undefined;
afterEach(async () => {
  await other?.close();
  other = undefined;
  await h?.close();
});

async function lossyTrade(bank: LossyBank) {
  bank.setReferenceRate('USDTRY', '49.15');
  h = await startHarness({ bank });
  h.customer('alice', { USD: '2000', TRY: '0' });
  h.customer('bob', { USD: '0', TRY: '100000' });
  const [alice, bob] = await Promise.all(['alice', 'bob'].map((r) => h.login(r)));
  await h.place(alice, { side: 'SELL', qty: '1000', price: '49.15' });
  await h.place(bob, { side: 'BUY', qty: '1000', price: '49.15' });
  const { rows } = await h.ctx.db.query('select fill_id, leg, status from settlements order by leg');
  return rows;
}

describe('settlement with unknown outcomes (F02)', () => {
  it('settles a leg whose response was lost by looking it up, without posting it twice', async () => {
    const bank = new LossyBank();
    bank.loseBankBuy = 2; // every in-line attempt
    const rows = await lossyTrade(bank);
    expect(rows.map((r) => r.status)).toEqual(['SETTLED', 'SETTLED']);
    expect(bank.booked.filter((k) => k.includes('BANK_BUY'))).toHaveLength(1);
    expect(await h.balance('alice', 'USD')).toMatchObject({ balance: units('1000') });
    expect(await h.balance('alice', 'TRY')).toMatchObject({ balance: units('49001.80') });
  });

  it('marks the leg UNKNOWN_OUTCOME when the lookup fails too, reverses nothing, and resolves it on retry', async () => {
    const bank = new LossyBank();
    bank.loseBankBuy = 2;
    bank.failLookups = true;
    const rows = await lossyTrade(bank);
    expect(rows.map((r) => [r.leg, r.status])).toEqual([['BANK_BUY', 'UNKNOWN_OUTCOME'], ['BANK_SELL', 'PENDING']]);
    const listed = (await h.req('GET', '/ops/settlements', OPS)).body;
    expect(listed.map((s: { status: string }) => s.status)).toEqual(['UNKNOWN_OUTCOME']);

    // Still no lookup: the retry refuses to send anything.
    const blocked = await h.req('POST', `/ops/settlements/${rows[0].fill_id}/retry`, OPS);
    expect(blocked).toMatchObject({ status: 503, body: { error: 'OUTCOME_UNKNOWN' } });
    expect(bank.booked).toHaveLength(1);

    bank.failLookups = false;
    const retry = await h.req('POST', `/ops/settlements/${rows[0].fill_id}/retry`, OPS);
    expect(retry.body.outcome).toBe('SETTLED');
    expect(bank.booked.filter((k) => k.includes('BANK_BUY'))).toEqual([`fill:${rows[0].fill_id}:BANK_BUY`]);
    expect(await h.balance('alice', 'USD')).toMatchObject({ balance: units('1000') });
    expect(await h.balance('bob', 'USD')).toMatchObject({ balance: units('1000') });

    // Nothing left to retry.
    expect((await h.req('POST', `/ops/settlements/${rows[0].fill_id}/retry`, OPS)).body.error).toBe('NOTHING_TO_RETRY');
  });
});

describe('hedging with unknown outcomes (F03)', () => {
  const executions = () => (h.liquidity as unknown as { executionCount: number }).executionCount;

  it('records the clip before sending it, so a database error after the LP traded never re-sends it', async () => {
    h = await startHarness();
    const db = h.ctx.db as unknown as { query: (...a: unknown[]) => Promise<unknown> };
    const orig = db.query.bind(db);
    db.query = (sql: unknown, ...rest: unknown[]) =>
      typeof sql === 'string' && sql.includes(`set status = 'DONE'`) ? Promise.reject(new Error('db connection reset')) : orig(sql, ...rest);

    const res = await h.req('POST', '/ops/dealing/hedges', OPS, { pair: 'USDTRY', side: 'BUY', qty: '100' });
    db.query = orig;
    expect(res.body).toMatchObject({ qty: '0.00', unknown: '100.00' });
    expect(executions()).toBe(1);
    // The open clip counts in the position, so auto-hedging will not trade it again.
    const pos = (await h.req('GET', '/ops/dealing', OPS)).body.positions.find((p: { pair: string }) => p.pair === 'USDTRY');
    expect(pos.qty).toBe('100.00');

    // The next hedge looks it up first and confirms it.
    await h.ctx.positions.resolveOpenClips();
    const { rows } = await h.ctx.db.query('select status, lp_trade_ref from hedges');
    expect(rows).toEqual([expect.objectContaining({ status: 'DONE', lp_trade_ref: expect.stringMatching(/^LP-A-/) })]);
  });

  it('does not move a timed-out clip to another LP', async () => {
    h = await startHarness();
    h.liquidity.losingResponses.add('LP-A');
    const res = await h.req('POST', '/ops/dealing/hedges', OPS, { pair: 'USDTRY', side: 'BUY', qty: '100' });
    expect(res.body).toMatchObject({ unknown: '100.00', clips: [] });
    expect(executions()).toBe(1);
    h.liquidity.losingResponses.clear();
    await h.ctx.positions.resolveOpenClips();
    expect((await h.ctx.db.query('select status from hedges')).rows).toEqual([{ status: 'DONE' }]);
  });
});

describe('fills after the commit (F04)', () => {
  async function setup() {
    h = await startHarness();
    h.customer('alice', { USD: '1000', TRY: '0' });
    h.customer('bob', { USD: '0', TRY: '100000' });
    h.customer('carol', { USD: '0', TRY: '100000' });
    return Promise.all(['alice', 'bob', 'carol'].map((r) => h.login(r)));
  }

  it('keeps the book in step with the database when announcing a fill fails', async () => {
    const [alice, bob, carol] = await setup();
    const sell = await h.place(alice, { side: 'SELL', qty: '100', price: '49.15' });
    const orig = h.ctx.events.publish.bind(h.ctx.events);
    h.ctx.events.publish = (e) => (e.type === 'book' ? orig(e) : Promise.reject(new Error('NOTIFY failed')));
    const buy = await h.place(bob, { side: 'BUY', qty: '100', price: '49.15' });
    h.ctx.events.publish = orig;
    expect(buy.status).toBe(201);

    expect(h.ctx.exchange.depth('USDTRY').asks).toEqual([]);
    const late = await h.place(carol, { side: 'BUY', qty: '100', price: '49.15' });
    expect(late.body.status).toBe('OPEN');
    const a = (await h.ctx.db.query('select status, qty, filled_qty from orders where id = $1', [sell.body.id])).rows[0];
    expect(a).toMatchObject({ status: 'FILLED', filled_qty: a.qty });
    expect(await h.balance('alice', 'USD')).toMatchObject({ balance: units('900') });
  });

  it('never fills an order past its quantity, even when the book is stale', async () => {
    const [alice, bob] = await setup();
    const sell = await h.place(alice, { side: 'SELL', qty: '100', price: '49.15' });
    // Simulate a book that missed an update: the database has the order filled, the book still offers it.
    await h.ctx.db.query(`update orders set filled_qty = qty, status = 'FILLED' where id = $1`, [sell.body.id]);
    const buy = await h.place(bob, { side: 'BUY', qty: '100', price: '49.15' });
    expect(buy.body.status).toBe('OPEN');
    expect((await h.ctx.db.query('select count(*)::int as n from fills')).rows[0].n).toBe(0);
    expect(h.ctx.exchange.depth('USDTRY').asks).toEqual([]);
    await expect(h.ctx.db.query(`update orders set filled_qty = qty + 1 where id = $1`, [sell.body.id])).rejects.toThrow(/orders_filled_qty_check/);
  });

  it('says "eşleşti, inceleniyor" instead of "gerçekleşti" when settlement did not complete', async () => {
    const [alice, bob] = await setup();
    h.bank.failNextPostings = 2;
    await h.place(alice, { side: 'SELL', qty: '100', price: '49.15' });
    await h.place(bob, { side: 'BUY', qty: '100', price: '49.15' });
    const titles = h.bank.notifications.filter((n) => n.event.type === 'fill').map((n) => n.event.title);
    expect(titles).toEqual(['Döviz alış emriniz eşleşti, banka işlemi inceleniyor', 'Döviz satış emriniz eşleşti, banka işlemi inceleniyor']);
  });
});

describe('expiry and the single matching instance (F05, F09)', () => {
  it('expires a resting order at match time even before the scheduler runs', async () => {
    h = await startHarness();
    h.customer('alice', { USD: '1000', TRY: '0' });
    h.customer('bob', { USD: '0', TRY: '100000' });
    const alice = await h.login('alice');
    const gtd = await h.place(alice, {
      side: 'SELL', qty: '100', price: '49.15', validity: 'GTD', expiresAt: new Date(h.clock.now.getTime() + 3_600_000).toISOString(),
    });
    h.clock.now = new Date(h.clock.now.getTime() + 2 * 3_600_000);
    const bob = await h.login('bob');
    const buy = await h.place(bob, { side: 'BUY', qty: '100', price: '49.15' });
    expect(buy.body.status).toBe('OPEN');
    expect((await h.req('GET', `/v1/orders/${gtd.body.id}`, await h.login('alice'))).body).toMatchObject({ status: 'EXPIRED', cancelReason: 'EXPIRED' });
  });

  it('refuses to start a second matching instance on the same database', async () => {
    h = await startHarness();
    await expect(startHarness({ reset: false })).rejects.toThrow(/single matching instance/);
    other = await startHarness({ reset: false, matching: false });
    other.customer('zed', { USD: '0', TRY: '1000' });
    const t = await other.login('zed');
    expect((await other.place(t, { side: 'BUY', qty: '1', price: '49.15' })).body.error).toBe('MATCHING_UNAVAILABLE');
  });
});

describe('bank deals', () => {
  it('does not announce a rejected deal as a trade', async () => {
    h = await startHarness();
    h.customer('ayse', { USD: '0', TRY: '10' });
    const ayse = await h.login('ayse');
    const published: string[] = [];
    const orig = h.ctx.events.publish.bind(h.ctx.events);
    h.ctx.events.publish = (e) => (published.push(e.type), orig(e));
    const q = await h.req('POST', '/v1/bank/quotes', ayse, { pair: 'USDTRY', side: 'BUY', qty: '100' });
    const d = await h.req('POST', '/v1/bank/deals', ayse, { quoteId: q.body.id });
    expect(d.body.error).toBe('INSUFFICIENT_BALANCE');
    expect(published).not.toContain('fill');
  });
});
