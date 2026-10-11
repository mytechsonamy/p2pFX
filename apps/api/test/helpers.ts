import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { SignJWT, exportSPKI, generateKeyPair } from 'jose';
import { MockCoreBank, MockLiquidity } from '@p2p/core-adapter';
import { DEFAULT_CONFIG, parseDecimal, type BankConfig } from '@p2p/shared';
import { buildApp } from '../src/app.js';

export const DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/p2pfx_test';

export async function resetDb() {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  await c.query('drop schema public cascade; create schema public;');
  await c.end();
}

const keys = generateKeyPair('RS256');

export interface Harness {
  app: Awaited<ReturnType<typeof buildApp>>['app'];
  ctx: Awaited<ReturnType<typeof buildApp>>['ctx'];
  close: () => Promise<void>;
  bank: MockCoreBank;
  /** Frozen LPs quoting around the bank's reference rate. */
  liquidity: MockLiquidity;
  clock: { now: Date };
  login: (customerRef: string, segment?: string) => Promise<string>;
  launchToken: (customerRef: string, segment?: string) => Promise<string>;
  /** Creates a customer in the mock core with balances, e.g. { USD: '1000', TRY: '50000' }. */
  customer: (ref: string, balances: Record<string, string>) => Record<string, string>;
  /** Balance and available of a customer's account in a currency, as decimal strings. */
  balance: (ref: string, currency: string) => Promise<{ balance: bigint; available: bigint }>;
  req: (method: string, url: string, token?: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: any }>;
  place: (token: string, body: Record<string, unknown>, key?: string) => Promise<{ status: number; body: any }>;
  setConfig: (patch: (c: BankConfig) => BankConfig) => Promise<void>;
}

export const OPS = 'ops-secret';

export async function startHarness(opts: { bank?: MockCoreBank; config?: BankConfig; reset?: boolean; matching?: boolean } = {}): Promise<Harness> {
  if (opts.reset !== false) await resetDb();
  const { publicKey, privateKey } = await keys;
  const bank = opts.bank ?? new MockCoreBank();
  if (!opts.bank) {
    bank.setReferenceRate('USDTRY', '49.15');
    bank.setReferenceRate('EURTRY', '53.40');
  }
  const clock = { now: new Date('2026-10-05T09:00:00Z') };
  const liquidity = new MockLiquidity({ anchor: (pair) => bank.referenceRate(pair), instruments: () => bank.referencePairs(), volatility: 0, clock: () => clock.now.getTime() });
  const { app, ctx, close } = await buildApp({
    databaseUrl: DATABASE_URL,
    core: bank,
    liquidity,
    bankPublicKeyPem: await exportSPKI(publicKey),
    sessionSecret: 'test-session-secret-0123456789abcdef',
    opsToken: OPS,
    opsAdminPassword: 'admin-pass-123',
    initialConfig: opts.config ?? DEFAULT_CONFIG,
    matching: opts.matching,
    clock: () => clock.now,
    settlement: { attempts: 2, baseDelayMs: 1 },
    schedulerIntervalMs: 0,
    logger: process.env.TEST_LOG === '1',
  });

  const launchToken = (customerRef: string, segment = 'default') =>
    new SignJWT({ customer_ref: customerRef, segment, locale: 'tr-TR' })
      .setProtectedHeader({ alg: 'RS256' })
      .setAudience('p2pfx')
      .setIssuedAt(Math.floor(clock.now.getTime() / 1000))
      .setExpirationTime(Math.floor(clock.now.getTime() / 1000) + 60)
      .setJti(randomUUID())
      .sign(privateKey);

  const idle = async () => {
    await ctx.exchange.idle();
    await ctx.positions.idle();
  };

  const req: Harness['req'] = async (method, url, token, body, headers = {}) => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    // Settlement runs behind matching (ASYNC dispatch) and hedges behind deals: tests see the state once they are done.
    await idle();
    return { status: res.statusCode, body: res.body ? res.json() : undefined };
  };

  const login = async (customerRef: string, segment?: string) => {
    const res = await req('POST', '/v1/session', undefined, { launchToken: await launchToken(customerRef, segment) });
    if (res.status !== 200) throw new Error(`login failed: ${JSON.stringify(res.body)}`);
    return res.body.token as string;
  };

  const customer = (ref: string, balances: Record<string, string>) =>
    Object.fromEntries(Object.entries(balances).map(([ccy, amount]) => [ccy, bank.createAccount(ref, ccy, parseDecimal(amount, 2)).id]));

  const balance = async (ref: string, currency: string) => {
    const acc = (await bank.getAccounts(ref)).find((a) => a.currency === currency)!;
    return { balance: acc.balance, available: acc.available };
  };

  const place: Harness['place'] = (token, body, key = randomUUID()) =>
    req('POST', '/v1/orders', token, { pair: 'USDTRY', validity: 'GTC', ...body }, { 'idempotency-key': key });

  const setConfig = async (patch: (c: BankConfig) => BankConfig) => {
    const res = await req('PUT', '/ops/config', OPS, { config: patch(structuredClone(ctx.config.get().data)), reason: 'test setup' });
    if (res.status !== 200) throw new Error(`config update failed: ${JSON.stringify(res.body)}`);
  };

  return { app, ctx, close, bank, liquidity, clock, login, launchToken, customer, balance, req, place, setConfig };
}

/** Minor units helper: tl('49001.80') === 4900180n */
export const units = (v: string) => parseDecimal(v, 2);
