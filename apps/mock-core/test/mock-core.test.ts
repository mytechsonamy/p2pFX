import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpCoreBankingAdapter, CoreBankingError } from '@p2p/core-adapter';
import { buildMockCore } from '../src/server.js';

const app = buildMockCore();
let client: HttpCoreBankingAdapter;

beforeAll(async () => {
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  client = new HttpCoreBankingAdapter(address);
});
afterAll(() => app.close());

describe('mock-core over HTTP', () => {
  it('serves accounts, holds, rates and maps errors', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/customers', payload: { customerRef: 'c1', accounts: [{ currency: 'USD', balance: '100.00' }] } });
    expect(res.statusCode).toBe(200);
    const [acc] = await client.getAccounts('c1');
    expect(acc.balance).toBe(10_000n);
    const { holdId } = await client.placeHold(acc.id, 4_000n, 'x');
    expect((await client.getAccounts('c1'))[0].available).toBe(6_000n);
    await client.releaseHold(holdId);
    const err = await client.placeHold(acc.id, 20_000n, 'y').catch((e) => e);
    expect(err).toBeInstanceOf(CoreBankingError);
    expect(err.code).toBe('INSUFFICIENT_FUNDS');
    await client.setReferenceRate('USDTRY', '49.15');
    expect((await client.getReferenceRate('USDTRY')).rate).toBe('49.15');
  });
});

describe('FX postings over HTTP', () => {
  it('lists the postings of a time window for reconciliation, amounts as bigint', async () => {
    await app.inject({ method: 'POST', url: '/admin/customers', payload: { customerRef: 'c2', accounts: [{ currency: 'USD', balance: '0' }, { currency: 'TRY', balance: '1000.00' }] } });
    const [usd, tl] = await client.getAccounts('c2');
    const before = new Date(Date.now() - 1000);
    const posted = await client.postFxTransaction({
      leg: 'BANK_SELL', customerRef: 'c2', fxAccountId: usd.id, tryAccountId: tl.id, currency: 'USD', quoteCurrency: 'TRY',
      qty: 1_000n, bookPrice: '49.15', effectivePrice: '49.20', notional: 49_150n, commission: 50n, tax: 99n, customerAmount: 49_299n,
      holdIds: [], idempotencyKey: 'fill:00000000-0000-0000-0000-000000000009:BANK_SELL', reference: 'P2P-00000009',
    });
    const list = await client.listFxTransactions(before, new Date(Date.now() + 1000));
    expect(list).toEqual([
      expect.objectContaining({ txnRef: posted.txnRef, idempotencyKey: 'fill:00000000-0000-0000-0000-000000000009:BANK_SELL', qty: 1_000n, customerAmount: 49_299n, commission: 50n, tax: 99n, reversed: false }),
    ]);
    expect(await client.listFxTransactions(new Date(Date.now() + 1000), new Date(Date.now() + 2000))).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/fx-transactions/list?from=nope' })).statusCode).toBe(400);
  });
});

describe('simulated liquidity providers', () => {
  it('quote around the reference rate and fill at their own price', async () => {
    await client.setReferenceRate('EURTRY', '53.40');
    const quotes = (await app.inject({ method: 'GET', url: '/lp/quotes/EURTRY' })).json();
    expect(quotes.map((q: { lp: string }) => q.lp)).toEqual(['LP-A', 'LP-B', 'LP-C']);
    for (const q of quotes) expect(Math.abs((Number(q.bid) + Number(q.ask)) / 2 - 53.4)).toBeLessThan(0.5);
    const exec = (await app.inject({ method: 'POST', url: '/lp/executions', payload: { lp: 'LP-B', pair: 'EURTRY', side: 'BUY', qty: '100.00', ref: 'h1' } })).json();
    expect(exec).toMatchObject({ lp: 'LP-B', side: 'BUY', tradeRef: expect.stringMatching(/^LP-B-/) });
    expect((await app.inject({ method: 'GET', url: '/lp/quotes/XXXTRY' })).statusCode).toBe(422);
  });
});
