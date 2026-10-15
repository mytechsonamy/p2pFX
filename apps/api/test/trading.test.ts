import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OPS, startHarness, units, type Harness } from './helpers.js';

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

describe('session', () => {
  it('exchanges a bank launch token once', async () => {
    const token = await h.launchToken('alice');
    const first = await h.req('POST', '/v1/session', undefined, { launchToken: token });
    expect(first.status).toBe(200);
    expect(first.body.customer).toMatchObject({ ref: 'alice', segment: 'default' });
    const again = await h.req('POST', '/v1/session', undefined, { launchToken: token });
    expect(again.status).toBe(401);
    expect((await h.req('GET', '/v1/accounts')).status).toBe(401);
  });
});

describe('block mode', () => {
  it('matches at the maker price, settles both legs and books commission and tax', async () => {
    h.customer('alice', { USD: '1000', TRY: '0' });
    h.customer('bob', { USD: '0', TRY: '100000' });
    const alice = await h.login('alice');
    const bob = await h.login('bob');

    const sell = await h.place(alice, { side: 'SELL', qty: '1000', price: '49.15' });
    expect(sell.status).toBe(201);
    expect(sell.body.status).toBe('OPEN');
    expect(await h.balance('alice', 'USD')).toEqual({ balance: units('1000'), available: 0n });

    // Bob is willing to pay up to 49.20 and gets the resting 49.15.
    const quote = await h.req('POST', '/v1/orders/quote', bob, { pair: 'USDTRY', side: 'BUY', qty: '1000', price: '49.20' });
    expect(quote.body).toMatchObject({ effectivePrice: '49.25', gross: '49250.00', tax: '98.50', total: '49348.50' });

    const buy = await h.place(bob, { side: 'BUY', qty: '1000', price: '49.20' });
    expect(buy.status).toBe(201);
    expect(buy.body.status).toBe('FILLED');

    const sold = await h.req('GET', `/v1/orders/${sell.body.id}`, alice);
    expect(sold.body.status).toBe('FILLED');

    // Seller: 1000 × 49.10 = 49,100.00, no kambiyo vergisi on a sale. Buyer: 1000 × 49.20 = 49,200.00 + tax 98.40; excess hold released.
    expect(await h.balance('alice', 'USD')).toEqual({ balance: 0n, available: 0n });
    expect(await h.balance('alice', 'TRY')).toEqual({ balance: units('49100.00'), available: units('49100.00') });
    expect(await h.balance('bob', 'USD')).toEqual({ balance: units('1000'), available: units('1000') });
    expect(await h.balance('bob', 'TRY')).toEqual({ balance: units('50701.60'), available: units('50701.60') });

    const bankAcc = Object.fromEntries(h.bank.bankAccounts().map((a) => [a.id, a.balance]));
    expect(bankAcc).toEqual({
      'BANK-POSITION-USD': 0n,
      'BANK-CLEARING-TRY': 0n,
      'BANK-COMMISSION-TRY': units('100.00'),
      'BANK-TAX-TRY': units('98.40'),
    });

    const bobFills = await h.req('GET', '/v1/fills', bob);
    expect(bobFills.body).toHaveLength(1);
    expect(bobFills.body[0]).toMatchObject({
      side: 'BUY', liquidity: 'TAKER', qty: '1000.00', bookPrice: '49.15', effectivePrice: '49.20',
      commission: '50.00', tax: '98.40', total: '49298.40', settlementStatus: 'SETTLED',
    });
    const aliceFills = await h.req('GET', '/v1/fills', alice);
    expect(aliceFills.body[0]).toMatchObject({ side: 'SELL', liquidity: 'MAKER', effectivePrice: '49.10', total: '49100.00' });

    const receipt = await h.req('GET', `/v1/fills/${bobFills.body[0].id}/receipt`, bob);
    expect(receipt.status).toBe(200);
    expect(receipt.body.title).toBe('Döviz Alış Dekontu');
    expect(receipt.body.lines).toContainEqual({ label: 'Hesabınızdan çekilen', value: '49298.40 TRY' });

    const revenue = await h.req('GET', '/ops/revenue', OPS);
    expect(revenue.body).toEqual([
      expect.objectContaining({ pair: 'USDTRY', fills: 1, volume: '1000.00', commission: { buySide: '50.00', sellSide: '50.00', total: '100.00' }, tax: { buyers: '98.40', sellers: '0.00', total: '98.40' } }),
    ]);

    expect(h.bank.notifications.map((n) => `${n.customerRef}:${n.event.type}`).sort()).toEqual(['alice:fill', 'bob:fill']);
  });

  it('partially fills a resting buy and shrinks its hold to what the rest needs', async () => {
    h.customer('alice', { USD: '1000', TRY: '0' });
    h.customer('bob', { USD: '0', TRY: '100000' });
    const alice = await h.login('alice');
    const bob = await h.login('bob');

    const buy = await h.place(bob, { side: 'BUY', qty: '1000', price: '49.20' });
    expect(await h.balance('bob', 'TRY')).toEqual({ balance: units('100000'), available: units('50651.50') });

    const sell = await h.place(alice, { side: 'SELL', qty: '400', price: '49.10' });
    expect(sell.body.status).toBe('FILLED');
    const b = await h.req('GET', `/v1/orders/${buy.body.id}`, bob);
    expect(b.body).toMatchObject({ status: 'PARTIAL', filledQty: '400.00', remainingQty: '600.00' });

    // Paid 19,739.40 for 400 at 49.20 (+0.05); 600 more at the limit still need 29,609.10 held.
    expect(await h.balance('bob', 'TRY')).toEqual({ balance: units('80260.60'), available: units('50651.50') });
    expect(await h.balance('alice', 'TRY')).toEqual({ balance: units('19660.00'), available: units('19660.00') });
    expect(await h.balance('alice', 'USD')).toEqual({ balance: units('600'), available: units('600') });

    const book = await h.req('GET', '/v1/pairs/USDTRY/book', bob);
    expect(book.body).toEqual({ pair: 'USDTRY', bids: [{ price: '49.20', qty: '600.00', count: 1 }], asks: [] });
  });

  it('shows trades and the day on the market board without customer details', async () => {
    h.customer('alice', { USD: '1000', TRY: '0' });
    h.customer('bob', { USD: '0', TRY: '100000' });
    const alice = await h.login('alice');
    const bob = await h.login('bob');
    await h.place(alice, { side: 'SELL', qty: '300', price: '49.10' });
    await h.place(alice, { side: 'SELL', qty: '500', price: '49.20' });
    await h.place(bob, { side: 'BUY', qty: '600', price: '49.20' });

    const trades = await h.req('GET', '/v1/pairs/USDTRY/trades', bob);
    expect(trades.body.map((t: { price: string; qty: string; takerSide: string }) => [t.price, t.qty, t.takerSide])).toEqual([
      ['49.20', '300.00', 'BUY'],
      ['49.10', '300.00', 'BUY'],
    ]);
    expect(Object.keys(trades.body[0]).sort()).toEqual(['at', 'id', 'pair', 'price', 'qty', 'takerSide']);

    const stats = await h.req('GET', '/v1/pairs/USDTRY/stats', alice);
    expect(stats.body).toEqual({
      pair: 'USDTRY', open: '49.10', high: '49.20', low: '49.10', last: '49.20', prevClose: null,
      volume: '600.00', turnover: '29490.00', trades: 2,
    });
    expect((await h.req('GET', '/v1/pairs/EURTRY/stats', alice)).body).toMatchObject({ last: null, volume: '0.00', trades: 0 });
  });

  it('rejects an order the customer cannot fund', async () => {
    h.customer('bob', { USD: '0', TRY: '1000' });
    const bob = await h.login('bob');
    const res = await h.place(bob, { side: 'BUY', qty: '100', price: '49.15' });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('INSUFFICIENT_BALANCE');
    expect(res.body.details.order.status).toBe('REJECTED');
  });

  it('cancel and expiry release the hold', async () => {
    h.customer('alice', { USD: '1000', TRY: '0' });
    let alice = await h.login('alice');
    const gtd = await h.place(alice, {
      side: 'SELL', qty: '300', price: '49.30', validity: 'GTD', expiresAt: new Date(h.clock.now.getTime() + 3_600_000).toISOString(),
    });
    const day = await h.place(alice, { side: 'SELL', qty: '200', price: '49.30', validity: 'DAY' });
    // Default hours are 00:00–24:00 Istanbul: DAY orders end at local midnight.
    expect(day.body.expiresAt).toBe('2026-10-05T21:00:00.000Z');
    const gtc = await h.place(alice, { side: 'SELL', qty: '100', price: '49.30' });
    expect(await h.balance('alice', 'USD')).toMatchObject({ available: units('400') });

    const cancelled = await h.req('DELETE', `/v1/orders/${gtc.body.id}`, alice);
    expect(cancelled.body).toMatchObject({ status: 'CANCELLED', cancelReason: 'USER' });
    expect((await h.req('DELETE', `/v1/orders/${gtc.body.id}`, alice)).status).toBe(409);
    expect(await h.balance('alice', 'USD')).toMatchObject({ available: units('500') });

    h.clock.now = new Date(h.clock.now.getTime() + 2 * 3_600_000);
    expect(await h.ctx.scheduler.tick()).toMatchObject({ expired: 1 });
    alice = await h.login('alice'); // the session expired meanwhile
    expect((await h.req('GET', `/v1/orders/${gtd.body.id}`, alice)).body).toMatchObject({ status: 'EXPIRED', cancelReason: 'EXPIRED' });
    expect(await h.balance('alice', 'USD')).toMatchObject({ available: units('800') });

    h.clock.now = new Date('2026-10-05T21:00:01Z');
    await h.ctx.scheduler.tick();
    alice = await h.login('alice');
    expect((await h.req('GET', `/v1/orders/${day.body.id}`, alice)).body.status).toBe('EXPIRED');
    expect(await h.balance('alice', 'USD')).toEqual({ balance: units('1000'), available: units('1000') });
    expect((await h.req('GET', '/v1/pairs/USDTRY/book', alice)).body.asks).toEqual([]);
  });
});

describe('no_block mode', () => {
  it('cancels a resting order that is short at match time and keeps matching', async () => {
    await h.setConfig((c) => ({ ...c, balanceMode: 'no_block' }));
    h.customer('alice', { USD: '1000', TRY: '0' });
    const carolAcc = h.customer('carol', { USD: '0', TRY: '60000' });
    h.customer('dave', { USD: '0', TRY: '60000' });
    const [alice, carol, dave] = await Promise.all(['alice', 'carol', 'dave'].map((r) => h.login(r)));

    const c = await h.place(carol, { side: 'BUY', qty: '1000', price: '49.15' });
    const d = await h.place(dave, { side: 'BUY', qty: '1000', price: '49.15' });
    expect(c.body.status).toBe('OPEN');
    expect(await h.balance('carol', 'TRY')).toMatchObject({ available: units('60000') }); // nothing held

    // Carol spends most of her money elsewhere.
    await h.bank.placeHold(carolAcc.TRY, units('50000'), 'card payment');

    const s = await h.place(alice, { side: 'SELL', qty: '1000', price: '49.15' });
    expect(s.body.status).toBe('FILLED');
    expect((await h.req('GET', `/v1/orders/${c.body.id}`, carol)).body).toMatchObject({ status: 'CANCELLED', cancelReason: 'INSUFFICIENT_BALANCE' });
    expect((await h.req('GET', `/v1/orders/${d.body.id}`, dave)).body.status).toBe('FILLED');
    expect(await h.balance('dave', 'USD')).toEqual({ balance: units('1000'), available: units('1000') });
    expect(await h.balance('dave', 'TRY')).toEqual({ balance: units('60000') - units('49298.40'), available: units('60000') - units('49298.40') });
    expect(await h.balance('carol', 'TRY')).toEqual({ balance: units('60000'), available: units('10000') });
    expect(h.bank.notifications).toContainEqual(expect.objectContaining({ customerRef: 'carol', event: expect.objectContaining({ type: 'order.cancelled' }) }));
  });

  it('cancels the incoming order when its own funds are gone', async () => {
    await h.setConfig((c) => ({ ...c, balanceMode: 'no_block' }));
    const aliceAcc = h.customer('alice', { USD: '1000', TRY: '0' });
    h.customer('bob', { USD: '0', TRY: '60000' });
    const [alice, bob] = await Promise.all(['alice', 'bob'].map((r) => h.login(r)));
    const b = await h.place(bob, { side: 'BUY', qty: '1000', price: '49.15' });
    // Alice's USD is gone by match time, but the entry check still saw it (simulated with a stale balance read).
    await h.bank.placeHold(aliceAcc.USD, units('1000'), 'other');
    const orig = h.bank.getAccounts.bind(h.bank);
    h.bank.getAccounts = async (ref) => (await orig(ref)).map((a) => ({ ...a, available: a.balance }));
    const res = await h.place(alice, { side: 'SELL', qty: '1000', price: '49.15' });
    h.bank.getAccounts = orig;
    expect(res.body).toMatchObject({ status: 'CANCELLED', cancelReason: 'INSUFFICIENT_BALANCE' });
    expect((await h.req('GET', `/v1/orders/${b.body.id}`, bob)).body.status).toBe('OPEN');
    expect(await h.balance('bob', 'TRY')).toMatchObject({ available: units('60000') });
  });
});

describe('order rules', () => {
  it('prevents self-matching by cancelling the incoming order', async () => {
    h.customer('alice', { USD: '1000', TRY: '100000' });
    const alice = await h.login('alice');
    const buy = await h.place(alice, { side: 'BUY', qty: '10', price: '49.15' });
    const sell = await h.place(alice, { side: 'SELL', qty: '10', price: '49.15' });
    expect(sell.body).toMatchObject({ status: 'CANCELLED', cancelReason: 'SELF_MATCH' });
    expect((await h.req('GET', `/v1/orders/${buy.body.id}`, alice)).body.status).toBe('OPEN');
    expect(await h.balance('alice', 'USD')).toMatchObject({ available: units('1000') });
  });

  it('validates price band, tick, minimum, limits and validity', async () => {
    h.customer('alice', { USD: '100000', TRY: '0' });
    const alice = await h.login('alice');
    const err = async (body: Record<string, unknown>) => (await h.place(alice, { side: 'SELL', qty: '10', price: '49.15', ...body })).body.error;
    expect(await err({ price: '55' })).toBe('PRICE_OUT_OF_BAND');
    expect(await err({ price: '49.15001' })).toBe('INVALID_PRICE');
    expect(await err({ qty: '0.5' })).toBe('QTY_TOO_SMALL');
    expect(await err({ qty: '10.001' })).toBe('INVALID_QTY');
    expect(await err({ qty: '30000' })).toBe('ORDER_LIMIT_EXCEEDED');
    expect(await err({ pair: 'HUFTRY' })).toBe('UNKNOWN_PAIR');
    expect(await err({ validity: 'GTD' })).toBe('EXPIRES_AT_REQUIRED');
    expect(await err({ validity: 'GTD', expiresAt: '2026-12-31T00:00:00Z' })).toBe('INVALID_EXPIRY');
    expect((await h.place(alice, { side: 'SELL', qty: '10', price: '50.6245' })).status).toBe(201); // +3.0% edge
  });

  it('is idempotent per Idempotency-Key', async () => {
    h.customer('alice', { USD: '1000', TRY: '0' });
    const alice = await h.login('alice');
    const first = await h.place(alice, { side: 'SELL', qty: '10', price: '49.15' }, 'key-1');
    const again = await h.place(alice, { side: 'SELL', qty: '10', price: '49.15' }, 'key-1');
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect(await h.balance('alice', 'USD')).toMatchObject({ available: units('990') });
    expect((await h.place(alice, { side: 'SELL', qty: '11', price: '49.15' }, 'key-1')).status).toBe(409);
    expect((await h.req('POST', '/v1/orders', alice, { pair: 'USDTRY', side: 'SELL', qty: '1', price: '49.15', validity: 'GTC' })).body.error).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('queues orders outside trading hours and releases them at the open', async () => {
    await h.setConfig((c) => ({
      ...c,
      tradingHours: { ...c.tradingHours, days: [1, 2, 3, 4, 5], open: '09:00', close: '18:00', outsideHours: 'queue' },
    }));
    h.customer('alice', { USD: '1000', TRY: '0' });
    h.customer('bob', { USD: '0', TRY: '100000' });
    h.clock.now = new Date('2026-10-04T10:00:00Z'); // Sunday
    const [alice, bob] = await Promise.all(['alice', 'bob'].map((r) => h.login(r)));
    const s = await h.place(alice, { side: 'SELL', qty: '100', price: '49.15', validity: 'DAY' });
    const b = await h.place(bob, { side: 'BUY', qty: '100', price: '49.15' });
    expect(s.body).toMatchObject({ status: 'QUEUED', expiresAt: '2026-10-05T15:00:00.000Z' });
    expect(b.body.status).toBe('QUEUED');

    await h.ctx.scheduler.tick();
    expect((await h.req('GET', `/v1/orders/${s.body.id}`, alice)).body.status).toBe('QUEUED');

    h.clock.now = new Date('2026-10-05T06:30:00Z'); // Monday 09:30 Istanbul
    expect(await h.ctx.scheduler.tick()).toMatchObject({ released: 2 });
    const alice2 = await h.login('alice');
    expect((await h.req('GET', `/v1/orders/${s.body.id}`, alice2)).body.status).toBe('FILLED');

    await h.setConfig((c) => ({ ...c, tradingHours: { ...c.tradingHours, outsideHours: 'reject' } }));
    h.clock.now = new Date('2026-10-05T16:00:00Z');
    const closed = await h.place(await h.login('alice'), { side: 'SELL', qty: '100', price: '49.15' });
    expect(closed.body.error).toBe('MARKET_CLOSED');
  });

  it('uses the commission and tax the customer confirmed, even after a config change', async () => {
    h.customer('alice', { USD: '1000', TRY: '0' });
    h.customer('bob', { USD: '0', TRY: '100000' });
    const [alice, bob] = await Promise.all(['alice', 'bob'].map((r) => h.login(r)));
    await h.place(alice, { side: 'SELL', qty: '1000', price: '49.15' });
    await h.setConfig((c) => ({ ...c, pairs: c.pairs.map((p) => ({ ...p, commission: { mode: 'PIPS' as const, buy: 1000, sell: 1000 } })) }));
    await h.place(bob, { side: 'BUY', qty: '1000', price: '49.15' });
    const [aliceFill] = (await h.req('GET', '/v1/fills', alice)).body;
    const [bobFill] = (await h.req('GET', '/v1/fills', bob)).body;
    expect(aliceFill).toMatchObject({ commission: '50.00', effectivePrice: '49.10' });
    expect(bobFill).toMatchObject({ commission: '100.00', effectivePrice: '49.25' });
  });
});
