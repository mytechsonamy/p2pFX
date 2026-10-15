import { afterEach, describe, expect, it } from 'vitest';
import type { LpQuote } from '@p2p/core-adapter';
import { dropOutliers } from '../src/dealing/price-engine.js';
import { startHarness, type Harness } from './helpers.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
  h = undefined as unknown as Harness;
});

/** Replaces the LPs' USDTRY prices with these (bid, ask) pairs, stamped now, and moves the clock past the price cache. */
function quote(prices: [string, string][], stepMs = 2000) {
  const at = () => h.clock.now.toISOString();
  const inner = h.liquidity.quotes.bind(h.liquidity);
  h.liquidity.quotes = async (pair: string): Promise<LpQuote[]> =>
    pair === 'USDTRY' ? prices.map(([bid, ask], i) => ({ lp: `LP-${'ABCDE'[i]}`, pair, bid, ask, at: at() })) : inner(pair);
  h.clock.now = new Date(h.clock.now.getTime() + stepMs);
}

const lp = (name: string, bid: string, ask: string): LpQuote => ({ lp: name, pair: 'USDTRY', bid, ask, at: '2026-10-05T09:00:00Z' });

describe('dropOutliers', () => {
  it('leaves one or two quotes alone: there is no majority to say which one is wrong', () => {
    const two = [lp('A', '49.14', '49.16'), lp('B', '52.00', '52.02')];
    expect(dropOutliers(two, 50)).toEqual({ kept: two, excluded: [] });
  });

  it('drops a quote far from the median of three or more', () => {
    const a = lp('A', '49.14', '49.16');
    const b = lp('B', '49.13', '49.17');
    const bad = lp('C', '52.00', '52.02');
    const r = dropOutliers([a, bad, b], 50);
    expect(r.kept).toEqual([a, b]);
    expect(r.excluded).toEqual([bad]);
  });

  it('keeps quotes within the limit (a 20 bps difference against 50)', () => {
    const qs = [lp('A', '49.14', '49.16'), lp('B', '49.24', '49.26'), lp('C', '49.15', '49.17')];
    expect(dropOutliers(qs, 50).excluded).toEqual([]);
  });
});

describe('price sanity', () => {
  it('leaves out the LP whose price is far from the others and keeps quoting from the rest', async () => {
    h = await startHarness();
    const ayse = await h.login('ayse');
    // LP-B quotes a bid 6 % above the market: without the check it would be the best bid and cross the market.
    quote([['49.14', '49.16'], ['52.10', '52.12'], ['49.13', '49.17']]);
    const r = await h.req('GET', '/v1/bank/rates/USDTRY', ayse);
    expect(r.status).toBe(200);
    const agg = h.ctx.prices.fresh('USDTRY')!;
    expect(agg.bidLp).toBe('LP-A');
    expect(agg.askLp).toBe('LP-A');
    expect(agg.excludedLps).toEqual(['LP-B']);
    expect(agg.quotes.map((q) => q.lp)).toEqual(['LP-A', 'LP-C']);
  });

  it('with the check off, the same bad LP crosses the market and the spread guard stops the price', async () => {
    h = await startHarness();
    const ayse = await h.login('ayse');
    await h.setConfig((c) => ({ ...c, dealing: { ...c.dealing, priceSanity: { ...c.dealing.priceSanity, enabled: false } } }));
    quote([['49.14', '49.16'], ['52.10', '52.12'], ['49.13', '49.17']]);
    const r = await h.req('GET', '/v1/bank/rates/USDTRY', ayse);
    expect(r.status).toBe(503);
    expect(r.body.details).toEqual({ reason: 'WIDE_MARKET' });
  });

  it('gives no bank price while the only LP drifts away from the core banking reference rate', async () => {
    h = await startHarness();
    const ayse = await h.login('ayse');
    // Reference 49.15; one LP at ~51.15 is ~407 bps away, beyond the default 300.
    quote([['51.14', '51.16']]);
    const r = await h.req('GET', '/v1/bank/rates/USDTRY', ayse);
    expect(r.status).toBe(503);
    expect(r.body.details).toEqual({ reason: 'PRICE_SUSPECT' });
    expect(h.ctx.prices.offState('USDTRY')).toEqual({ reason: 'PRICE_SUSPECT' });
    expect((await h.req('POST', '/v1/bank/quotes', ayse, { pair: 'USDTRY', side: 'BUY', qty: '100' })).status).toBe(503);

    // Core banking moves its reference rate: once it is read again (a minute later) the price is quoted.
    h.bank.setReferenceRate('USDTRY', '51.15');
    quote([['51.14', '51.16']], 61_000);
    expect((await h.req('GET', '/v1/bank/rates/USDTRY', ayse)).status).toBe(200);
    expect(h.ctx.prices.offState('USDTRY')).toBeUndefined();
  });

  it('quotes as before when core banking has no reference rate for the pair, asking at most once a minute', async () => {
    h = await startHarness();
    const ayse = await h.login('ayse');
    const core = h.bank as unknown as { rates: Map<string, unknown> };
    core.rates.delete('USDTRY');
    let calls = 0;
    const read = h.bank.getReferenceRate.bind(h.bank);
    h.bank.getReferenceRate = async (pair: string) => {
      if (pair === 'USDTRY') calls++;
      return read(pair);
    };
    quote([['51.14', '51.16']], 61_000);
    // No reference: the drift check is skipped (and the order entry price band refuses customer orders anyway).
    expect((await h.req('GET', '/v1/bank/rates/USDTRY', ayse)).status).toBe(200);
    for (let i = 0; i < 5; i++) {
      quote([['51.14', '51.16']], 1500);
      await h.ctx.prices.refresh('USDTRY');
    }
    expect(calls).toBe(1);
  });

  it('keeps quoting on the last reference rate while core banking fails, and does not wait on it every refresh', async () => {
    h = await startHarness();
    const ayse = await h.login('ayse');
    quote([['49.14', '49.16']]);
    expect((await h.req('GET', '/v1/bank/rates/USDTRY', ayse)).status).toBe(200);
    let calls = 0;
    h.bank.getReferenceRate = () => {
      calls++;
      return new Promise(() => {}); // hangs
    };
    quote([['49.14', '49.16']], 61_000);
    const started = Date.now();
    for (let i = 0; i < 4; i++) {
      quote([['49.14', '49.16']], 1500);
      await h.ctx.prices.refresh('USDTRY');
    }
    // One read in flight, waited on once (500 ms at most), not on every refresh.
    expect(calls).toBe(1);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('a slower refresh that started first does not overwrite the price of a later one', async () => {
    h = await startHarness();
    quote([['49.14', '49.16']]);
    await h.ctx.prices.refresh('USDTRY');
    h.bank.getReferenceRate = () => new Promise(() => {}); // the next read hangs: its refresh waits 500 ms
    quote([['49.15', '49.17']], 61_000);
    const slow = h.ctx.prices.refresh('USDTRY'); // starts the read and waits
    quote([['49.16', '49.18']], 10);
    await h.ctx.prices.refresh('USDTRY'); // started later, does not wait
    expect(h.ctx.prices.cached('USDTRY')!.bid).toBe(4_916_000_000n);
    await slow;
    expect(h.ctx.prices.cached('USDTRY')!.bid).toBe(4_916_000_000n);
  });

  it('a reference rate older than referenceMaxAgeMinutes by its own time is not compared with', async () => {
    h = await startHarness();
    const ayse = await h.login('ayse');
    // A daily board rate from yesterday, far from today's market.
    (h.bank as unknown as { rates: Map<string, unknown> }).rates.set('USDTRY', { pair: 'USDTRY', rate: '47.00', asOf: new Date(h.clock.now.getTime() - 24 * 3_600_000).toISOString() });
    quote([['49.14', '49.16']], 61_000);
    expect((await h.req('GET', '/v1/bank/rates/USDTRY', ayse)).status).toBe(200);
  });

  it('gives no price, not an error, when the LPs split into two camps', async () => {
    h = await startHarness();
    const ayse = await h.login('ayse');
    quote([['49.14', '49.16'], ['49.79', '49.81'], ['49.13', '49.17'], ['49.80', '49.82']]);
    const r = await h.req('GET', '/v1/bank/rates/USDTRY', ayse);
    expect(r.status).toBe(503);
    expect(r.body.details).toEqual({ reason: 'PRICE_SUSPECT' });
    expect(h.ctx.prices.offState('USDTRY')).toEqual({ reason: 'PRICE_SUSPECT' });
  });

  it('holds back a sudden jump and accepts the new level once it has held for jumpConfirmMs', async () => {
    h = await startHarness();
    const ayse = await h.login('ayse');
    quote([['49.14', '49.16']]);
    expect((await h.req('GET', '/v1/bank/rates/USDTRY', ayse)).status).toBe(200);

    // +1.5 % (~150 bps) in one tick: beyond the default 100 bps jump limit, within the 300 bps reference limit.
    quote([['49.88', '49.90']], 1500);
    const jumped = await h.req('GET', '/v1/bank/rates/USDTRY', ayse);
    expect(jumped.status).toBe(503);
    expect(jumped.body.details).toEqual({ reason: 'PRICE_JUMP' });

    // Still there 1.5 seconds later: not confirmed yet (default 3 s).
    quote([['49.88', '49.90']], 1500);
    expect((await h.req('GET', '/v1/bank/rates/USDTRY', ayse)).body.details).toEqual({ reason: 'PRICE_JUMP' });

    // Held for three seconds: the new level is accepted.
    quote([['49.89', '49.91']], 1500);
    expect((await h.req('GET', '/v1/bank/rates/USDTRY', ayse)).status).toBe(200);
    expect(h.ctx.prices.fresh('USDTRY')!.bid).toBe(4_989_000_000n);
  });

  it('drops a spike that comes back before it is confirmed, without a gap in the old level', async () => {
    h = await startHarness();
    const ayse = await h.login('ayse');
    quote([['49.14', '49.16']]);
    expect((await h.req('GET', '/v1/bank/rates/USDTRY', ayse)).status).toBe(200);
    quote([['49.88', '49.90']], 1500);
    expect((await h.req('GET', '/v1/bank/rates/USDTRY', ayse)).status).toBe(503);
    // Back to the old level: quoted again at once, and a later spike starts its own confirmation.
    quote([['49.15', '49.17']], 1500);
    expect((await h.req('GET', '/v1/bank/rates/USDTRY', ayse)).status).toBe(200);
    quote([['49.88', '49.90']], 3000);
    expect((await h.req('GET', '/v1/bank/rates/USDTRY', ayse)).body.details).toEqual({ reason: 'PRICE_JUMP' });
  });

  it('does not take the jump limit to a price last seen more than a minute ago', async () => {
    h = await startHarness();
    const ayse = await h.login('ayse');
    quote([['49.14', '49.16']]);
    expect((await h.req('GET', '/v1/bank/rates/USDTRY', ayse)).status).toBe(200);
    quote([['49.88', '49.90']], 61_000);
    expect((await h.req('GET', '/v1/bank/rates/USDTRY', ayse)).status).toBe(200);
  });
});
