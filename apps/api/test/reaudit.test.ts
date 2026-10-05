// Regression tests for the re-audit of c0e89a0 (R01–R08). Each started as a reproduction of the unsafe
// behaviour and now asserts the safe one.
import { afterEach, describe, expect, it } from 'vitest';
import { MockCoreBank, CoreBankingError, type FxTransactionRequest } from '@p2p/core-adapter';
import { startHarness, units, OPS, type Harness } from './helpers.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const legStatuses = async () => (await h.ctx.db.query('select status from settlements order by leg')).rows.map((r) => r.status);

async function trade(bank: MockCoreBank) {
  bank.setReferenceRate('USDTRY', '49.15');
  h = await startHarness({ bank });
  h.customer('seller', { USD: '1000', TRY: '0' });
  h.customer('buyer', { USD: '0', TRY: '100000' });
  await h.place(await h.login('seller'), { side: 'SELL', qty: '100', price: '49.15' });
  await h.place(await h.login('buyer'), { side: 'BUY', qty: '100', price: '49.15' });
  return (await h.ctx.db.query('select fill_id from settlements limit 1')).rows[0].fill_id as string;
}

/** Core banking whose BANK_BUY posting and lookups can be made to fail, counting what it really booked. */
class FlakyBank extends MockCoreBank {
  buyDown = true;
  /** Books BANK_BUY but loses the response. */
  buyBookedButLost = false;
  lookupDown = true;
  delayMs = 0;
  booked: string[] = [];
  override async postFxTransaction(r: FxTransactionRequest) {
    if (this.delayMs) await sleep(this.delayMs);
    if (r.leg === 'BANK_BUY' && this.buyDown) {
      if (this.buyBookedButLost) {
        await super.postFxTransaction(r);
        if (!this.booked.includes(r.idempotencyKey)) this.booked.push(r.idempotencyKey);
      }
      throw new CoreBankingError('UNAVAILABLE', 'request lost');
    }
    const res = await super.postFxTransaction(r);
    if (!this.booked.includes(r.idempotencyKey)) this.booked.push(r.idempotencyKey);
    return res;
  }
  override async findFxTransaction(key: string) {
    if (key.includes('BANK_BUY') && this.lookupDown) throw new CoreBankingError('UNAVAILABLE', 'lookup unavailable');
    return super.findFxTransaction(key);
  }
}

describe('R01: an unknown first leg blocks the second', () => {
  it('never posts BANK_SELL while BANK_BUY is unknown, then posts only what is missing', async () => {
    const bank = new FlakyBank();
    const id = await trade(bank);
    expect(await legStatuses()).toEqual(['UNKNOWN_OUTCOME', 'PENDING']);

    // Startup recovery, the scheduler and direct calls, also at the same time, all stop at the unknown leg.
    await h.ctx.settlement.resumePending();
    await Promise.all([h.ctx.settlement.resumePending(), h.ctx.settlement.settle(id), h.ctx.scheduler.tick()]);
    expect(await h.ctx.settlement.settle(id)).toBe('UNKNOWN_OUTCOME');
    expect(await legStatuses()).toEqual(['UNKNOWN_OUTCOME', 'PENDING']);
    expect(bank.booked).toEqual([]);
    expect((await h.balance('seller', 'USD')).balance).toBe(units('1000'));
    expect((await h.balance('buyer', 'USD')).balance).toBe(units('0'));

    // The lookup answers: BANK_BUY was never booked, so it is posted (same key), then BANK_SELL.
    bank.buyDown = false;
    bank.lookupDown = false;
    await h.ctx.settlement.resumePending();
    expect(await legStatuses()).toEqual(['SETTLED', 'SETTLED']);
    expect(bank.booked).toEqual([`fill:${id}:BANK_BUY`, `fill:${id}:BANK_SELL`]);
    expect((await h.balance('seller', 'USD')).balance).toBe(units('900'));
    expect((await h.balance('buyer', 'USD')).balance).toBe(units('100'));
  });

  it('confirms a first leg that was booked with its response lost, without posting it again', async () => {
    const bank = new FlakyBank();
    bank.buyBookedButLost = true;
    const id = await trade(bank);
    expect(await legStatuses()).toEqual(['UNKNOWN_OUTCOME', 'PENDING']);
    expect(bank.booked).toEqual([`fill:${id}:BANK_BUY`]);

    bank.lookupDown = false;
    expect(await h.ctx.settlement.settle(id)).toBe('SETTLED');
    expect(bank.booked).toEqual([`fill:${id}:BANK_BUY`, `fill:${id}:BANK_SELL`]);
    expect((await h.balance('seller', 'USD')).balance).toBe(units('900'));
    expect((await h.balance('buyer', 'USD')).balance).toBe(units('100'));
  });

  it('lets one worker at a time settle a fill', async () => {
    const bank = new FlakyBank();
    const id = await trade(bank);
    bank.buyDown = false;
    bank.lookupDown = false;
    bank.delayMs = 50;
    const outcomes = await Promise.all([h.ctx.settlement.settle(id), h.ctx.settlement.settle(id)]);
    expect(outcomes.sort()).toEqual(['IN_PROGRESS', 'SETTLED']);
    await expect(h.ctx.settlement.retry(id, 'ops')).rejects.toMatchObject({ code: 'NOTHING_TO_RETRY' });
  });
});

describe('R02: an unconfirmed reversal is never taken as settled', () => {
  class Bank extends MockCoreBank {
    rejectSell = true;
    loseReversal = true;
    reversals = 0;
    override async postFxTransaction(r: FxTransactionRequest) {
      if (r.leg === 'BANK_SELL' && this.rejectSell) throw new CoreBankingError('INVALID_REQUEST', 'temporary business rejection');
      return super.postFxTransaction(r);
    }
    override async reverseFxTransaction(ref: string, key: string): Promise<{ reversalRef: string }> {
      const res = await super.reverseFxTransaction(ref, key);
      this.reversals++;
      if (this.loseReversal) throw new CoreBankingError('UNAVAILABLE', 'reversal booked, response lost');
      return res;
    }
  }

  it('keeps the leg REVERSAL_PENDING and re-sends nothing until the reversal is confirmed', async () => {
    const bank = new Bank();
    const id = await trade(bank);
    expect(await legStatuses()).toEqual(['REVERSAL_PENDING', 'FAILED_NEEDS_REVIEW']);
    expect((await h.balance('seller', 'USD')).balance).toBe(units('1000'));

    bank.rejectSell = false;
    await expect(h.ctx.settlement.retry(id, 'review')).rejects.toMatchObject({ code: 'REVERSAL_PENDING' });
    await h.ctx.settlement.resumePending();
    expect(await legStatuses()).toEqual(['REVERSAL_PENDING', 'FAILED_NEEDS_REVIEW']);
    expect((await h.balance('seller', 'USD')).balance).toBe(units('1000'));
    expect((await h.balance('buyer', 'USD')).balance).toBe(units('0'));
    const ready = await h.req('GET', '/ready');
    expect(ready.body).toMatchObject({ settlements_needing_review: 2, reversals_unconfirmed: 1 });

    // The same reversal key confirms the reversal (core banking does not reverse twice); then both legs go again.
    bank.loseReversal = false;
    expect(await h.ctx.settlement.retry(id, 'review')).toBe('SETTLED');
    expect(await legStatuses()).toEqual(['SETTLED', 'SETTLED']);
    expect((await h.balance('seller', 'USD')).balance).toBe(units('900'));
    expect((await h.balance('buyer', 'USD')).balance).toBe(units('100'));
  });

  it('confirms a pending reversal on the scheduler without operations', async () => {
    const bank = new Bank();
    await trade(bank);
    bank.loseReversal = false;
    await h.ctx.settlement.resumePending();
    expect(await legStatuses()).toEqual(['REVERSED', 'FAILED_NEEDS_REVIEW']);
    expect((await h.balance('seller', 'USD')).balance).toBe(units('1000'));
  });
});

describe('R03: an LP clip is not dropped because the LP is slow to show it', () => {
  async function unknownClip() {
    h = await startHarness();
    h.liquidity.losingResponses.add('LP-A');
    const r = await h.req('POST', '/ops/dealing/hedges', OPS, { pair: 'USDTRY', side: 'BUY', qty: '100' });
    expect(r.body.unknown).toBe('100.00');
    const find = h.liquidity.findExecution.bind(h.liquidity);
    h.liquidity.findExecution = async () => undefined;
    await h.ctx.db.query("update hedges set created_at = now() - interval '31 seconds'");
    return find;
  }
  const usd = async () => (await h.ctx.positions.snapshot()).find((p) => p.pair === 'USDTRY')!;

  it('keeps the clip UNKNOWN and in the position until the LP shows it', async () => {
    const find = await unknownClip();
    await h.ctx.positions.resolveOpenClips();
    expect((await h.ctx.db.query('select status from hedges')).rows).toEqual([{ status: 'UNKNOWN' }]);
    expect(await usd()).toMatchObject({ qty: '100.00', unconfirmedHedgeQty: '100.00' });

    h.liquidity.findExecution = find;
    await h.ctx.scheduler.tick();
    expect((await h.ctx.db.query('select status from hedges')).rows).toEqual([{ status: 'DONE' }]);
    expect(await usd()).toMatchObject({ qty: '100.00', unconfirmedHedgeQty: '0.00' });
  });

  it('lets operations close a clip only after the LP is asked again', async () => {
    await unknownClip();
    const id = (await h.ctx.db.query('select id from hedges')).rows[0].id;
    // The LP still does not show it: the operator's rejection stands.
    const rejected = await h.req('POST', `/ops/dealing/hedges/${id}/resolve`, OPS, { outcome: 'REJECTED', note: 'LP desk confirmed no trade' });
    expect(rejected.body.status).toBe('REJECTED');
    expect((await usd()).qty).toBe('0.00');
  });

  it('records the clip as DONE when the LP shows it at the moment operations try to reject it', async () => {
    const find = await unknownClip();
    h.liquidity.findExecution = find;
    const id = (await h.ctx.db.query('select id from hedges')).rows[0].id;
    const res = await h.req('POST', `/ops/dealing/hedges/${id}/resolve`, OPS, { outcome: 'REJECTED', note: 'LP desk confirmed no trade' });
    expect(res.body.status).toBe('DONE');
    expect((await usd()).qty).toBe('100.00');
  });
});

describe('R04: an instance without matching refuses commands before any side effect', () => {
  it('records and holds nothing', async () => {
    h = await startHarness({ matching: false });
    h.customer('seller', { USD: '1000', TRY: '0' });
    const seller = await h.login('seller');
    const r = await h.place(seller, { side: 'SELL', qty: '100', price: '49.15' });
    expect(r).toMatchObject({ status: 503, body: { error: 'MATCHING_UNAVAILABLE' } });
    expect((await h.ctx.db.query('select count(*)::int as n from orders')).rows[0].n).toBe(0);
    expect((await h.balance('seller', 'USD')).available).toBe(units('1000'));

    for (const [method, url, token, body] of [
      ['DELETE', '/v1/orders/00000000-0000-0000-0000-000000000000', seller, undefined],
      ['POST', '/v1/bank/quotes', seller, { pair: 'USDTRY', side: 'BUY', qty: '1' }],
      ['POST', '/v1/bank/deals', seller, { quoteId: '00000000-0000-0000-0000-000000000000' }],
      ['POST', '/ops/dealing/hedges', OPS, { pair: 'USDTRY', side: 'BUY', qty: '100' }],
      ['POST', '/ops/settlements/x/retry', OPS, {}],
    ] as const) {
      expect((await h.req(method, url, token, body)).status, `${method} ${url}`).toBe(503);
    }
    expect((await h.ctx.db.query('select count(*)::int as n from hedges')).rows[0].n).toBe(0);
    expect((await h.ctx.db.query('select count(*)::int as n from bank_quotes')).rows[0].n).toBe(0);
    // Reads still work.
    expect((await h.req('GET', '/v1/pairs/USDTRY/book', seller)).status).toBe(200);
  });
});

describe('R05: a hold whose response was lost is released', () => {
  it('releases it at entry by the order reference', async () => {
    const bank = new MockCoreBank();
    bank.setReferenceRate('USDTRY', '49.15');
    h = await startHarness({ bank });
    h.customer('seller', { USD: '1000', TRY: '0' });
    const original = bank.placeHold.bind(bank);
    bank.placeHold = async (...args) => {
      await original(...args);
      throw new CoreBankingError('UNAVAILABLE', 'hold response lost');
    };
    expect((await h.place(await h.login('seller'), { side: 'SELL', qty: '100', price: '49.15' })).status).toBe(422);
    const order = (await h.ctx.db.query('select id, status from orders')).rows[0];
    expect(order.status).toBe('REJECTED');
    expect(await bank.findHolds(`order:${order.id}`)).toEqual([]);
    expect((await h.balance('seller', 'USD')).available).toBe(units('1000'));
  });

  it('keeps retrying the cleanup across a restart when the lookup fails', async () => {
    const bank = new MockCoreBank();
    bank.setReferenceRate('USDTRY', '49.15');
    h = await startHarness({ bank });
    h.customer('seller', { USD: '1000', TRY: '0' });
    const placeHold = bank.placeHold.bind(bank);
    const findHolds = bank.findHolds.bind(bank);
    bank.placeHold = async (...args) => {
      await placeHold(...args);
      throw new CoreBankingError('UNAVAILABLE', 'hold response lost');
    };
    bank.findHolds = async () => {
      throw new CoreBankingError('UNAVAILABLE', 'lookup unavailable');
    };
    expect((await h.place(await h.login('seller'), { side: 'SELL', qty: '100', price: '49.15' })).status).toBe(422);
    const order = (await h.ctx.db.query('select id from orders')).rows[0];
    expect((await h.balance('seller', 'USD')).available).toBe(units('900'));

    await h.close();
    bank.findHolds = findHolds;
    h = await startHarness({ bank, reset: false });
    await h.ctx.scheduler.tick();
    expect(await bank.findHolds(`order:${order.id}`)).toEqual([]);
    expect((await h.balance('seller', 'USD')).available).toBe(units('1000'));
    expect((await h.ctx.db.query('select count(*)::int as n from hold_tasks where not done')).rows[0].n).toBe(0);
  });
});

describe('R06: a queued hold adjustment never outlives the order', () => {
  it('does not re-open the hold of a filled order', async () => {
    h = await startHarness();
    h.customer('buyer', { USD: '0', TRY: '100000' });
    h.customer('seller', { USD: '1000', TRY: '0' });
    const buyer = await h.login('buyer');
    const seller = await h.login('seller');
    const buy = await h.place(buyer, { side: 'BUY', qty: '200', price: '49.15' });
    const adjust = h.bank.adjustHold.bind(h.bank);
    h.bank.adjustHold = async () => {
      throw new CoreBankingError('UNAVAILABLE', 'adjust failed');
    };
    await h.place(seller, { side: 'SELL', qty: '100', price: '49.15' });
    h.bank.adjustHold = adjust;
    await h.place(seller, { side: 'SELL', qty: '100', price: '49.15' });
    await h.ctx.exchange.retryHoldTasks();
    const after = await h.balance('buyer', 'TRY');
    expect(after.available).toBe(after.balance);
    expect((await h.ctx.db.query('select status from orders where id=$1', [buy.body.id])).rows[0].status).toBe('FILLED');
    expect((await h.ctx.db.query('select count(*)::int as n from hold_tasks where not done')).rows[0].n).toBe(0);
  });

  it('adjusts a live order to what its remaining quantity needs now, not the queued amount', async () => {
    h = await startHarness();
    h.customer('buyer', { USD: '0', TRY: '100000' });
    h.customer('seller', { USD: '1000', TRY: '0' });
    h.customer('ref', { USD: '0', TRY: '100000' });
    const buyer = await h.login('buyer');
    await h.place(buyer, { side: 'BUY', qty: '200', price: '49.15' });
    h.bank.adjustHold = async () => {
      throw new CoreBankingError('UNAVAILABLE', 'adjust failed');
    };
    await h.place(await h.login('seller'), { side: 'SELL', qty: '100', price: '49.15' });
    // A stale queued amount (as if an older adjustment had failed) must not be applied.
    await h.ctx.db.query(`update hold_tasks set amount = 1`);
    h.bank.adjustHold = MockCoreBank.prototype.adjustHold.bind(h.bank);
    await h.ctx.exchange.retryHoldTasks();
    // Reference: a 100 USD order at the same price holds exactly what 100 USD remaining needs.
    await h.place(await h.login('ref'), { side: 'BUY', qty: '100', price: '49.15' });
    const b = await h.balance('buyer', 'TRY');
    const r = await h.balance('ref', 'TRY');
    expect(r.balance - r.available).toBeGreaterThan(0n);
    expect(b.balance - b.available).toBe(r.balance - r.available);
  });
});

describe('R07: every fill checks the taker’s validity and the session', () => {
  it('expires the taker between two fills instead of filling it further', async () => {
    h = await startHarness();
    h.customer('buyer', { USD: '0', TRY: '100000' });
    h.customer('seller', { USD: '1000', TRY: '0' });
    const buyer = await h.login('buyer');
    const seller = await h.login('seller');
    await h.place(seller, { side: 'SELL', qty: '100', price: '49.15' });
    await h.place(seller, { side: 'SELL', qty: '100', price: '49.15' });
    const original = h.bank.postFxTransaction.bind(h.bank);
    h.bank.postFxTransaction = async (r) => {
      const result = await original(r);
      h.clock.now = new Date(h.clock.now.getTime() + 2000);
      return result;
    };
    const buy = await h.place(buyer, { side: 'BUY', qty: '200', price: '49.15', validity: 'GTD', expiresAt: new Date(h.clock.now.getTime() + 1000).toISOString() });
    expect(buy.body).toMatchObject({ status: 'EXPIRED', cancelReason: 'EXPIRED', filledQty: '100.00' });
    expect((await h.ctx.db.query('select count(*)::int as n from fills')).rows[0].n).toBe(1);
    expect(h.ctx.exchange.depth('USDTRY').asks).toEqual([{ price: '49.15', qty: '100.00', count: 1 }]);
    const b = await h.balance('buyer', 'TRY');
    expect(b.available).toBe(b.balance);
  });
});

describe('R08: a bank quote is valid until it is claimed', () => {
  it('refuses a quote that expired during the account lookup', async () => {
    h = await startHarness();
    h.customer('buyer', { USD: '0', TRY: '100000' });
    const buyer = await h.login('buyer');
    const q = await h.req('POST', '/v1/bank/quotes', buyer, { pair: 'USDTRY', side: 'BUY', qty: '100' });
    const original = h.bank.getAccounts.bind(h.bank);
    h.bank.getAccounts = async (ref) => {
      const accounts = await original(ref);
      h.clock.now = new Date(new Date(q.body.expiresAt).getTime() + 1000);
      return accounts;
    };
    const d = await h.req('POST', '/v1/bank/deals', buyer, { quoteId: q.body.id });
    expect(d).toMatchObject({ status: 410, body: { error: 'QUOTE_EXPIRED' } });
    expect((await h.ctx.db.query('select count(*)::int as n from bank_deals')).rows[0].n).toBe(0);
    expect((await h.ctx.db.query('select status from bank_quotes')).rows).toEqual([{ status: 'OPEN' }]);
    expect((await h.balance('buyer', 'USD')).balance).toBe(units('0'));
  });
});
