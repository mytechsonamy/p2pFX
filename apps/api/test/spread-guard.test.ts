import { afterEach, describe, expect, it } from 'vitest';
import type { LpQuote } from '@p2p/core-adapter';
import { startHarness, type Harness } from './helpers.js';

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
