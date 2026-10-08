import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startHarness, units, type Harness } from './helpers.js';

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

const amend = (token: string, id: string, body: { price: string; qty: string }) => h.req('PATCH', `/v1/orders/${id}`, token, body);

describe('amending an order', () => {
  it('keeps time priority when only the quantity goes down, and gives back the hold it no longer needs', async () => {
    h.customer('alice', { USD: '1000', TRY: '0' });
    h.customer('carol', { USD: '1000', TRY: '0' });
    h.customer('bob', { USD: '0', TRY: '100000' });
    const alice = await h.login('alice');
    const carol = await h.login('carol');
    const bob = await h.login('bob');

    const first = await h.place(alice, { side: 'SELL', qty: '1000', price: '49.15' });
    await h.place(carol, { side: 'SELL', qty: '1000', price: '49.15' });

    const res = await amend(alice, first.body.id, { price: '49.15', qty: '400' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'OPEN', qty: '400.00', remainingQty: '400.00' });
    expect(res.body.amendedAt).toBeTruthy();
    expect(await h.balance('alice', 'USD')).toEqual({ balance: units('1000'), available: units('600') });

    // Alice is still first in the queue at 49.15.
    await h.place(bob, { side: 'BUY', qty: '400', price: '49.15' });
    expect((await h.req('GET', `/v1/orders/${first.body.id}`, alice)).body.status).toBe('FILLED');
    const book = await h.req('GET', '/v1/pairs/USDTRY/book', bob);
    expect(book.body.asks).toEqual([{ price: '49.15', qty: '1000.00', count: 1 }]);
  });

  it('sends the order to the back of the queue when its price changes and matches it at once if it crosses', async () => {
    h.customer('alice', { USD: '1000', TRY: '0' });
    h.customer('bob', { USD: '0', TRY: '100000' });
    const alice = await h.login('alice');
    const bob = await h.login('bob');

    const buy = await h.place(bob, { side: 'BUY', qty: '1000', price: '49.10' });
    const sell = await h.place(alice, { side: 'SELL', qty: '1000', price: '49.30' });
    expect(sell.body.status).toBe('OPEN');

    // Alice comes down to Bob's bid: she is the incoming order and trades at his (the resting) price.
    const res = await amend(alice, sell.body.id, { price: '49.10', qty: '1000' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('FILLED');
    expect((await h.req('GET', `/v1/orders/${buy.body.id}`, bob)).body.status).toBe('FILLED');
    const fills = await h.req('GET', '/v1/fills', alice);
    expect(fills.body[0]).toMatchObject({ side: 'SELL', liquidity: 'TAKER', bookPrice: '49.10', effectivePrice: '49.05', total: '49050.00' });
  });

  it('grows a buy hold when the price goes up, and changes nothing when the balance is short', async () => {
    h.customer('bob', { USD: '0', TRY: '50000' });
    const bob = await h.login('bob');
    const buy = await h.place(bob, { side: 'BUY', qty: '1000', price: '49.00' });
    // 1000 × 49.05 = 49,050.00 + tax 98.10.
    expect(await h.balance('bob', 'TRY')).toEqual({ balance: units('50000'), available: units('851.90') });

    // 1000 × 49.85 + tax = 49,949.70: still fits.
    const up = await amend(bob, buy.body.id, { price: '49.80', qty: '1000' });
    expect(up.status).toBe(200);
    expect(await h.balance('bob', 'TRY')).toEqual({ balance: units('50000'), available: units('50.30') });

    const short = await amend(bob, buy.body.id, { price: '49.90', qty: '1000' });
    expect(short).toMatchObject({ status: 422, body: { error: 'INSUFFICIENT_BALANCE' } });
    expect((await h.req('GET', `/v1/orders/${buy.body.id}`, bob)).body).toMatchObject({ price: '49.80', qty: '1000.00' });
    expect(await h.balance('bob', 'TRY')).toEqual({ balance: units('50000'), available: units('50.30') });

    // Coming down gives the difference back.
    await amend(bob, buy.body.id, { price: '49.00', qty: '500' });
    expect(await h.balance('bob', 'TRY')).toEqual({ balance: units('50000'), available: units('25425.95') });
  });

  it('changes only what is left of a partly filled order', async () => {
    h.customer('alice', { USD: '1000', TRY: '0' });
    h.customer('bob', { USD: '0', TRY: '100000' });
    const alice = await h.login('alice');
    const bob = await h.login('bob');
    const sell = await h.place(alice, { side: 'SELL', qty: '1000', price: '49.15' });
    await h.place(bob, { side: 'BUY', qty: '300', price: '49.15' });

    expect(await amend(alice, sell.body.id, { price: '49.15', qty: '300' })).toMatchObject({ status: 422, body: { error: 'INVALID_QTY' } });
    const res = await amend(alice, sell.body.id, { price: '49.20', qty: '500' });
    expect(res.body).toMatchObject({ status: 'PARTIAL', qty: '500.00', filledQty: '300.00', remainingQty: '200.00', price: '49.20' });
    expect(await h.balance('alice', 'USD')).toEqual({ balance: units('700'), available: units('500') });
  });

  it('prices the amended order with the configuration in force now', async () => {
    h.customer('bob', { USD: '0', TRY: '100000' });
    const bob = await h.login('bob');
    const buy = await h.place(bob, { side: 'BUY', qty: '1000', price: '49.00' });
    expect(buy.body.quote).toMatchObject({ commissionPerUnit: '0.05' });

    await h.setConfig((c) => ({ ...c, pairs: c.pairs.map((p) => (p.symbol === 'USDTRY' ? { ...p, commission: { ...p.commission, buy: 300 } } : p)) }));
    const res = await amend(bob, buy.body.id, { price: '49.00', qty: '900' });
    expect(res.body.quote).toMatchObject({ commissionPerUnit: '0.03', effectivePrice: '49.03' });
  });

  it('checks the daily limit at the new value', async () => {
    await h.setConfig((c) => ({ ...c, limits: { ...c.limits, default: { maxOrderNotional: '1000000', maxDailyNotional: '100000' } } }));
    h.customer('alice', { USD: '5000', TRY: '0' });
    const alice = await h.login('alice');
    const sell = await h.place(alice, { side: 'SELL', qty: '1000', price: '49.15' });
    // The order itself is not counted twice: 2,000 × 49.15 = 98,300 fits.
    expect((await amend(alice, sell.body.id, { price: '49.15', qty: '2000' })).status).toBe(200);
    expect(await amend(alice, sell.body.id, { price: '49.15', qty: '2100' })).toMatchObject({ status: 422, body: { error: 'DAILY_LIMIT_EXCEEDED' } });
  });

  it('is idempotent, and refuses orders that are not the customer’s or not live', async () => {
    h.customer('alice', { USD: '1000', TRY: '0' });
    h.customer('bob', { USD: '0', TRY: '100000' });
    const alice = await h.login('alice');
    const bob = await h.login('bob');
    const sell = await h.place(alice, { side: 'SELL', qty: '1000', price: '49.15' });

    const same = await amend(alice, sell.body.id, { price: '49.15', qty: '1000' });
    expect(same.status).toBe(200);
    expect(same.body.amendedAt).toBeUndefined();

    expect((await amend(bob, sell.body.id, { price: '49.10', qty: '1000' })).status).toBe(404);
    await h.req('DELETE', `/v1/orders/${sell.body.id}`, alice);
    expect(await amend(alice, sell.body.id, { price: '49.10', qty: '1000' })).toMatchObject({ status: 409, body: { error: 'ORDER_NOT_AMENDABLE' } });
  });

  it('rejects a price outside the band without touching the order', async () => {
    h.customer('alice', { USD: '1000', TRY: '0' });
    const alice = await h.login('alice');
    const sell = await h.place(alice, { side: 'SELL', qty: '1000', price: '49.15' });
    expect(await amend(alice, sell.body.id, { price: '60.00', qty: '1000' })).toMatchObject({ status: 422, body: { error: 'PRICE_OUT_OF_BAND' } });
    expect((await h.req('GET', `/v1/orders/${sell.body.id}`, alice)).body).toMatchObject({ price: '49.15', status: 'OPEN' });
  });
});
