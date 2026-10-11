import { LiquidityError, type LiquidityAdapter, type LpExecution, type LpExecutionRequest, type LpQuote } from './liquidity.js';

/**
 * Several LP connections as one (a bank's own price module next to a direct Saxo or IBKR connection): pairs
 * and quotes are the union of all sources, and a trade goes to the source whose quotes carry that LP name.
 * A source that fails to quote is skipped, so one LP going down never takes the others' prices with it.
 */
export class CompositeLiquidity implements LiquidityAdapter {
  private readonly owner = new Map<string, LiquidityAdapter>();

  constructor(private readonly sources: LiquidityAdapter[]) {}

  async instruments() {
    const lists = await Promise.allSettled(this.sources.map((s) => s.instruments()));
    return [...new Set(lists.flatMap((l) => (l.status === 'fulfilled' ? l.value : [])))];
  }

  async quotes(pair: string): Promise<LpQuote[]> {
    const results = await Promise.allSettled(this.sources.map((s) => s.quotes(pair)));
    const out: LpQuote[] = [];
    results.forEach((r, i) => {
      if (r.status !== 'fulfilled') return;
      for (const q of r.value) this.owner.set(q.lp, this.sources[i]);
      out.push(...r.value);
    });
    if (!out.length) {
      const failure = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
      throw failure?.reason instanceof LiquidityError ? failure.reason : new LiquidityError(`no liquidity for ${pair}`);
    }
    return out;
  }

  /** The source that quotes as `lp` (after a restart, learnt from a fresh quote of the pair). */
  private async source(lp: string, pair?: string) {
    if (!this.owner.has(lp) && pair) await this.quotes(pair).catch(() => {});
    return this.owner.get(lp);
  }

  async execute(req: LpExecutionRequest): Promise<LpExecution> {
    const source = await this.source(req.lp, req.pair);
    if (!source) throw new LiquidityError(`unknown LP ${req.lp}`);
    return source.execute(req);
  }

  async findExecution(lp: string, ref: string, request?: Omit<LpExecutionRequest, 'lp' | 'ref'>) {
    const source = await this.source(lp, request?.pair);
    if (source) return source.findExecution(lp, ref, request);
    // Unknown LP name and nothing to learn it from: ask every source. "Not found" only if every source answered.
    let failure: unknown;
    for (const s of this.sources) {
      try {
        const found = await s.findExecution(lp, ref, request);
        if (found) return found;
      } catch (err) {
        failure = err;
      }
    }
    if (failure) throw failure;
    return undefined;
  }
}
