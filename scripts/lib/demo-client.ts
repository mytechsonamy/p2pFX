// Small HTTP client for the demo scripts: plays the bank backend (mints launch tokens) and calls the P2P API.
import { randomUUID } from 'node:crypto';
import { SignJWT, importPKCS8 } from 'jose';

export const API_URL = process.env.API_URL ?? 'http://localhost:4000';
export const CORE_URL = process.env.CORE_BANKING_URL ?? 'http://localhost:4100';
const OPS_TOKEN = process.env.OPS_TOKEN;

const pem = process.env.BANK_JWT_PRIVATE_KEY?.replace(/\\n/g, '\n');
const keyPromise = pem ? importPKCS8(pem, 'RS256') : undefined;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: any,
  ) {
    super(`${status} ${body?.error ?? ''} ${body?.message ?? JSON.stringify(body)}`);
  }
}

async function call(base: string, method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...opts.headers,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new HttpError(res.status, body);
  return body;
}

export const api = (method: string, path: string, token?: string, body?: unknown) => call(API_URL, method, path, { token, body });
export const core = (method: string, path: string, body?: unknown) => call(CORE_URL, method, path, { body });
export const ops = (method: string, path: string, body?: unknown) => {
  if (!OPS_TOKEN) throw new Error('OPS_TOKEN missing: run pnpm dev:keys');
  return call(API_URL, method, path, { token: OPS_TOKEN, body });
};

/** Logs a customer in the way the bank app does: a bank-signed launch token exchanged for a session. */
export async function login(customerRef: string, segment = 'default'): Promise<string> {
  if (!keyPromise) throw new Error('BANK_JWT_PRIVATE_KEY missing: run pnpm dev:keys');
  const now = Math.floor(Date.now() / 1000);
  const launchToken = await new SignJWT({ customer_ref: customerRef, segment, locale: 'tr-TR' })
    .setProtectedHeader({ alg: 'RS256' })
    .setAudience('p2pfx')
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .setJti(randomUUID())
    .sign(await keyPromise);
  return (await api('POST', '/v1/session', undefined, { launchToken })).token;
}

export interface OrderInput {
  pair: string;
  side: 'BUY' | 'SELL';
  qty: string;
  price: string;
  validity?: 'DAY' | 'GTD' | 'GTC';
}

export const placeOrder = (token: string, o: OrderInput) =>
  call(API_URL, 'POST', '/v1/orders', { token, body: { validity: 'GTC', ...o }, headers: { 'idempotency-key': randomUUID() } });

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls until `check` returns a value, or throws after `timeoutMs`. */
export async function waitFor<T>(what: string, check: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await check();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

/** Waits until the API answers its health check. */
export const waitForApi = () =>
  waitFor('the API', async () => (await fetch(`${API_URL}/health`).then((r) => r.ok, () => false)) || undefined, 60_000);
