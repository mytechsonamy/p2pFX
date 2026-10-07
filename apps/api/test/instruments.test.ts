import { afterEach, describe, expect, it } from 'vitest';
import { MockCoreBank } from '@p2p/core-adapter';
import { DEFAULT_CONFIG, instrument, parseDecimal } from '@p2p/shared';
import { OPS, startHarness, type Harness } from './helpers.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
  h = undefined as unknown as Harness;
});

/** The LPs quote USD, gold and Danish krone; the bank has USD and gold set up. */
async function start() {
  const bank = new MockCoreBank();
  bank.setReferenceRate('USDTRY', '49.15');
  bank.setReferenceRate('XAUTRY', '6320.00');
  bank.setReferenceRate('DKKTRY', '7.16');
  h = await startHarness({
    bank,
    config: {
      ...DEFAULT_CONFIG,
      pairs: DEFAULT_CONFIG.pairs.filter((p) => ['USDTRY', 'XAUTRY'].includes(p.symbol)),
      channels: { ...DEFAULT_CONFIG.channels, bankMarketMaker: false },
    },
  });
}
const symbols = async (token: string) => (await h.req('GET', '/v1/config', token)).body.pairs.map((p: { symbol: string }) => p.symbol);

describe('instruments and pairs', () => {
  it('lists what the LPs quote, adds a pair closed for trading and opens it from the back office', async () => {
    await start();
    const list = (await h.req('GET', '/ops/instruments', OPS)).body;
    expect(list.map((i: { symbol: string; configured: boolean; enabled: boolean }) => [i.symbol, i.configured, i.enabled])).toEqual([
      ['USDTRY', true, true],
      ['XAUTRY', true, true],
      ['DKKTRY', false, false],
    ]);
    expect(list[1]).toMatchObject({ name: 'Altın (gram)', kind: 'metal' });

    expect((await h.req('POST', '/ops/pairs', OPS, { symbol: 'HUFTRY' })).body.error).toBe('NOT_QUOTED');
    expect((await h.req('POST', '/ops/pairs', OPS, { symbol: 'USDTRY' })).status).toBe(409);

    const added = await h.req('POST', '/ops/pairs', OPS, { symbol: 'DKKTRY' });
    expect(added.status).toBe(200);
    const c = h.ctx.config.get().data;
    expect(c.pairs.find((p) => p.symbol === 'DKKTRY')).toMatchObject({ base: 'DKK', enabled: false, pipSize: '0.00001', commission: { mode: 'PIPS' as const, buy: 500, sell: 500 } });
    expect(c.dealing.positionLimits.DKK).toBe(instrument('DKK').position);
    expect(c.bankBook.pairs.DKKTRY.asks.levels).toEqual(instrument('DKK').ladder);
    expect((await h.req('GET', '/ops/config/versions', OPS)).body[0]).toMatchObject({ createdBy: 'service:ops', reason: 'Yeni parite: DKK/TRY (işleme kapalı)' });

    // Closed: customers don't see it and can't trade it.
    const viewer = await h.login('viewer');
    expect(await symbols(viewer)).toEqual(['USDTRY', 'XAUTRY']);
    expect((await h.place(viewer, { pair: 'DKKTRY', side: 'BUY', qty: '100', price: '7.16' })).body.error).toBe('UNKNOWN_PAIR');

    // Opened (and closed again) with the "İşleme açık" switch.
    const open = (symbol: string, enabled: boolean) =>
      h.setConfig((c) => ({ ...c, pairs: c.pairs.map((p) => (p.symbol === symbol ? { ...p, enabled } : p)) }));
    await open('DKKTRY', true);
    expect(await symbols(viewer)).toEqual(['USDTRY', 'XAUTRY', 'DKKTRY']);
    await open('XAUTRY', false);
    expect(await symbols(viewer)).toEqual(['USDTRY', 'DKKTRY']);
    expect((await h.place(viewer, { pair: 'XAUTRY', side: 'BUY', qty: '1', price: '6320' })).body.error).toBe('UNKNOWN_PAIR');
  });

  it('trades gold in grams, with the commission in pips of 0.01 TRY', async () => {
    await start();
    h.customer('ayse', { XAU: '25', TRY: '0' });
    h.customer('mehmet', { XAU: '0', TRY: '200000' });
    const [ayse, mehmet] = [await h.login('ayse'), await h.login('mehmet')];
    expect((await h.place(ayse, { pair: 'XAUTRY', side: 'SELL', qty: '10.5', price: '6330.00' })).status).toBe(201);
    expect((await h.place(mehmet, { pair: 'XAUTRY', side: 'BUY', qty: '10.5', price: '6330.00' })).status).toBe(201);
    await h.ctx.exchange.idle();

    const fill = (await h.req('GET', '/v1/fills', mehmet)).body[0];
    // 500 pips × 0.01 TRY = 5 TRY per gram on top of the book price.
    expect(fill).toMatchObject({ qty: '10.50', effectivePrice: '6335.00', commission: '52.50' });
    expect((await h.balance('mehmet', 'XAU')).balance).toBe(parseDecimal('10.5', 2));
    expect((await h.balance('ayse', 'XAU')).balance).toBe(parseDecimal('14.5', 2));
    // Kambiyo vergisi at the metals rate (binde 2 by default) on 10.5 × 6,335.00.
    expect(fill.tax).toBe('133.04');
  });

  it('taxes precious metals at their own rates', async () => {
    await start();
    await h.setConfig((c) => ({ ...c, tax: { ...c.tax, metals: { buyRate: '0', sellRate: '0.001' } } }));
    const viewer = await h.login('viewer');
    const pairs = (await h.req('GET', '/v1/config', viewer)).body.pairs;
    expect(pairs.map((p: { symbol: string; tax: unknown }) => [p.symbol, p.tax])).toEqual([
      ['USDTRY', { buyRate: '0.002', sellRate: '0.002' }],
      ['XAUTRY', { buyRate: '0', sellRate: '0.001' }],
    ]);

    h.customer('ayse', { XAU: '25', TRY: '0' });
    h.customer('mehmet', { XAU: '0', TRY: '200000' });
    const [ayse, mehmet] = [await h.login('ayse'), await h.login('mehmet')];
    await h.place(ayse, { pair: 'XAUTRY', side: 'SELL', qty: '10.5', price: '6330.00' });
    await h.place(mehmet, { pair: 'XAUTRY', side: 'BUY', qty: '10.5', price: '6330.00' });
    await h.ctx.exchange.idle();
    expect((await h.req('GET', '/v1/fills', mehmet)).body[0].tax).toBe('0.00');
    // Seller: 10.5 × (6,330.00 − 5.00) × binde 1.
    expect((await h.req('GET', '/v1/fills', ayse)).body[0].tax).toBe('66.41');
  });
});

describe('order rate limit', () => {
  it('applies the segment override, so market makers can quote every pair', async () => {
    await start();
    await h.setConfig((c) => ({
      ...c,
      orderRateLimit: { max: 2, windowSeconds: 60 },
      limits: { ...c.limits, segments: { ...c.limits.segments, 'market-maker': { ...c.limits.default, maxOrdersPerWindow: 5 } } },
    }));
    h.customer('ayse', { USD: '1000', TRY: '0' });
    h.customer('mm', { USD: '1000', TRY: '0' });
    const [ayse, mm] = [await h.login('ayse'), await h.login('mm', 'market-maker')];
    const sell = (token: string, i: number) => h.place(token, { side: 'SELL', qty: '10', price: (49.3 + i / 100).toFixed(2) });
    const statuses = async (token: string, n: number) => {
      const out: number[] = [];
      for (let i = 0; i < n; i++) out.push((await sell(token, i)).status);
      return out;
    };
    expect(await statuses(ayse, 3)).toEqual([201, 201, 429]);
    expect(await statuses(mm, 6)).toEqual([201, 201, 201, 201, 201, 429]);
  });
});
