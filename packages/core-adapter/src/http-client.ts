import {
  CoreBankingError,
  type CoreAccount,
  type CoreBankingAdapter,
  type CoreErrorCode,
  type FxTransactionRequest,
  type FxTransactionResult,
  type Receipt,
  type ReferenceRate,
} from './types.js';

/** JSON-safe form: bigint fields travel as decimal strings of minor units. */
export const toWire = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));

const BIGINT_ACCOUNT_FIELDS = ['balance', 'held', 'available'] as const;
const BIGINT_TXN_FIELDS = ['qty', 'notional', 'commission', 'tax', 'customerAmount'] as const;

export function accountFromWire(a: Record<string, unknown>): CoreAccount {
  const out = { ...a } as Record<string, unknown>;
  for (const f of BIGINT_ACCOUNT_FIELDS) out[f] = BigInt(a[f] as string);
  return out as unknown as CoreAccount;
}

export function fxRequestFromWire(r: Record<string, unknown>): FxTransactionRequest {
  const out = { ...r } as Record<string, unknown>;
  for (const f of BIGINT_TXN_FIELDS) out[f] = BigInt(r[f] as string);
  return out as unknown as FxTransactionRequest;
}

/** CoreBankingAdapter over HTTP, talking to the `mock-core` service (or a bank's facade with the same API). */
export class HttpCoreBankingAdapter implements CoreBankingAdapter {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
    /** Per-call deadline; a call that runs out is UNAVAILABLE with an unknown outcome. */
    private readonly timeoutMs = 10_000,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(new URL(path, this.baseUrl), {
        method,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(toWire(body)) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new CoreBankingError('UNAVAILABLE', `core banking unreachable: ${(err as Error).message}`);
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      const code = (json?.code as CoreErrorCode) ?? (res.status >= 500 ? 'UNAVAILABLE' : 'INVALID_REQUEST');
      throw new CoreBankingError(code, json?.message ?? `core banking returned ${res.status}`);
    }
    return json as T;
  }

  async getAccounts(customerRef: string) {
    const list = await this.call<Record<string, unknown>[]>('GET', `/customers/${encodeURIComponent(customerRef)}/accounts`);
    return list.map(accountFromWire);
  }
  placeHold(accountId: string, amount: bigint, ref: string) {
    return this.call<{ holdId: string }>('POST', '/holds', { accountId, amount, ref });
  }
  async adjustHold(holdId: string, newAmount: bigint) {
    await this.call('PUT', `/holds/${holdId}`, { amount: newAmount });
  }
  async releaseHold(holdId: string) {
    await this.call('DELETE', `/holds/${holdId}`);
  }
  postFxTransaction(req: FxTransactionRequest) {
    return this.call<FxTransactionResult>('POST', '/fx-transactions', req);
  }
  async findFxTransaction(idempotencyKey: string) {
    try {
      return await this.call<FxTransactionResult>('GET', `/fx-transactions?idempotencyKey=${encodeURIComponent(idempotencyKey)}`);
    } catch (err) {
      if (err instanceof CoreBankingError && err.code === 'NOT_FOUND') return undefined;
      throw err;
    }
  }
  reverseFxTransaction(txnRef: string, idempotencyKey: string) {
    return this.call<{ reversalRef: string }>('POST', `/fx-transactions/${txnRef}/reverse`, { idempotencyKey });
  }
  getReceipt(receiptRef: string) {
    return this.call<Receipt>('GET', `/receipts/${receiptRef}`);
  }
  getReferenceRate(pair: string) {
    return this.call<ReferenceRate>('GET', `/rates/${pair}`);
  }
  async notify(customerRef: string, event: { type: string; title: string; body: string; data?: unknown }) {
    await this.call('POST', '/notifications', { customerRef, event });
  }
  /** Prototype only: lets the ops API move the reference rate. */
  setReferenceRate(pair: string, rate: string) {
    return this.call<ReferenceRate>('PUT', `/rates/${pair}`, { rate });
  }
}
