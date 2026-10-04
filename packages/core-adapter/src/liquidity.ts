/** Liquidity providers (LPs): the banks and venues the bank's FX desk prices from and hedges with. */

export interface LpQuote {
  lp: string;
  pair: string;
  /** Price the LP buys base at, decimal string. */
  bid: string;
  /** Price the LP sells base at, decimal string. */
  ask: string;
  at: string;
}

export interface LpExecutionRequest {
  lp: string;
  pair: string;
  /** The bank's side: BUY takes the LP's ask, SELL hits its bid. */
  side: 'BUY' | 'SELL';
  /** Base quantity, decimal string. */
  qty: string;
  /** The bank's reference for the trade (idempotent per LP). */
  ref: string;
}

export interface LpExecution extends LpExecutionRequest {
  rate: string;
  tradeRef: string;
  at: string;
}

export interface LiquidityAdapter {
  quotes(pair: string): Promise<LpQuote[]>;
  execute(req: LpExecutionRequest): Promise<LpExecution>;
}

export class LiquidityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiquidityError';
  }
}

interface MockLp {
  name: string;
  /** Half the LP's bid/ask spread, as a fraction of the price. */
  halfSpread: number;
}

const MOCK_LPS: MockLp[] = [
  { name: 'LP-A', halfSpread: 0.00012 },
  { name: 'LP-B', halfSpread: 0.0002 },
  { name: 'LP-C', halfSpread: 0.0003 },
];

export interface MockLiquidityOptions {
  /** Where each pair's price is anchored (the bank's reference rate); the walk reverts towards it. */
  anchor: (pair: string) => number | undefined;
  /** Volatility per √second as a fraction of the price; 0 freezes the market (tests). */
  volatility?: number;
  /** Mean reversion per second. */
  reversion?: number;
  clock?: () => number;
  random?: () => number;
}

/**
 * Three simulated LPs quoting around a mean-reverting random walk, each with its own spread and a little
 * independent noise, so the best bid and the best ask often come from different LPs.
 */
export class MockLiquidity implements LiquidityAdapter {
  private readonly mids = new Map<string, { mid: number; at: number }>();
  private readonly executions = new Map<string, LpExecution>();
  private seq = 0;
  private readonly volatility: number;
  private readonly reversion: number;
  private readonly clock: () => number;
  private readonly random: () => number;

  constructor(private readonly opts: MockLiquidityOptions) {
    this.volatility = opts.volatility ?? 0.0004;
    this.reversion = opts.reversion ?? 0.05;
    this.clock = opts.clock ?? Date.now;
    this.random = opts.random ?? Math.random;
  }

  private gaussian() {
    const u = 1 - this.random();
    const v = this.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  private mid(pair: string): number {
    const anchor = this.opts.anchor(pair);
    if (anchor === undefined) throw new LiquidityError(`no liquidity for ${pair}`);
    const now = this.clock();
    const s = this.mids.get(pair) ?? { mid: anchor, at: now };
    const dt = Math.min(Math.max((now - s.at) / 1000, 0), 60);
    if (dt > 0 && this.volatility > 0) {
      s.mid += this.reversion * (anchor - s.mid) * dt + this.volatility * anchor * Math.sqrt(dt) * this.gaussian();
    }
    s.at = now;
    this.mids.set(pair, s);
    return s.mid;
  }

  async quotes(pair: string): Promise<LpQuote[]> {
    const mid = this.mid(pair);
    const at = new Date(this.clock()).toISOString();
    return MOCK_LPS.map((lp) => {
      const m = mid * (1 + (this.volatility > 0 ? this.gaussian() * 0.00006 : 0));
      const half = m * lp.halfSpread * (this.volatility > 0 ? 1 + this.random() * 0.3 : 1);
      return { lp: lp.name, pair, bid: (m - half).toFixed(4), ask: (m + half).toFixed(4), at };
    });
  }

  async execute(req: LpExecutionRequest): Promise<LpExecution> {
    const key = `${req.lp}:${req.ref}`;
    const done = this.executions.get(key);
    if (done) return done;
    const quote = (await this.quotes(req.pair)).find((q) => q.lp === req.lp);
    if (!quote) throw new LiquidityError(`unknown LP ${req.lp}`);
    const exec: LpExecution = {
      ...req,
      rate: req.side === 'BUY' ? quote.ask : quote.bid,
      tradeRef: `${req.lp}-${String(++this.seq).padStart(6, '0')}`,
      at: quote.at,
    };
    this.executions.set(key, exec);
    return exec;
  }
}

/** LiquidityAdapter over HTTP: the mock core's `/lp` routes, or a bank's price-module facade. */
export class HttpLiquidityAdapter implements LiquidityAdapter {
  constructor(private readonly baseUrl: string) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(new URL(path, this.baseUrl), {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new LiquidityError(`liquidity unreachable: ${(err as Error).message}`);
    }
    const json = (await res.json().catch(() => undefined)) as { message?: string } | undefined;
    if (!res.ok) throw new LiquidityError(json?.message ?? `liquidity returned ${res.status}`);
    return json as T;
  }

  quotes(pair: string) {
    return this.call<LpQuote[]>('GET', `/lp/quotes/${pair}`);
  }
  execute(req: LpExecutionRequest) {
    return this.call<LpExecution>('POST', '/lp/executions', req);
  }
}
