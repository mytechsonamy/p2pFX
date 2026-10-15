import {
  beyondLimit,
  LiquidityError,
  LiquidityOutcomeUnknownError,
  type LiquidityAdapter,
  type LpExecution,
  type LpExecutionRequest,
  type LpQuote,
} from './liquidity.js';

export interface SaxoOptions {
  /** Access token (the developer portal's 24-hour token for SIM). */
  token: string;
  /** OpenAPI base URL; SIM by default. */
  baseUrl?: string;
  /** Pairs to price from Saxo, in Saxo's symbols (USDTRY, XAUUSD…). */
  pairs: string[];
  /** LP name the quotes and trades carry. */
  name?: string;
  /** Prices are fetched at most this often (one call for every pair); Saxo rate-limits each session. */
  minPollMs?: number;
  /** How long to wait for a market order to be confirmed filled before the outcome is unknown. */
  fillTimeoutMs?: number;
  /** Accept indicative prices (Saxo marks prices it would not trade on as Indicative). */
  allowIndicative?: boolean;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

interface InfoPrice {
  Uic: number;
  LastUpdated?: string;
  Quote?: { Bid?: number; Ask?: number; PriceTypeBid?: string; PriceTypeAsk?: string };
}

interface OrderActivity {
  OrderId: string;
  ExternalReference?: string;
  Status?: string;
  SubStatus?: string;
  BuySell?: string;
  Amount?: number;
  FilledAmount?: number;
  AveragePrice?: number;
  ExecutionPrice?: number;
  Price?: number;
  ActivityTime?: string;
}

/** Order activities read per page when a trade is looked up by reference, and how many pages at most. */
const AUDIT_PAGE = 1000;
const AUDIT_MAX_PAGES = 20;

/** Saxo prices with up to 8 decimals as plain strings (no exponent). */
const num = (v: number) => v.toFixed(8).replace(/\.?0+$/, '');

/**
 * Saxo Bank OpenAPI as one LP (FxSpot): prices from `infoprices/list`, market orders with the bank's reference
 * as `ExternalReference`, fills confirmed from the order activity audit. Prices are polled (one request for
 * every pair, cached for `minPollMs`); Saxo's streaming would replace this in production.
 */
export class SaxoLiquidity implements LiquidityAdapter {
  readonly name: string;
  private readonly base: string;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private uics?: Promise<Map<string, number>>;
  private accountKey?: Promise<string>;
  private cache?: { at: number; quotes: Promise<Map<string, LpQuote>> };
  /** Saxo order ids of the orders this process placed, by the bank's reference: looked up directly, not searched. */
  private readonly orderIds = new Map<string, string>();

  constructor(private readonly opts: SaxoOptions) {
    this.name = opts.name ?? 'SAXO';
    this.base = (opts.baseUrl ?? 'https://gateway.saxobank.com/sim/openapi').replace(/\/$/, '');
    this.fetchFn = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * `trade`: the call that places an order, so transport failures and 5xx are an unknown outcome (a 401 or 4xx means
   * Saxo refused the order). `placed`: a call made after an order was accepted (the fill poll), so every failure,
   * including 401 (the token expired meanwhile) and 429 (rate limit), is an unknown outcome: the order may fill.
   */
  private async call<T>(method: string, path: string, body?: unknown, opts: { trade?: boolean; placed?: boolean; requestId?: string } = {}): Promise<T> {
    const fail = (message: string) => (opts.trade || opts.placed ? new LiquidityOutcomeUnknownError(message) : new LiquidityError(message));
    const refused = (message: string) => (opts.placed ? new LiquidityOutcomeUnknownError(message) : new LiquidityError(message));
    let res: Response;
    try {
      res = await this.fetchFn(path.startsWith('http') ? path : `${this.base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.opts.token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(opts.requestId ? { 'x-request-id': opts.requestId } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw fail(`Saxo unreachable: ${(err as Error).message}`);
    }
    const json = (await res.json().catch(() => undefined)) as any;
    if (res.status === 401) throw refused('Saxo rejected the token (expired 24-hour token?)');
    if (res.status >= 500) throw fail(`Saxo returned ${res.status}`);
    if (!res.ok) throw refused(`Saxo ${json?.ErrorInfo?.ErrorCode ?? json?.ErrorCode ?? res.status}: ${json?.ErrorInfo?.Message ?? json?.Message ?? ''}`.trim());
    return json as T;
  }

  private uicMap() {
    this.uics ??= (async () => {
      const map = new Map<string, number>();
      for (const pair of this.opts.pairs) {
        const r = await this.call<{ Data?: { Identifier: number; Symbol: string }[] }>('GET', `/ref/v1/instruments?Keywords=${pair}&AssetTypes=FxSpot`);
        const hit = r.Data?.find((d) => d.Symbol?.toUpperCase() === pair);
        if (hit) map.set(pair, hit.Identifier);
      }
      return map;
    })().catch((err) => {
      this.uics = undefined;
      throw err;
    });
    return this.uics;
  }

  private account() {
    this.accountKey ??= this.call<{ Data?: { AccountKey: string }[] }>('GET', '/port/v1/accounts/me')
      .then((r) => {
        const key = r.Data?.[0]?.AccountKey;
        if (!key) throw new LiquidityError('Saxo returned no account');
        return key;
      })
      .catch((err) => {
        this.accountKey = undefined;
        throw err;
      });
    return this.accountKey;
  }

  async instruments() {
    return [...(await this.uicMap()).keys()];
  }

  private prices(): Promise<Map<string, LpQuote>> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < (this.opts.minPollMs ?? 1000)) return this.cache.quotes;
    const quotes = (async () => {
      const uics = await this.uicMap();
      const out = new Map<string, LpQuote>();
      if (!uics.size) return out;
      const pairOf = new Map([...uics].map(([p, u]) => [u, p]));
      const r = await this.call<{ Data?: InfoPrice[] }>('GET', `/trade/v1/infoprices/list?Uics=${[...uics.values()].join(',')}&AssetType=FxSpot&FieldGroups=Quote`);
      for (const d of r.Data ?? []) {
        const pair = pairOf.get(d.Uic);
        const q = d.Quote;
        if (!pair || !q?.Bid || !q?.Ask) continue;
        if (!this.opts.allowIndicative && (q.PriceTypeBid !== 'Tradable' || q.PriceTypeAsk !== 'Tradable')) continue;
        out.set(pair, { lp: this.name, pair, bid: num(q.Bid), ask: num(q.Ask), at: d.LastUpdated ?? new Date().toISOString() });
      }
      return out;
    })();
    this.cache = { at: now, quotes };
    // Only this fetch's own entry is dropped: a newer one made meanwhile stays.
    quotes.catch(() => {
      if (this.cache?.quotes === quotes) this.cache = undefined;
    });
    return quotes;
  }

  async quotes(pair: string): Promise<LpQuote[]> {
    const q = (await this.prices()).get(pair);
    if (!q) throw new LiquidityError(`Saxo has no tradable price for ${pair}`);
    return [q];
  }

  async execute(req: LpExecutionRequest): Promise<LpExecution> {
    if (req.lp !== this.name) throw new LiquidityError(`unknown LP ${req.lp}`);
    // A reference this process already sent is never sent again: it is filled, or its outcome is still open.
    // (After a restart the caller looks a reference up before it re-sends it.)
    if (this.orderIds.has(req.ref)) {
      const done = await this.findExecution(req.lp, req.ref, req);
      if (done) return done;
      throw new LiquidityOutcomeUnknownError(`Saxo order for ${req.ref} was already sent and is not confirmed filled`);
    }
    const uic = (await this.uicMap()).get(req.pair);
    if (uic === undefined) throw new LiquidityError(`Saxo does not trade ${req.pair}`);
    // Saxo gets a market order; the limit is enforced against its current price before the order is sent.
    if (req.limitRate) {
      this.cache = undefined;
      const [q] = await this.quotes(req.pair);
      const rate = req.side === 'BUY' ? q.ask : q.bid;
      if (beyondLimit(req.side, rate, req.limitRate)) {
        throw new LiquidityError(`SAXO price moved: ${rate} is beyond the limit ${req.limitRate}`);
      }
    }
    const placed = await this.call<{ OrderId?: string }>(
      'POST',
      '/trade/v2/orders',
      {
        AccountKey: await this.account(),
        Uic: uic,
        AssetType: 'FxSpot',
        BuySell: req.side === 'BUY' ? 'Buy' : 'Sell',
        Amount: Number(req.qty),
        OrderType: 'Market',
        OrderDuration: { DurationType: 'DayOrder' },
        ManualOrder: false,
        ExternalReference: req.ref,
      },
      { trade: true, requestId: req.ref },
    );
    if (!placed.OrderId) throw new LiquidityOutcomeUnknownError('Saxo accepted the order without an order id');
    this.orderIds.set(req.ref, placed.OrderId);
    const deadline = Date.now() + (this.opts.fillTimeoutMs ?? 5_000);
    for (;;) {
      const last = await this.call<{ Data?: OrderActivity[] }>('GET', `/cs/v1/audit/orderactivities?OrderId=${placed.OrderId}&EntryType=Last`, undefined, { placed: true });
      const a = last.Data?.[0];
      const exec = a && this.toExecution(req, a);
      if (exec) return exec;
      if (a && /Cancel|Reject|Expired/i.test(`${a.Status} ${a.SubStatus}`)) throw new LiquidityError(`Saxo ${a.Status}: order ${placed.OrderId} not filled`);
      if (Date.now() > deadline) throw new LiquidityOutcomeUnknownError(`Saxo order ${placed.OrderId} not confirmed filled in time`);
      await this.sleep(250);
    }
  }

  private toExecution(req: Pick<LpExecutionRequest, 'lp' | 'ref'> & Partial<LpExecutionRequest>, a: OrderActivity): LpExecution | undefined {
    if (a.Status !== 'FinalFill') return undefined;
    const rate = a.AveragePrice ?? a.ExecutionPrice ?? a.Price;
    if (!rate) return undefined;
    return {
      lp: req.lp,
      ref: req.ref,
      pair: req.pair ?? '',
      side: req.side ?? (a.BuySell === 'Sell' ? 'SELL' : 'BUY'),
      qty: req.qty ?? num(a.FilledAmount ?? a.Amount ?? 0),
      rate: num(rate),
      tradeRef: `SAXO-${a.OrderId}`,
      at: a.ActivityTime ?? new Date().toISOString(),
    };
  }

  /**
   * The fill for the bank's reference. An order this process placed is read by its order id. Otherwise the order
   * activity audit (which cannot be filtered by reference) is searched page by page; "not found" is only answered
   * once every page was read; a search that hits the page cap fails instead, so the trade stays open.
   */
  async findExecution(lp: string, ref: string, request?: Omit<LpExecutionRequest, 'lp' | 'ref'>) {
    if (lp !== this.name) return undefined;
    const known = this.orderIds.get(ref);
    if (known) {
      const r = await this.call<{ Data?: OrderActivity[] }>('GET', `/cs/v1/audit/orderactivities?OrderId=${known}&EntryType=Last`);
      const a = r.Data?.find((x) => x.Status === 'FinalFill');
      return a ? this.toExecution({ lp, ref, ...request }, a) : undefined;
    }
    let next: string | undefined = `/cs/v1/audit/orderactivities?EntryType=Last&$top=${AUDIT_PAGE}`;
    for (let page = 0; next; page++) {
      if (page === AUDIT_MAX_PAGES) throw new LiquidityError(`Saxo lookup of ${ref} stopped after ${AUDIT_MAX_PAGES * AUDIT_PAGE} activities`);
      const r: { Data?: OrderActivity[]; __next?: string } = await this.call('GET', next);
      const a = r.Data?.find((x) => x.ExternalReference === ref && x.Status === 'FinalFill');
      if (a) {
        this.orderIds.set(ref, a.OrderId);
        return this.toExecution({ lp, ref, ...request }, a);
      }
      next = r.__next;
    }
    return undefined;
  }
}
