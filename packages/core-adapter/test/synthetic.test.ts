import { describe, expect, it } from 'vitest';
import { formatPrice } from '@p2p/shared';
import {
  beyondLimit,
  LiquidityError,
  LiquidityOutcomeUnknownError,
  MockLiquidity,
  SyntheticLiquidity,
  combine,
  crossFromReference,
  syntheticRoute,
} from '../src/index.js';

const RATES: Record<string, number> = { USDTRY: 49.15, XAUUSD: 4000, USDCHF: 0.8 };

function setup() {
  const inner = new MockLiquidity({ anchor: (p) => RATES[p], instruments: () => Object.keys(RATES), volatility: 0 });
  return { inner, lp: new SyntheticLiquidity(inner) };
}

describe('synthetic crosses', () => {
  it('routes TRY pairs through the dollar', () => {
    expect(syntheticRoute('XAUTRY')).toMatchObject({ cross: 'XAUUSD', inverted: false, funding: 'USDTRY', crossDecimals: 3 });
    expect(syntheticRoute('CHFTRY')).toMatchObject({ cross: 'USDCHF', inverted: true, funding: 'USDTRY', crossDecimals: 2 });
    expect(syntheticRoute('EURTRY')).toMatchObject({ cross: 'EURUSD', inverted: false });
    expect(syntheticRoute('USDTRY')).toBeUndefined();
  });

  it('takes both asks for the bank buying and both bids for the bank selling', () => {
    const gold = combine(syntheticRoute('XAUTRY')!, { bid: '4000', ask: '4001' }, { bid: '49.10', ask: '49.20' })!;
    // 4000 × 49.10 / 31.1034768 = 6314.40662607…, 4001 × 49.20 / 31.1034768 = 6328.84874143…
    expect(formatPrice(gold.bid)).toBe('6314.40662607');
    expect(formatPrice(gold.ask)).toBe('6328.84874144');
    const franc = combine(syntheticRoute('CHFTRY')!, { bid: '0.8000', ask: '0.8010' }, { bid: '49.10', ask: '49.20' })!;
    // CHFTRY = USDTRY / USDCHF: bid 49.10 / 0.8010, ask 49.20 / 0.8000.
    expect(formatPrice(franc.bid)).toBe('61.29837702');
    expect(formatPrice(franc.ask)).toBe('61.50');
  });

  it('derives the cross from TRY reference rates', () => {
    const ref = (p: string) => ({ USDTRY: 50, XAUTRY: 6000, CHFTRY: 62.5 })[p];
    expect(crossFromReference('XAUUSD', ref)).toBeCloseTo((6000 * 31.1034768) / 50, 6);
    expect(crossFromReference('USDCHF', ref)).toBeCloseTo(0.8, 9);
  });

  it('quotes every LP combination and lists the synthetic pairs', async () => {
    const { lp } = setup();
    const quotes = await lp.quotes('XAUTRY');
    expect(quotes).toHaveLength(9);
    const best = quotes.reduce((a, b) => (Number(a.ask) <= Number(b.ask) ? a : b));
    expect(best.lp).toBe('LP-A+LP-A');
    expect(Number(best.bid)).toBeLessThan(Number(best.ask));
    expect((await lp.instruments()).sort()).toEqual(['CHFTRY', 'USDTRY', 'XAUTRY']);
    // Pairs the LPs quote directly pass through.
    expect((await lp.quotes('USDTRY')).map((q) => q.lp)).toEqual(['LP-A', 'LP-B', 'LP-C']);
  });

  it('trades gram gold as ounces of XAUUSD and the dollars against TRY', async () => {
    const { inner, lp } = setup();
    const quote = (await lp.quotes('XAUTRY')).find((q) => q.lp === 'LP-A+LP-B')!;
    const exec = await lp.execute({ lp: 'LP-A+LP-B', pair: 'XAUTRY', side: 'BUY', qty: '100', ref: 'h1' });
    const cross = await inner.findExecution('LP-A', 'h1/1');
    const funding = await inner.findExecution('LP-B', 'h1/2');
    // 100 g = 3.21507… oz, sent as 3.215; the dollars paid are bought from LP-B.
    expect(cross).toMatchObject({ pair: 'XAUUSD', side: 'BUY', qty: '3.215', rate: '4000.4800' });
    expect(funding).toMatchObject({ pair: 'USDTRY', side: 'BUY', qty: String(Math.round(3.215 * 4000.48 * 100) / 100) });
    expect(exec).toMatchObject({ lp: 'LP-A+LP-B', pair: 'XAUTRY', side: 'BUY', qty: '100', ref: 'h1' });
    expect(Number(exec.rate)).toBeCloseTo(Number(quote.ask), 0);
    // Idempotent: the same reference trades nothing more.
    await lp.execute({ lp: 'LP-A+LP-B', pair: 'XAUTRY', side: 'BUY', qty: '100', ref: 'h1' });
    expect(inner.executionCount).toBe(2);
  });

  it('buys francs by selling dollars for them', async () => {
    const { inner, lp } = setup();
    await lp.execute({ lp: 'LP-C+LP-A', pair: 'CHFTRY', side: 'BUY', qty: '1000', ref: 'h2' });
    const cross = await inner.findExecution('LP-C', 'h2/1');
    // 1000 CHF at the USDCHF bid 0.79976 is 1250.38 USD.
    expect(cross).toMatchObject({ pair: 'USDCHF', side: 'SELL', qty: '1250.38', rate: '0.799760' });
    expect(await inner.findExecution('LP-A', 'h2/2')).toMatchObject({ pair: 'USDTRY', side: 'BUY', qty: '1250.38' });
  });

  it('sends the funding leg to the next LP when its own LP rejects it', async () => {
    const { inner, lp } = setup();
    inner.rejecting.add('LP-B');
    await lp.execute({ lp: 'LP-A+LP-B', pair: 'XAUTRY', side: 'SELL', qty: '50', ref: 'h3' });
    expect(await inner.findExecution('LP-B', 'h3/2')).toBeUndefined();
    expect(await inner.findExecution('LP-A', 'h3/2')).toMatchObject({ pair: 'USDTRY', side: 'SELL' });
  });

  it('reports a cross without its funding leg as unknown and completes it on lookup', async () => {
    const { inner, lp } = setup();
    for (const l of ['LP-A', 'LP-B', 'LP-C']) inner.rejecting.add(l);
    inner.rejecting.delete('LP-A');
    const req = { pair: 'XAUTRY', side: 'BUY' as const, qty: '10' };
    // LP-A takes the cross but is made to reject the funding leg, like every other LP.
    const execute = inner.execute.bind(inner);
    inner.execute = async (r) => {
      if (r.pair === 'USDTRY') throw new LiquidityError('rejected');
      return execute(r);
    };
    await expect(lp.execute({ ...req, lp: 'LP-A+LP-B', ref: 'h4' })).rejects.toBeInstanceOf(LiquidityOutcomeUnknownError);
    expect(inner.executionCount).toBe(1);
    // Nothing for an unknown reference; the funding leg is completed once the LPs take it again.
    expect(await lp.findExecution('LP-A+LP-B', 'nope', req)).toBeUndefined();
    inner.execute = execute;
    inner.rejecting.clear();
    const found = await lp.findExecution('LP-A+LP-B', 'h4', req);
    expect(found).toMatchObject({ lp: 'LP-A+LP-B', pair: 'XAUTRY', qty: '10', ref: 'h4' });
    expect(await lp.findExecution('LP-A+LP-B', 'h4', req)).toEqual(found);
    expect(inner.executionCount).toBe(2);
  });

  it('rejects a trade whose price moved beyond the limit, before any leg is sent', async () => {
    const { inner, lp } = setup();
    const ask = (await lp.quotes('XAUTRY')).find((q) => q.lp === 'LP-A+LP-A')!.ask;
    await expect(lp.execute({ lp: 'LP-A+LP-A', pair: 'XAUTRY', side: 'BUY', qty: '10', ref: 'l1', limitRate: String(Number(ask) - 1) })).rejects.toBeInstanceOf(LiquidityError);
    expect(inner.executionCount).toBe(0);
    await lp.execute({ lp: 'LP-A+LP-A', pair: 'XAUTRY', side: 'BUY', qty: '10', ref: 'l2', limitRate: ask });
    expect(inner.executionCount).toBe(2);
    // A direct trade beyond its limit is rejected by the LP itself.
    await expect(lp.execute({ lp: 'LP-A', pair: 'USDTRY', side: 'SELL', qty: '10', ref: 'l3', limitRate: '50' })).rejects.toBeInstanceOf(LiquidityError);
  });

  it('never reports a rejection once the cross traded, even when the funding lookup fails', async () => {
    const { inner, lp } = setup();
    const findExecution = inner.findExecution.bind(inner);
    inner.findExecution = async (l, ref) => {
      if (ref.endsWith('/2')) throw new LiquidityError('lookup failed: 429');
      return findExecution(l, ref);
    };
    // The cross traded on an earlier attempt; the retry looks the funding leg up and the lookup fails.
    await inner.execute({ lp: 'LP-A', pair: 'XAUUSD', side: 'BUY', qty: '0.322', ref: 'u1/1' });
    const err = await lp.execute({ lp: 'LP-A+LP-A', pair: 'XAUTRY', side: 'BUY', qty: '10', ref: 'u1' }).catch((e) => e);
    expect(err).toBeInstanceOf(LiquidityOutcomeUnknownError);
    expect(inner.executionCount).toBe(1);
    // Any other failure after the cross is unknown too.
    const execute = inner.execute.bind(inner);
    inner.execute = async (r) => {
      if (r.pair === 'USDTRY') throw new TypeError('boom');
      return execute(r);
    };
    await expect(lp.execute({ lp: 'LP-A+LP-A', pair: 'XAUTRY', side: 'BUY', qty: '10', ref: 'u2' })).rejects.toBeInstanceOf(LiquidityOutcomeUnknownError);
  });

  it('never sends the funding leg to an LP the bank switched off', async () => {
    const { inner, lp } = setup();
    inner.rejecting.add('LP-B');
    await lp.execute({ lp: 'LP-A+LP-B', pair: 'XAUTRY', side: 'SELL', qty: '50', ref: 'k1', excludeLps: ['LP-A'] });
    expect(await inner.findExecution('LP-A', 'k1/2')).toBeUndefined();
    expect(await inner.findExecution('LP-C', 'k1/2')).toMatchObject({ pair: 'USDTRY' });
  });

  it('looks the funding leg up at an LP it was sent to even when that LP no longer quotes', async () => {
    const { inner, lp } = setup();
    const req = { pair: 'XAUTRY', side: 'BUY' as const, qty: '10' };
    // Only LP-B takes the funding leg, and its answer is lost.
    const execute = inner.execute.bind(inner);
    inner.execute = async (r) => {
      if (r.pair === 'USDTRY' && r.lp !== 'LP-B') throw new LiquidityError('rejected');
      return execute(r);
    };
    inner.losingResponses.add('LP-B');
    await expect(lp.execute({ ...req, lp: 'LP-A+LP-C', ref: 'x1' })).rejects.toBeInstanceOf(LiquidityOutcomeUnknownError);
    inner.losingResponses.clear();
    inner.execute = execute;
    const before = inner.executionCount;
    // LP-B stops quoting USDTRY; the lookup still finds its funding leg instead of sending it again elsewhere.
    const quotes = inner.quotes.bind(inner);
    inner.quotes = async (pair) => (await quotes(pair)).filter((q) => !(pair === 'USDTRY' && q.lp === 'LP-B'));
    expect(await lp.findExecution('LP-A+LP-C', 'x1', req)).toMatchObject({ ref: 'x1', tradeRef: expect.stringContaining('LP-B') });
    expect(inner.executionCount).toBe(before);
  });

  it('sends a fresh funding leg without looking it up first', async () => {
    const { inner, lp } = setup();
    let lookups = 0;
    const findExecution = inner.findExecution.bind(inner);
    inner.findExecution = async (l, ref) => {
      if (ref.endsWith('/2')) lookups++;
      return findExecution(l, ref);
    };
    await lp.execute({ lp: 'LP-A+LP-B', pair: 'XAUTRY', side: 'BUY', qty: '10', ref: 'f1' });
    expect(lookups).toBe(0);
  });

  it('compares limits exactly', () => {
    expect(beyondLimit('BUY', '49.15000001', '49.15')).toBe(true);
    expect(beyondLimit('BUY', '49.15', '49.15')).toBe(false);
    expect(beyondLimit('SELL', '49.14999999', '49.15')).toBe(true);
    expect(beyondLimit('SELL', '0.30000000', '0.3')).toBe(false);
  });
});
