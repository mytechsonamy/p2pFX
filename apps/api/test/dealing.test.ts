import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, parsePrice } from '@p2p/shared';
import { OPS, startHarness, units, type Harness } from './helpers.js';
import { autoHedgeQty, planHedge, positionOf } from '../src/dealing/positions.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
  h = undefined as unknown as Harness;
});

// Frozen LPs around 49.15: the best is LP-A at 49.1441 / 49.1559. Default margin 10 bips, premium 4.
const usd = DEFAULT_CONFIG.pairs[0];

async function deal(token: string, side: 'BUY' | 'SELL', qty: string) {
  const q = await h.req('POST', '/v1/bank/quotes', token, { pair: 'USDTRY', side, qty });
  expect(q.status).toBe(200);
  return { quote: q.body, deal: await h.req('POST', '/v1/bank/deals', token, { quoteId: q.body.id }) };
}

describe('bank dealing', () => {
  it('aggregates the best LP prices and adds the margin of the customer segment', async () => {
    h = await startHarness();
    h.customer('ayse', { USD: '0', TRY: '0' });
    const [ayse, vip] = [await h.login('ayse'), await h.login('vip', 'premium')];
    expect((await h.req('GET', '/v1/bank/rates/USDTRY', ayse)).body).toMatchObject({ buy: '49.2559', sell: '49.0441' });
    expect((await h.req('GET', '/v1/bank/rates/USDTRY', vip)).body).toMatchObject({ buy: '49.1959', sell: '49.1041' });

    const dealer = (await h.req('GET', '/ops/dealing', OPS)).body;
    const p = dealer.pairs.find((x: { pair: string }) => x.pair === 'USDTRY');
    expect(p.lps).toHaveLength(3);
    expect(p.best).toMatchObject({ bid: '49.1441', ask: '49.1559', bidLp: 'LP-A', askLp: 'LP-A' });
    expect(p.segments.premium).toMatchObject({ buy: '49.1959', sell: '49.1041' });
  });

  it('executes a quote as one core banking transaction, with tax and no commission, and keeps the position', async () => {
    h = await startHarness();
    h.customer('ayse', { USD: '0', TRY: '100000' });
    const ayse = await h.login('ayse');

    const { quote, deal: d } = await deal(ayse, 'BUY', '1000');
    expect(quote).toMatchObject({ rate: '49.2559', notional: '49255.90', tax: '98.51', total: '49354.41', currency: 'TRY' });
    expect(d.status).toBe(201);
    expect(d.body).toMatchObject({ liquidity: 'BANK', effectivePrice: '49.2559', commission: '0.00', total: '49354.41', settlementStatus: 'SETTLED' });
    expect(await h.balance('ayse', 'USD')).toMatchObject({ balance: units('1000') });
    expect(await h.balance('ayse', 'TRY')).toMatchObject({ balance: units('50645.59') });

    // Executed once: a repeated execute returns the same deal and moves no money.
    const again = await h.req('POST', '/v1/bank/deals', ayse, { quoteId: quote.id });
    expect(again.body).toMatchObject({ id: d.body.id, settlementStatus: 'SETTLED' });
    expect(await h.balance('ayse', 'USD')).toMatchObject({ balance: units('1000') });

    const fills = (await h.req('GET', '/v1/fills', ayse)).body;
    expect(fills[0]).toMatchObject({ id: d.body.id, counterparty: 'BANK' });
    expect((await h.req('GET', `/v1/fills/${d.body.id}/receipt`, ayse)).body.title).toBe('Döviz Alış Dekontu');

    // Bank sold 1,000 at 49.2559: short, with 100 TRY margin over the LP ask; marked at mid 49.15.
    const pos = (await h.req('GET', '/ops/dealing', OPS)).body.positions.find((p: { pair: string }) => p.pair === 'USDTRY');
    expect(pos).toMatchObject({ qty: '-1000.00', avgRate: '49.2559', marginEarned: '100.00', unrealizedPnl: '105.90', realizedPnl: '0.00' });

    // Ayşe sells 400 back at 49.0441: the bank buys, closing part of the short at a profit.
    await deal(ayse, 'SELL', '400');
    const after = (await h.req('GET', '/ops/dealing', OPS)).body.positions.find((p: { pair: string }) => p.pair === 'USDTRY');
    expect(after).toMatchObject({ qty: '-600.00', avgRate: '49.2559', realizedPnl: '84.72' });
  });

  it('refuses expired quotes and deals the customer cannot fund', async () => {
    h = await startHarness();
    h.customer('ali', { USD: '0', TRY: '1000' });
    const ali = await h.login('ali');
    const q = (await h.req('POST', '/v1/bank/quotes', ali, { pair: 'USDTRY', side: 'BUY', qty: '10' })).body;
    h.clock.now = new Date(h.clock.now.getTime() + 11_000);
    expect((await h.req('POST', '/v1/bank/deals', ali, { quoteId: q.id })).status).toBe(410);

    const { deal: d } = await deal(ali, 'BUY', '100');
    expect(d.status).toBe(422);
    expect(d.body.error).toBe('INSUFFICIENT_BALANCE');
    const pos = (await h.req('GET', '/ops/dealing', OPS)).body.positions.find((p: { pair: string }) => p.pair === 'USDTRY');
    expect(pos.qty).toBe('0.00');
  });

  it('hedges down to the target share of the limit in clips spread across the LPs', async () => {
    h = await startHarness();
    await h.setConfig((c) => ({
      ...c,
      dealing: {
        ...c.dealing,
        positionLimits: { ...c.dealing.positionLimits, USD: '1500' },
        hedging: { targetPct: 50, maxClipQty: { USD: '500' }, split: 'ACROSS_LPS' },
      },
    }));
    h.customer('zeynep', { USD: '0', TRY: '1000000' });
    const zeynep = await h.login('zeynep');
    await deal(zeynep, 'BUY', '1000');
    await deal(zeynep, 'BUY', '1000');

    // −2000 over a 1500 limit, target 50% = 750 short → buy 1250 as 500 + 500 + 250, best LP first.
    const dealer = (await h.req('GET', '/ops/dealing', OPS)).body;
    const clips = [...dealer.hedges].reverse();
    expect(clips.map((x: { lp: string; qty: string }) => [x.lp, x.qty])).toEqual([['LP-A', '500.00'], ['LP-B', '500.00'], ['LP-C', '250.00']]);
    expect(new Set(clips.map((x: { batchId: string }) => x.batchId)).size).toBe(1);
    expect(dealer.positions.find((p: { pair: string }) => p.pair === 'USDTRY').qty).toBe('-750.00');
  });

  it('moves a clip to the next LP when one rejects it', async () => {
    h = await startHarness();
    h.liquidity.rejecting.add('LP-A');
    const res = await h.req('POST', '/ops/dealing/hedges', OPS, { pair: 'USDTRY', side: 'BUY', qty: '100' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ qty: '100.00', unhedged: '0.00', clips: [expect.objectContaining({ lp: 'LP-B', qty: '100.00' })] });

    h.liquidity.rejecting.add('LP-B').add('LP-C');
    expect((await h.req('POST', '/ops/dealing/hedges', OPS, { pair: 'USDTRY', side: 'BUY', qty: '100' })).status).toBe(503);
  });

  it('hedges back to flat with the best LP when a deal takes the position over its limit', async () => {
    h = await startHarness();
    await h.setConfig((c) => ({ ...c, dealing: { ...c.dealing, positionLimits: { ...c.dealing.positionLimits, USD: '1500' } } }));
    h.customer('zeynep', { USD: '0', TRY: '1000000' });
    const zeynep = await h.login('zeynep');

    await deal(zeynep, 'BUY', '1000');
    expect((await h.req('GET', '/ops/dealing', OPS)).body.hedges).toEqual([]);
    await deal(zeynep, 'BUY', '1000');

    const dealer = (await h.req('GET', '/ops/dealing', OPS)).body;
    expect(dealer.hedges).toEqual([expect.objectContaining({ side: 'BUY', qty: '2000.00', rate: '49.1559', lp: 'LP-A', reason: 'AUTO' })]);
    const pos = dealer.positions.find((p: { pair: string }) => p.pair === 'USDTRY');
    expect(pos).toMatchObject({ qty: '0.00', avgRate: null, realizedPnl: '200.00' });
  });

  it('keeps average cost through reductions and flips', () => {
    const t = (side: 'BUY' | 'SELL', qty: string, rate: string) => ({ side, qty: units(qty), rate: parsePrice(rate) });
    const p = positionOf(usd, [t('BUY', '100', '49'), t('BUY', '100', '50'), t('SELL', '50', '51'), t('SELL', '250', '48')]);
    // avg 49.5; sell 50 @51 → +75; sell 150 @48 closes → −225; 100 short opened at 48.
    expect(p).toMatchObject({ qty: units('-100'), avgRate: parsePrice('48'), realized: units('-150') });
  });

  it('plans hedge clips and the auto-hedge size', () => {
    const lps = ['LP-A', 'LP-B'];
    expect(planHedge(units('1200'), units('500'), lps, 'BEST_LP').map((c) => [c.lp, c.qty])).toEqual([['LP-A', units('500')], ['LP-A', units('500')], ['LP-A', units('200')]]);
    expect(planHedge(units('1200'), units('500'), lps, 'ACROSS_LPS').map((c) => c.lp)).toEqual(['LP-A', 'LP-B', 'LP-A']);
    expect(planHedge(units('1200'), undefined, lps, 'ACROSS_LPS')).toEqual([{ lp: 'LP-A', qty: units('1200') }]);
    expect(autoHedgeQty(units('-900'), units('1000'), 0)).toBe(0n);
    expect(autoHedgeQty(units('-2000'), units('1000'), 0)).toBe(units('2000'));
    expect(autoHedgeQty(units('2000'), units('1000'), 25)).toBe(units('1750'));
  });
});
