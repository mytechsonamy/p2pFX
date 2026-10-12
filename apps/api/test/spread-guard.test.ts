import { afterEach, describe, expect, it } from 'vitest';
import type { LpQuote } from '@p2p/core-adapter';
import { OPS, startHarness, type Harness } from './helpers.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
  h = undefined as unknown as Harness;
});

/** Replaces the LPs' USDTRY prices with these (bid, ask) pairs, stamped now, and lets the price cache expire. */
function quote(prices: [string, string][]) {
  const at = () => h.clock.now.toISOString();
  const inner = h.liquidity.quotes.bind(h.liquidity);
  h.liquidity.quotes = async (pair: string): Promise<LpQuote[]> =>
    pair === 'USDTRY' ? prices.map(([bid, ask], i) => ({ lp: `LP-${'ABC'[i]}`, pair, bid, ask, at: at() })) : inner(pair);
  h.clock.now = new Date(h.clock.now.getTime() + 2000);
}

describe('spread guard', () => {
  it('stops the bank price while the LP spread is wider than the limit and brings it back when it narrows', async () => {
    h = await startHarness();
    h.customer('ayse', { USD: '0', TRY: '100000' });
    const ayse = await h.login('ayse');
    expect((await h.req('GET', '/v1/bank/rates/USDTRY', ayse)).status).toBe(200);

    // 49.00 / 50.00 is about 202 bps of the mid, beyond the default 100.
    quote([['49.00', '50.00']]);
    const wide = await h.req('GET', '/v1/bank/rates/USDTRY', ayse);
    expect(wide.status).toBe(503);
    expect(wide.body).toMatchObject({ error: 'PRICE_UNAVAILABLE', details: { reason: 'WIDE_MARKET' } });
    expect((await h.req('POST', '/v1/bank/quotes', ayse, { pair: 'USDTRY', side: 'BUY', qty: '100' })).status).toBe(503);
    expect(h.ctx.prices.fresh('USDTRY')).toBeUndefined();
    expect(h.ctx.prices.offState('USDTRY')).toEqual({ reason: 'WIDE_MARKET' });

    // A pair can carry its own, wider limit.
    await h.setConfig((c) => ({ ...c, pairs: c.pairs.map((p) => (p.symbol === 'USDTRY' ? { ...p, maxSpreadBps: 300 } : p)) }));
    h.clock.now = new Date(h.clock.now.getTime() + 2000);
    expect((await h.req('GET', '/v1/bank/rates/USDTRY', ayse)).status).toBe(200);
    expect(h.ctx.prices.offState('USDTRY')).toBeUndefined();
  });

  it('does not quote a crossed market (one LP bidding above another one offering)', async () => {
    h = await startHarness();
    const ayse = await h.login('ayse');
    quote([['49.20', '49.21'], ['49.10', '49.15']]);
    const crossed = await h.req('GET', '/v1/bank/rates/USDTRY', ayse);
    expect(crossed.status).toBe(503);
    expect(crossed.body.details).toEqual({ reason: 'WIDE_MARKET' });
  });

  it('reports no price, not a stale one, when the LPs stop answering', async () => {
    h = await startHarness();
    const ayse = await h.login('ayse');
    expect((await h.req('GET', '/v1/bank/rates/USDTRY', ayse)).status).toBe(200);
    h.liquidity.quotes = async () => {
      throw new Error('LP down');
    };
    h.clock.now = new Date(h.clock.now.getTime() + 2000);
    const down = await h.req('GET', '/v1/bank/rates/USDTRY', ayse);
    expect(down.status).toBe(503);
    expect(down.body.details).toEqual({ reason: 'NO_PRICE' });
  });
});

describe('LP market hours', () => {
  it('gives no bank price while the FX market is closed and says when it opens', async () => {
    h = await startHarness();
    // Saturday noon.
    h.clock.now = new Date('2026-10-10T12:00:00Z');
    const ayse = await h.login('ayse');
    const closed = await h.req('GET', '/v1/bank/rates/USDTRY', ayse);
    expect(closed.status).toBe(503);
    expect(closed.body.details).toEqual({ reason: 'MARKET_CLOSED', nextOpen: '2026-10-11T21:00:00.000Z' });
    expect(h.ctx.prices.offState('USDTRY')).toEqual({ reason: 'MARKET_CLOSED', nextOpen: '2026-10-11T21:00:00.000Z' });
    // Sunday evening it opens again.
    h.clock.now = new Date('2026-10-11T21:00:05Z');
    expect((await h.req('GET', '/v1/bank/rates/USDTRY', await h.login('ayse'))).status).toBe(200);
  });
});

describe('off-hours bank price', () => {
  it('quotes from the close, widened, with a smaller inventory cap, and hedges once the market opens', async () => {
    h = await startHarness();
    await h.setConfig((c) => ({ ...c, dealing: { ...c.dealing, positionLimits: { ...c.dealing.positionLimits, USD: '10000' } } }));
    h.customer('ayse', { USD: '0', TRY: '10000000' });
    // Friday evening, just before the close: the last LP price.
    h.clock.now = new Date('2026-10-09T20:55:00Z');
    let ayse = await h.login('ayse');
    const friday = (await h.req('GET', '/v1/bank/rates/USDTRY', ayse)).body;
    expect(friday.offHours).toBeUndefined();

    // Saturday: the bank still quotes, from the close widened by 50 bps of the mid on each side.
    h.clock.now = new Date('2026-10-10T12:00:00Z');
    ayse = await h.login('ayse');
    const vip = await h.login('ayse', 'premium');
    const saturday = await h.req('GET', '/v1/bank/rates/USDTRY', ayse);
    expect(saturday.status).toBe(200);
    expect(saturday.body.offHours).toEqual({ nextOpen: '2026-10-11T21:00:00.000Z' });
    const widen = 49.15 * 0.005;
    expect(Number(saturday.body.buy) - Number(friday.buy)).toBeCloseTo(widen, 2);
    expect(Number(friday.sell) - Number(saturday.body.sell)).toBeCloseTo(widen, 2);

    // The cap is 20 % of the 250 000 USD inventory cap while closed.
    expect((await h.req('POST', '/v1/bank/quotes', vip, { pair: 'USDTRY', side: 'BUY', qty: '60000' })).body.error).toBe('INVENTORY_LIMIT');
    const q = await h.req('POST', '/v1/bank/quotes', ayse, { pair: 'USDTRY', side: 'BUY', qty: '20000' });
    expect(q.body).toMatchObject({ offHours: true });
    expect((await h.req('POST', '/v1/bank/deals', ayse, { quoteId: q.body.id })).status).toBe(201);
    // Nothing can be hedged while closed.
    expect((await h.req('POST', '/ops/dealing/hedges', OPS, { pair: 'USDTRY', side: 'BUY', qty: '1000' })).body.error).toBe('LP_MARKET_CLOSED');
    expect((await h.ctx.db.query('select count(*)::int as n from hedges')).rows[0].n).toBe(0);

    // Sunday 17:00 New York: live prices again, and the position over its limit is hedged at once.
    h.clock.now = new Date('2026-10-11T21:00:05Z');
    await h.ctx.prices.refresh('USDTRY');
    await h.ctx.positions.idle();
    const { rows } = await h.ctx.db.query(`select side, status from hedges`);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r: { side: string; status: string }) => r.side === 'BUY' && r.status === 'DONE')).toBe(true);
  });

  it('gives no price when off-hours quoting is switched off or the close is too old', async () => {
    h = await startHarness();
    h.clock.now = new Date('2026-10-09T20:55:00Z');
    await h.req('GET', '/v1/bank/rates/USDTRY', await h.login('ayse'));
    await h.setConfig((c) => ({ ...c, dealing: { ...c.dealing, offHours: { ...c.dealing.offHours, enabled: false } } }));
    h.clock.now = new Date('2026-10-10T12:00:00Z');
    const off = await h.req('GET', '/v1/bank/rates/USDTRY', await h.login('ayse'));
    expect(off.body.details?.reason).toBe('MARKET_CLOSED');
    await h.setConfig((c) => ({ ...c, dealing: { ...c.dealing, offHours: { ...c.dealing.offHours, enabled: true, maxCloseAgeHours: 6 } } }));
    expect((await h.req('GET', '/v1/bank/rates/USDTRY', await h.login('ayse'))).body.details?.reason).toBe('MARKET_CLOSED');
  });
});
