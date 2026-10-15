import { describe, expect, it } from 'vitest';
import {
  CompositeLiquidity,
  LiquidityError,
  LiquidityOutcomeUnknownError,
  MockLiquidity,
  SaxoLiquidity,
  SyntheticLiquidity,
} from '../src/index.js';

/** A fake Saxo OpenAPI: two instruments, market orders that fill (or not) at the ask/bid. */
function fakeSaxo(opts: { fill?: 'now' | 'never' | 'reject'; priceType?: string } = {}) {
  const calls: { method: string; path: string; body?: any; headers: Record<string, string> }[] = [];
  const activities: any[] = [];
  let orders = 0;
  const instruments: Record<string, number> = { USDTRY: 1001, XAUUSD: 2002 };
  const prices: Record<number, { Bid: number; Ask: number }> = { 1001: { Bid: 41.95, Ask: 41.97 }, 2002: { Bid: 3999.5, Ask: 4000.5 } };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const path = u.pathname.replace('/sim/openapi', '');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method ?? 'GET', path: `${path}${u.search}`, body, headers: init.headers as Record<string, string> });
    if (path === '/ref/v1/instruments') {
      const kw = u.searchParams.get('Keywords')!;
      return json(200, { Data: instruments[kw] ? [{ Identifier: instruments[kw], Symbol: kw }] : [] });
    }
    if (path === '/port/v1/accounts/me') return json(200, { Data: [{ AccountKey: 'acc-1' }] });
    if (path === '/trade/v1/infoprices/list') {
      const t = opts.priceType ?? 'Tradable';
      return json(200, {
        Data: u.searchParams.get('Uics')!.split(',').map((uic) => ({
          Uic: Number(uic),
          LastUpdated: '2026-10-11T19:00:00Z',
          Quote: { ...prices[Number(uic)], PriceTypeBid: t, PriceTypeAsk: t },
        })),
      });
    }
    if (path === '/trade/v2/orders') {
      if (opts.fill === 'reject') return json(400, { ErrorInfo: { ErrorCode: 'InsufficientCash', Message: 'not enough' } });
      const id = String(5000 + ++orders);
      const p = prices[body.Uic];
      if (opts.fill !== 'never') {
        activities.unshift({ OrderId: id, ExternalReference: body.ExternalReference, Status: 'FinalFill', SubStatus: 'Confirmed', BuySell: body.BuySell, Amount: body.Amount, FilledAmount: body.Amount, AveragePrice: body.BuySell === 'Buy' ? p.Ask : p.Bid, ActivityTime: '2026-10-11T19:00:01Z' });
      } else {
        activities.unshift({ OrderId: id, ExternalReference: body.ExternalReference, Status: 'Placed' });
      }
      return json(200, { OrderId: id });
    }
    if (path === '/cs/v1/audit/orderactivities') {
      const id = u.searchParams.get('OrderId');
      return json(200, { Data: id ? activities.filter((a) => a.OrderId === id).slice(0, 1) : activities });
    }
    return json(404, { Message: 'not found' });
  }) as typeof fetch;
  const saxo = new SaxoLiquidity({ token: 't', pairs: ['USDTRY', 'XAUUSD', 'EURTRY'], fetch: fetchFn, sleep: async () => {}, fillTimeoutMs: 0 });
  return { saxo, calls, activities };
}

describe('Saxo LP', () => {
  it('prices every pair with one request and caches it', async () => {
    const { saxo, calls } = fakeSaxo();
    expect(await saxo.instruments()).toEqual(['USDTRY', 'XAUUSD']);
    expect(await saxo.quotes('USDTRY')).toEqual([{ lp: 'SAXO', pair: 'USDTRY', bid: '41.95', ask: '41.97', at: '2026-10-11T19:00:00Z' }]);
    await saxo.quotes('XAUUSD');
    expect(calls.filter((c) => c.path.startsWith('/trade/v1/infoprices')).length).toBe(1);
    await expect(saxo.quotes('EURTRY')).rejects.toBeInstanceOf(LiquidityError);
  });

  it('ignores indicative prices', async () => {
    const { saxo } = fakeSaxo({ priceType: 'Indicative' });
    await expect(saxo.quotes('USDTRY')).rejects.toBeInstanceOf(LiquidityError);
  });

  it('places a market order with the reference and reads the fill', async () => {
    const { saxo, calls } = fakeSaxo();
    const exec = await saxo.execute({ lp: 'SAXO', pair: 'USDTRY', side: 'BUY', qty: '1000', ref: 'r1' });
    expect(exec).toMatchObject({ lp: 'SAXO', pair: 'USDTRY', side: 'BUY', qty: '1000', rate: '41.97', tradeRef: 'SAXO-5001' });
    const order = calls.find((c) => c.path === '/trade/v2/orders')!;
    expect(order.body).toMatchObject({ AccountKey: 'acc-1', Uic: 1001, BuySell: 'Buy', Amount: 1000, OrderType: 'Market', ExternalReference: 'r1' });
    expect(order.headers['x-request-id']).toBe('r1');
    // The same reference is found, not sent again.
    expect(await saxo.execute({ lp: 'SAXO', pair: 'USDTRY', side: 'BUY', qty: '1000', ref: 'r1' })).toMatchObject({ tradeRef: 'SAXO-5001' });
    expect(calls.filter((c) => c.path === '/trade/v2/orders').length).toBe(1);
    expect(await saxo.findExecution('SAXO', 'r1')).toMatchObject({ rate: '41.97' });
    expect(await saxo.findExecution('SAXO', 'other')).toBeUndefined();
  });

  it('treats a rejection as definite and an unconfirmed fill as unknown', async () => {
    await expect(fakeSaxo({ fill: 'reject' }).saxo.execute({ lp: 'SAXO', pair: 'USDTRY', side: 'SELL', qty: '10', ref: 'r2' })).rejects.toBeInstanceOf(LiquidityError);
    await expect(fakeSaxo({ fill: 'never' }).saxo.execute({ lp: 'SAXO', pair: 'USDTRY', side: 'SELL', qty: '10', ref: 'r3' })).rejects.toBeInstanceOf(LiquidityOutcomeUnknownError);
  });

  it('aggregates with other LPs and builds gram gold across them', async () => {
    const { saxo, calls } = fakeSaxo();
    const mock = new MockLiquidity({ anchor: (p) => ({ USDTRY: 41.96 })[p], instruments: () => ['USDTRY'], volatility: 0 });
    const lp = new SyntheticLiquidity(new CompositeLiquidity([mock, saxo]));
    expect((await lp.quotes('USDTRY')).map((q) => q.lp)).toEqual(['LP-A', 'LP-B', 'LP-C', 'SAXO']);
    const gold = await lp.quotes('XAUTRY');
    expect(gold.map((q) => q.lp)).toEqual(['SAXO+LP-A', 'SAXO+LP-B', 'SAXO+LP-C', 'SAXO+SAXO']);
    await lp.execute({ lp: 'SAXO+LP-A', pair: 'XAUTRY', side: 'BUY', qty: '31.1', ref: 'g1' });
    expect(calls.find((c) => c.path === '/trade/v2/orders')!.body).toMatchObject({ Uic: 2002, BuySell: 'Buy', Amount: 1 });
    expect(await mock.findExecution('LP-A', 'g1/2')).toMatchObject({ pair: 'USDTRY', side: 'BUY', qty: '4000.5' });
  });

  /** A Saxo that accepts orders; `poll` answers the fill poll, `audit` the pages of the activity audit. */
  function scripted(opts: { poll?: () => Response; audit?: Record<string, { Data: unknown[]; __next?: string }> }) {
    const calls: string[] = [];
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    const fetchFn = (async (url: string, init: RequestInit = {}) => {
      const u = new URL(url);
      calls.push(`${init.method ?? 'GET'} ${u.pathname.replace('/sim/openapi', '')}${u.search}`);
      if (u.pathname.endsWith('/ref/v1/instruments')) return json(200, { Data: [{ Identifier: 1001, Symbol: 'USDTRY' }] });
      if (u.pathname.endsWith('/port/v1/accounts/me')) return json(200, { Data: [{ AccountKey: 'acc-1' }] });
      if (u.pathname.endsWith('/trade/v2/orders')) return json(200, { OrderId: '7001' });
      if (u.searchParams.get('OrderId')) return opts.poll?.() ?? json(200, { Data: [] });
      return json(200, opts.audit?.[u.searchParams.get('$skiptoken') ?? 'first'] ?? { Data: [] });
    }) as typeof fetch;
    return { saxo: new SaxoLiquidity({ token: 't', pairs: ['USDTRY'], fetch: fetchFn, sleep: async () => {}, fillTimeoutMs: 1000 }), calls };
  }

  it('treats a 429 or an expired token on the fill poll as unknown: the order may fill', async () => {
    for (const status of [429, 401, 400]) {
      const { saxo, calls } = scripted({ poll: () => new Response(JSON.stringify({ ErrorInfo: { ErrorCode: 'X' } }), { status }) });
      const err = await saxo.execute({ lp: 'SAXO', pair: 'USDTRY', side: 'BUY', qty: '1000', ref: `p${status}` }).catch((e) => e);
      expect(calls.some((c) => c.startsWith('POST'))).toBe(true);
      expect(err).toBeInstanceOf(LiquidityOutcomeUnknownError);
    }
  });

  it('never sends the same reference twice and reads its own orders by order id', async () => {
    const { saxo, calls } = scripted({ poll: () => new Response(JSON.stringify({ Data: [{ OrderId: '7001', Status: 'Placed' }] }), { status: 200 }) });
    await expect(saxo.execute({ lp: 'SAXO', pair: 'USDTRY', side: 'BUY', qty: '1000', ref: 'twice' })).rejects.toBeInstanceOf(LiquidityOutcomeUnknownError);
    await expect(saxo.execute({ lp: 'SAXO', pair: 'USDTRY', side: 'BUY', qty: '1000', ref: 'twice' })).rejects.toBeInstanceOf(LiquidityOutcomeUnknownError);
    expect(calls.filter((c) => c.startsWith('POST'))).toHaveLength(1);
    expect(calls.some((c) => c.includes('$top'))).toBe(false);
  });

  it('searches every page of the activity audit, and fails rather than answer "not found" past its cap', async () => {
    const page = (n: number, extra: unknown[] = []) => ({
      Data: [...Array.from({ length: 3 }, (_, i) => ({ OrderId: `${n}${i}`, ExternalReference: `other-${n}-${i}`, Status: 'FinalFill', AveragePrice: 41 })), ...extra],
      __next: `https://gateway.saxobank.com/sim/openapi/cs/v1/audit/orderactivities?$skiptoken=${n + 1}`,
    });
    const fill = { OrderId: '999', ExternalReference: 'old', Status: 'FinalFill', AveragePrice: 41.9, Amount: 1000, ActivityTime: '2026-10-01T10:00:00Z' };
    const { saxo } = scripted({ audit: { first: page(0), '1': page(1), '2': { Data: [fill] } } });
    expect(await saxo.findExecution('SAXO', 'old', { pair: 'USDTRY', side: 'BUY', qty: '1000' })).toMatchObject({ rate: '41.9', tradeRef: 'SAXO-999' });
    expect(await saxo.findExecution('SAXO', 'missing')).toBeUndefined();

    const endless: Record<string, { Data: unknown[]; __next?: string }> = { first: page(0) };
    for (let i = 1; i <= 30; i++) endless[String(i)] = page(i);
    const capped = scripted({ audit: endless }).saxo;
    await expect(capped.findExecution('SAXO', 'missing')).rejects.toBeInstanceOf(LiquidityError);
  });

  it('keeps a newer price cache when an older fetch fails', async () => {
    let n = 0;
    let failFirst!: () => void;
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    const fetchFn = (async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/ref/v1/instruments')) return json({ Data: [{ Identifier: 1001, Symbol: 'USDTRY' }] });
      n++;
      if (n === 1) return new Promise<Response>((_, reject) => (failFirst = () => reject(new Error('network'))));
      return json({ Data: [{ Uic: 1001, LastUpdated: '2026-10-11T19:00:00Z', Quote: { Bid: 41.95, Ask: 41.97, PriceTypeBid: 'Tradable', PriceTypeAsk: 'Tradable' } }] });
    }) as typeof fetch;
    const saxo = new SaxoLiquidity({ token: 't', pairs: ['USDTRY'], fetch: fetchFn, sleep: async () => {}, minPollMs: 60_000 });
    const first = saxo.quotes('USDTRY').catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    (saxo as unknown as { cache?: unknown }).cache = undefined;
    expect(await saxo.quotes('USDTRY')).toHaveLength(1);
    failFirst();
    await first;
    await saxo.quotes('USDTRY');
    expect(n).toBe(2);
  });
});
