import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { findPair, formatPrice, instrument, parseDecimal, parsePrice, PRICE_SCALE, withPair } from '@p2p/shared';
import { toWire } from '@p2p/core-adapter';
import type { AppContext } from '../app.js';
import { ApiError, badRequest, notFound } from '../errors.js';
import { BankDealRequestSchema, BankQuoteRequestSchema } from '../dealing/dealing.js';
import { segmentRates } from '../dealing/price-engine.js';

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const r = schema.safeParse(value);
  if (!r.success) throw badRequest('INVALID_REQUEST', 'request is invalid', r.error.issues);
  return r.data;
};

/** Bank dealing: the customer's segment rates, quotes and deals; the dealer's view for operations. */
export function dealingRoutes(app: FastifyInstance, ctx: AppContext) {
  const { auth, config, core, db, dealing, positions, prices } = ctx;

  app.get<{ Params: { pair: string } }>('/v1/bank/rates/:pair', async (req) => {
    const session = await auth.customer(req);
    return dealing.rates(session, req.params.pair);
  });

  app.post('/v1/bank/quotes', async (req) => {
    const session = await auth.customer(req);
    ctx.rateLimit(session.customerId, session.segment);
    return dealing.quote(session, parse(BankQuoteRequestSchema, req.body));
  });

  app.post('/v1/bank/deals', async (req, reply) => {
    const session = await auth.customer(req);
    const { quoteId } = parse(BankDealRequestSchema, req.body);
    return reply.status(201).send(await dealing.execute(session, quoteId));
  });

  app.get<{ Params: { id: string } }>('/v1/bank/deals/:id/receipt', async (req) => {
    const session = await auth.customer(req);
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw notFound('deal not found');
    const { rows } = await db.query('select receipt_ref from bank_deals where id = $1 and customer_id = $2', [req.params.id, session.customerId]);
    if (!rows.length) throw notFound('deal not found');
    if (!rows[0].receipt_ref) throw new ApiError(409, 'NOT_SETTLED', 'the receipt is available once the deal is settled');
    return toWire(await core.getReceipt(rows[0].receipt_ref));
  });

  /** Price history: the aggregated LP mid sampled every few seconds. */
  app.get<{ Params: { pair: string }; Querystring: { minutes?: string } }>('/v1/pairs/:pair/history', async (req) => {
    await auth.customer(req);
    const minutes = Math.min(Number(req.query.minutes ?? 60) || 60, 24 * 60);
    const { rows } = await db.query(
      `select bid, ask, at from price_ticks where pair = $1 and at >= now() - make_interval(mins => $2) order by at`,
      [req.params.pair, minutes],
    );
    return rows.map((r) => ({ mid: formatPrice((parsePrice(r.bid) + parsePrice(r.ask)) / 2n), at: new Date(r.at).toISOString() }));
  });

  // ---- dealer (operations) ----

  app.get('/ops/dealing', async (req) => {
    await auth.ops(req);
    const c = config.get().data;
    const segments = ['default', ...Object.keys(c.dealing.margins.segments)];
    const pairs = [];
    for (const pair of c.pairs.filter((p) => p.enabled)) {
      const agg = await prices.current(pair.symbol).catch(() => prices.cached(pair.symbol));
      pairs.push({
        pair: pair.symbol,
        lps: agg?.quotes ?? [],
        best: agg ? { bid: formatPrice(agg.bid), ask: formatPrice(agg.ask), bidLp: agg.bidLp, askLp: agg.askLp, at: agg.at.toISOString() } : null,
        segments: agg
          ? Object.fromEntries(
              segments.map((s) => {
                const r = segmentRates(c, pair, agg, s);
                return [s, { buy: formatPrice(r.buy), sell: formatPrice(r.sell), buyBips: r.buyBips, sellBips: r.sellBips }];
              }),
            )
          : {},
      });
    }
    return {
      dealing: c.dealing,
      pairs,
      positions: await positions.snapshot(),
      deals: await dealing.recentDeals(),
      hedges: await positions.recentHedges(),
      bankBook: { enabled: c.bankBook.enabled, orders: await ctx.bankBook.snapshot() },
    };
  });

  app.post('/ops/dealing/hedges', async (req) => {
    const actor = await auth.ops(req, 'editor');
    const body = parse(z.object({ pair: z.string(), side: z.enum(['BUY', 'SELL']), qty: z.string() }), req.body);
    const pair = findPair(config.get().data, body.pair);
    if (!pair) throw badRequest('UNKNOWN_PAIR', `pair ${body.pair} is not available`);
    let qty: bigint;
    try {
      qty = parseDecimal(body.qty, pair.baseDecimals);
    } catch {
      throw badRequest('INVALID_QTY', 'quantity is invalid');
    }
    return positions.hedge(pair, body.side, qty, 'MANUAL', actor);
  });

  /** Closes a hedge clip whose outcome the LP never confirmed, after operations checked with the LP. */
  app.post<{ Params: { id: string } }>('/ops/dealing/hedges/:id/resolve', async (req) => {
    const actor = await auth.ops(req, 'editor');
    const body = parse(z.object({ outcome: z.literal('REJECTED'), note: z.string().min(3).max(500) }), req.body);
    return positions.resolveClip(req.params.id, body.outcome, body.note, actor);
  });

  app.post<{ Params: { id: string } }>('/ops/dealing/deals/:id/retry', async (req) => {
    const actor = await auth.ops(req, 'editor');
    return dealing.retry(req.params.id, actor);
  });

  // ---- instruments: what the LPs quote, and adding a pair ----

  /** Every pair the LPs quote, with its mid rate and whether the bank has it set up (and open). */
  app.get('/ops/instruments', async (req) => {
    await auth.ops(req);
    const c = config.get().data;
    const symbols = [...new Set([...(await ctx.liquidity.instruments()), ...c.pairs.map((p) => p.symbol)])];
    const rows = await Promise.all(
      symbols.map(async (symbol) => {
        const pair = findPair(c, symbol);
        const base = pair?.base ?? symbol.slice(0, 3);
        const quote = pair?.quote ?? symbol.slice(3);
        const mid = await midOf(symbol);
        const i = instrument(base, mid === undefined ? undefined : Number(formatPrice(mid)));
        return {
          symbol,
          base,
          quote,
          name: i.name,
          kind: i.kind,
          // Display precision: four decimals, two from a thousand lira up (a gram of gold).
          mid: mid === undefined ? null : Number(formatPrice(mid)).toFixed(mid >= 1000n * PRICE_SCALE ? 2 : 4),
          configured: !!pair,
          enabled: !!pair?.enabled,
        };
      }),
    );
    return rows.sort((a, b) => Number(b.configured) - Number(a.configured) || a.base.localeCompare(b.base));
  });

  /**
   * Adds a pair the LPs quote, closed for trading, with the instrument's defaults (bips, tick, min order, the
   * bank's ladder, limits). The operator reviews them and opens the pair under "Pariteler ve komisyon".
   */
  app.post('/ops/pairs', async (req) => {
    const actor = await auth.ops(req, 'editor');
    const body = parse(z.object({ symbol: z.string().regex(/^[A-Z]{6}$/), reason: z.string().default('') }), req.body);
    const c = config.get().data;
    if (findPair(c, body.symbol)) throw new ApiError(409, 'PAIR_EXISTS', `${body.symbol} is already set up`);
    if (!(await ctx.liquidity.instruments()).includes(body.symbol)) throw badRequest('NOT_QUOTED', `the LPs do not quote ${body.symbol}`);
    if (!body.symbol.endsWith('TRY')) throw badRequest('UNSUPPORTED_QUOTE', 'only pairs against TRY are supported');
    const mid = await midOf(body.symbol);
    const next = withPair(c, body.symbol.slice(0, 3), { enabled: false, rate: mid === undefined ? undefined : Number(formatPrice(mid)) });
    return config.update(next, actor, body.reason || `Yeni parite: ${body.symbol.slice(0, 3)}/TRY (işleme kapalı)`);
  });

  async function midOf(symbol: string) {
    try {
      const q = await ctx.liquidity.quotes(symbol);
      if (!q.length) return undefined;
      const bid = q.reduce((m, x) => (parsePrice(x.bid) > m ? parsePrice(x.bid) : m), 0n);
      const ask = q.reduce((m, x) => (m === 0n || parsePrice(x.ask) < m ? parsePrice(x.ask) : m), 0n);
      return (bid + ask) / 2n;
    } catch {
      return undefined;
    }
  }
}
