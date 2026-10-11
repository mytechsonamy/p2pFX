import type { Account, AppConfig, BankQuote, BankRates, Book, Fill, Order, PairStats, QuoteBreakdown, Rate, Receipt, Side, Trade, Validity, OrderType } from './types';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface PlaceOrder {
  pair: string;
  side: Side;
  qty: string;
  type?: OrderType;
  /** Limit orders only. */
  price?: string;
  /** Limit orders only. */
  validity?: Validity;
  expiresAt?: string;
  /** Market orders: the protection price the customer confirmed (binding). */
  protectionPrice?: string;
}

/**
 * Customer API client. Holds the platform session; when the API answers 401 it asks `renewSession`
 * (which goes back to the host for a new launch token) and retries the request once.
 */
export class Api {
  private token: string | undefined;
  private renewing: Promise<void> | undefined;

  constructor(
    private readonly base: string,
    private readonly renewSession: () => Promise<string>,
  ) {}

  get sessionToken() {
    return this.token;
  }

  async startSession(launchToken: string) {
    const s = await this.request<{ token: string; expiresAt: string; customer: { ref: string; locale: string } }>(
      'POST',
      '/v1/session',
      { launchToken },
      { auth: false },
    );
    this.token = s.token;
    return s;
  }

  config = () => this.request<AppConfig>('GET', '/v1/config');
  accounts = () => this.request<Account[]>('GET', '/v1/accounts');
  book = (pair: string) => this.request<Book>('GET', `/v1/pairs/${pair}/book`);
  trades = (pair: string, limit = 50) => this.request<Trade[]>('GET', `/v1/pairs/${pair}/trades?limit=${limit}`);
  stats = (pair: string) => this.request<PairStats>('GET', `/v1/pairs/${pair}/stats`);
  rate = (pair: string) => this.request<Rate>('GET', `/v1/pairs/${pair}/rate`);
  quote = (q: { pair: string; side: Side; qty: string; price?: string; type?: OrderType }) => this.request<QuoteBreakdown>('POST', '/v1/orders/quote', q);
  orders = () => this.request<Order[]>('GET', '/v1/orders?limit=200');
  cancel = (id: string) => this.request<Order>('DELETE', `/v1/orders/${id}`);
  fills = () => this.request<Fill[]>('GET', '/v1/fills?limit=200');
  receipt = (fillId: string) => this.request<Receipt>('GET', `/v1/fills/${fillId}/receipt`);
  bankRates = (pair: string) => this.request<BankRates>('GET', `/v1/bank/rates/${pair}`);
  bankQuote = (q: { pair: string; side: Side; qty: string }) => this.request<BankQuote>('POST', '/v1/bank/quotes', q);
  bankDeal = (quoteId: string) => this.request<Fill>('POST', '/v1/bank/deals', { quoteId });
  place = (o: PlaceOrder, idempotencyKey: string) =>
    this.request<Order>('POST', '/v1/orders', o, { headers: { 'idempotency-key': idempotencyKey } });

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: { auth?: boolean; headers?: Record<string, string>; retried?: boolean } = {},
  ): Promise<T> {
    const auth = opts.auth ?? true;
    if (auth && this.renewing) await this.renewing;
    let res: Response;
    try {
      res = await fetch(this.base + path, {
        method,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(auth && this.token ? { authorization: `Bearer ${this.token}` } : {}),
          ...opts.headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError(0, 'NETWORK', 'network error');
    }
    if (res.status === 401 && auth && !opts.retried) {
      await this.renew();
      return this.request<T>(method, path, body, { ...opts, retried: true });
    }
    const data = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    if (!res.ok) {
      const e = (data ?? {}) as { error?: string; message?: string; details?: unknown };
      throw new ApiError(res.status, e.error ?? 'HTTP_' + res.status, e.message ?? res.statusText, e.details);
    }
    return data as T;
  }

  private renew() {
    this.renewing ??= this.renewSession()
      .then((launchToken) => this.startSession(launchToken))
      .then(() => undefined)
      .finally(() => (this.renewing = undefined));
    return this.renewing;
  }
}

/** A fresh idempotency key per confirmed order, so a retried submit cannot create a second order. */
export const newIdempotencyKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
