import { afterEach, describe, expect, it } from 'vitest';
import { diffConfig, pathMatches, DEFAULT_CONFIG } from '@p2p/shared';
import { OPS, startHarness, type Harness } from './helpers.js';

let h: Harness;
let other: Harness | undefined;
afterEach(async () => {
  await other?.close();
  await h?.close();
  other = undefined;
  h = undefined as unknown as Harness;
});

const loginAs = async (username: string, password: string) => {
  const r = await h.req('POST', '/ops/login', undefined, { username, password });
  expect(r.status).toBe(200);
  return r.body.token as string;
};

/** Signs in the bootstrap admin and creates an editor and a viewer. */
async function operators() {
  const admin = await loginAs('admin', 'admin-pass-123');
  for (const [username, role] of [['elif', 'editor'], ['veli', 'viewer']]) {
    const r = await h.req('POST', '/ops/users', admin, { username, displayName: username, role, password: 'password-123' });
    expect(r.status).toBe(200);
  }
  return { admin, editor: await loginAs('elif', 'password-123'), viewer: await loginAs('veli', 'password-123') };
}

const withTax = (rate: string) => {
  const c = structuredClone(h.ctx.config.get().data);
  c.tax.buyRate = rate;
  c.tax.sellRate = rate;
  return c;
};

describe('config diff', () => {
  it('reports leaf changes, keying pairs by symbol', () => {
    const b = structuredClone(DEFAULT_CONFIG);
    b.pairs[1].commission.buyBips = 7;
    b.dealing.margins.segments.gold = { buyBips: 2, sellBips: 2 };
    expect(diffConfig(DEFAULT_CONFIG, b)).toEqual([
      { path: 'pairs.EURTRY.commission.buyBips', from: 5, to: 7 },
      { path: 'dealing.margins.segments.gold', from: undefined, to: { buyBips: 2, sellBips: 2 } },
    ]);
    expect(pathMatches('pairs.EURTRY.commission.buyBips', 'pairs.*.commission')).toBe(true);
    expect(pathMatches('pairs.EURTRY.minQty', 'pairs.*.commission')).toBe(false);
  });
});

describe('back office', () => {
  it('signs in named operators and enforces their roles', async () => {
    h = await startHarness();
    const { editor, viewer } = await operators();
    expect((await h.req('POST', '/ops/login', undefined, { username: 'elif', password: 'wrong-password' })).status).toBe(401);
    expect((await h.req('GET', '/ops/me', editor)).body).toMatchObject({ username: 'elif', role: 'editor' });

    expect((await h.req('GET', '/ops/config', viewer)).status).toBe(200);
    expect((await h.req('PUT', '/ops/config', viewer, { config: withTax('0.001'), reason: 'deneme' })).status).toBe(403);
    expect((await h.req('GET', '/ops/users', editor)).status).toBe(403);
    // Service tokens cannot manage operators.
    expect((await h.req('GET', '/ops/users', OPS)).status).toBe(403);

    // A customer session is not an ops session, and an ops session is not a customer session.
    const customer = await h.login('ayse');
    expect((await h.req('GET', '/ops/config', customer)).status).toBe(401);
    expect((await h.req('GET', '/v1/config', editor)).status).toBe(401);

    // A disabled operator's session stops working at once.
    const admin = await loginAs('admin', 'admin-pass-123');
    expect((await h.req('PATCH', '/ops/users/elif', admin, { active: false })).status).toBe(200);
    expect((await h.req('GET', '/ops/config', editor)).status).toBe(401);
    expect((await h.req('PATCH', '/ops/users/admin', admin, { active: false })).status).toBe(400);
  });

  it('says when a deployment has no back office users yet', async () => {
    h = await startHarness();
    await h.ctx.db.query('delete from ops_users');
    const r = await h.req('POST', '/ops/login', undefined, { username: 'admin', password: 'admin-pass-123' });
    expect(r).toMatchObject({ status: 401, body: { error: 'NO_OPERATORS' } });
  });

  it('records who changed what and why, previews changes and restores earlier versions', async () => {
    h = await startHarness();
    const { editor } = await operators();
    const before = h.ctx.config.get().version;

    const preview = await h.req('PUT', '/ops/config', editor, { config: withTax('0.001'), reason: '', dryRun: true });
    expect(preview.body.diff).toEqual([
      { path: 'tax.buyRate', from: '0.002', to: '0.001' },
      { path: 'tax.sellRate', from: '0.002', to: '0.001' },
    ]);
    expect(h.ctx.config.get().version).toBe(before);

    expect((await h.req('PUT', '/ops/config', editor, { config: withTax('0.001'), reason: '' })).body.error).toBe('REASON_REQUIRED');
    const saved = await h.req('PUT', '/ops/config', editor, { config: withTax('0.001'), reason: 'Binde 1 kararı' });
    expect(saved.status).toBe(200);
    expect(h.ctx.config.get().data.tax.buyRate).toBe('0.001');
    expect((await h.req('PUT', '/ops/config', editor, { config: withTax('0.001'), reason: 'tekrar' })).body.error).toBe('NO_CHANGE');

    const versions = (await h.req('GET', '/ops/config/versions', editor)).body;
    expect(versions[0]).toMatchObject({ version: saved.body.version, createdBy: 'elif', reason: 'Binde 1 kararı' });
    expect(versions[0].diff).toHaveLength(2);

    const revert = await h.req('POST', '/ops/config/revert', editor, { version: before, reason: 'Geri al' });
    expect(revert.status).toBe(200);
    expect(h.ctx.config.get().data.tax.buyRate).toBe('0.002');
    expect((await h.req('GET', '/ops/config/versions', editor)).body[0]).toMatchObject({ revertedFrom: before, createdBy: 'elif' });

    const log = (await h.req('GET', '/ops/audit?action=config.', editor)).body;
    expect(log.map((e: { action: string }) => e.action).slice(0, 2)).toEqual(['config.revert', 'config.update']);
    expect(log[1]).toMatchObject({ actor: 'elif', payload: { reason: 'Binde 1 kararı' } });

    // Service integrations are named by their X-Ops-Actor header.
    const svc = await h.req('PUT', '/ops/config', OPS, { config: withTax('0.003'), reason: 'script' }, { 'x-ops-actor': 'walkthrough' });
    expect(svc.status).toBe(200);
    expect((await h.req('GET', '/ops/config/versions', editor)).body[0].createdBy).toBe('service:walkthrough');
  });

  it('flags shipped defaults until an operator changes or confirms them', async () => {
    h = await startHarness();
    const { editor } = await operators();
    const status = async () =>
      Object.fromEntries((await h.req('GET', '/ops/config/assumptions', editor)).body.map((a: { key: string; settled: unknown }) => [a.key, a.settled]));

    expect(Object.values(await status()).every((s) => s === null)).toBe(true);

    await h.req('PUT', '/ops/config', editor, { config: withTax('0.001'), reason: 'Vergi oranı' });
    const c = structuredClone(h.ctx.config.get().data);
    c.pairs[0].commission.buyBips = 6;
    await h.req('PUT', '/ops/config', editor, { config: c, reason: 'Komisyon' });
    expect((await h.req('POST', '/ops/config/assumptions/confirm', editor, { keys: ['tradingHours'], reason: '7/24 uygun' })).status).toBe(200);

    const s = await status();
    expect(s.tax).toMatchObject({ how: 'changed', by: 'elif' });
    expect(s.commission).toMatchObject({ how: 'changed', by: 'elif' });
    expect(s.tradingHours).toMatchObject({ how: 'confirmed', by: 'elif' });
    expect(s.margins).toBeNull();
    expect((await h.req('POST', '/ops/config/assumptions/confirm', editor, { keys: ['nope'] })).status).toBe(400);
  });

  it('applies changes at once: segment margins, session length and settlement retries', async () => {
    h = await startHarness();
    const vip = await h.login('vip', 'premium');
    expect((await h.req('GET', '/v1/bank/rates/USDTRY', vip)).body).toMatchObject({ buy: '49.1959' });

    await h.setConfig((c) => {
      c.dealing.margins.segments.premium = { buyBips: 2, sellBips: 2 };
      c.session.ttlMinutes = 5;
      return c;
    });
    // Same LP price, the new premium margin (2 bips instead of 4).
    expect((await h.req('GET', '/v1/bank/rates/USDTRY', vip)).body).toMatchObject({ buy: '49.1759', sell: '49.1241' });
    const s = await h.req('POST', '/v1/session', undefined, { launchToken: await h.launchToken('ayse') });
    expect(new Date(s.body.expiresAt).getTime() - h.clock.now.getTime()).toBe(5 * 60 * 1000);
  });

  it('tells connected customers to reload their configuration', async () => {
    h = await startHarness();
    const ws = await h.app.injectWS(`/v1/stream?token=${await h.login('ayse')}`);
    const messages: { channel: string; data: any }[] = [];
    ws.on('message', (m: Buffer) => messages.push(JSON.parse(m.toString())));
    ws.send(JSON.stringify({ op: 'subscribe', channels: [] }));
    for (let i = 0; i < 50 && !messages.length; i++) await new Promise((r) => setTimeout(r, 10));
    await h.setConfig((c) => {
      c.pairs[0].commission.buyBips = 6;
      return c;
    });
    expect(messages).toContainEqual({ channel: 'config', data: { version: h.ctx.config.get().version } });
    ws.terminate();
  });

  it('reloads the configuration on other API instances', async () => {
    h = await startHarness();
    other = await startHarness({ reset: false, matching: false });
    await h.setConfig((c) => ({ ...c, balanceMode: 'no_block' }));
    const target = h.ctx.config.get().version;
    for (let i = 0; i < 50 && other.ctx.config.get().version < target; i++) await new Promise((r) => setTimeout(r, 20));
    expect(other.ctx.config.get()).toMatchObject({ version: target, data: { balanceMode: 'no_block' } });
  });
});
