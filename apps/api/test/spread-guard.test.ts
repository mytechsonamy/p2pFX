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
    expect(h.ctx.prices.offReason('USDTRY')).toBe('WIDE_MARKET');

    // A pair can carry its own, wider limit.
    await h.setConfig((c) => ({ ...c, pairs: c.pairs.map((p) => (p.symbol === 'USDTRY' ? { ...p, maxSpreadBps: 300 } : p)) }));
    h.clock.now = new Date(h.clock.now.getTime() + 2000);
    expect((await h.req('GET', '/v1/bank/rates/USDTRY', ayse)).status).toBe(200);
    expect(h.ctx.prices.offReason('USDTRY')).toBeUndefined();
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
