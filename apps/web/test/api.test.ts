import { afterEach, describe, expect, it, vi } from 'vitest';
import { Api, ApiError } from '../src/api';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('Api', () => {
  it('renews the session through the host once on 401 and retries', async () => {
    const calls: { url: string; auth?: string }[] = [];
    let sessions = 0;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).authorization;
      calls.push({ url, auth });
      if (url.endsWith('/v1/session')) return json(200, { token: `s${++sessions}`, expiresAt: '', customer: { ref: 'demo-ayse', locale: 'tr-TR' } });
      return auth === 'Bearer s2' ? json(200, []) : json(401, { error: 'UNAUTHORIZED', message: 'expired' });
    });
    const renew = vi.fn(async () => 'launch-2');
    const api = new Api('', renew);
    await api.startSession('launch-1');

    // Two concurrent requests share one renewal.
    await expect(Promise.all([api.orders(), api.fills()])).resolves.toEqual([[], []]);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(sessions).toBe(2);
  });

  it('maps API errors and network failures', async () => {
    vi.stubGlobal('fetch', async () => json(422, { error: 'PRICE_OUT_OF_BAND', message: 'out of band' }));
    const api = new Api('', async () => 'x');
    await expect(api.quote({ pair: 'USDTRY', side: 'BUY', qty: '1', price: '1' })).rejects.toMatchObject({ status: 422, code: 'PRICE_OUT_OF_BAND' });

    vi.stubGlobal('fetch', async () => {
      throw new TypeError('failed');
    });
    await expect(api.accounts()).rejects.toBeInstanceOf(ApiError);
    await expect(api.accounts()).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('sends the idempotency key with an order', async () => {
    const seen: Record<string, string>[] = [];
    vi.stubGlobal('fetch', async (_: string, init: RequestInit) => {
      seen.push(init.headers as Record<string, string>);
      return json(201, { id: 'o1' });
    });
    await new Api('', async () => 'x').place({ pair: 'USDTRY', side: 'BUY', qty: '1', price: '49.15', validity: 'DAY' }, 'key-1');
    expect(seen[0]['idempotency-key']).toBe('key-1');
  });
});
