import type { FastifyInstance } from 'fastify';
import { formatDecimal, findPair, parseDecimal } from '@p2p/shared';
import type { AppContext } from '../app.js';
import { ApiError, badRequest, notFound } from '../errors.js';
import { audit } from '../audit.js';

/** Bank operations API: configuration, failed settlements, revenue, reference rates (prototype). */
export function opsRoutes(app: FastifyInstance, ctx: AppContext) {
  const { auth, config, db, settlement } = ctx;

  app.get('/ops/config', async (req) => {
    auth.ops(req);
    return config.get();
  });

  app.put('/ops/config', async (req) => {
    const actor = auth.ops(req);
    return config.update(req.body, actor);
  });

  app.get<{ Querystring: { status?: string } }>('/ops/settlements', async (req) => {
    auth.ops(req);
    const status = req.query.status ?? 'FAILED_NEEDS_REVIEW';
    const { rows } = await db.query(
      `select s.*, f.pair, f.qty, f.book_price, f.created_at as fill_created_at from settlements s join fills f on f.id = s.fill_id
        where s.status = $1 order by f.seq desc limit 500`,
      [status],
    );
    return rows.map((r) => ({
      id: r.id,
      fillId: r.fill_id,
      leg: r.leg,
      status: r.status,
      pair: r.pair,
      qty: r.qty.toString(),
      bookPrice: r.book_price,
      attempts: r.attempts,
      retryRound: r.retry_round,
      lastError: r.last_error,
      coreTxnRef: r.core_txn_ref,
      reversalRef: r.reversal_ref,
      updatedAt: r.updated_at,
    }));
  });

  app.post<{ Params: { id: string } }>('/ops/settlements/:id/retry', async (req) => {
    const actor = auth.ops(req);
    const { rows } = await db.query('select fill_id from settlements where id::text = $1 or fill_id::text = $1 limit 1', [req.params.id]);
    if (!rows.length) throw notFound('settlement not found');
    const outcome = await settlement.retry(rows[0].fill_id, actor);
    return { fillId: rows[0].fill_id, outcome };
  });

  /** Commission earned and tax collected on settled fills, per pair. */
  app.get<{ Querystring: { from?: string; to?: string } }>('/ops/revenue', async (req) => {
    auth.ops(req);
    const from = req.query.from ? new Date(req.query.from) : new Date(0);
    const to = req.query.to ? new Date(req.query.to) : new Date(8.64e15);
    if (isNaN(from.getTime()) || isNaN(to.getTime())) throw badRequest('INVALID_RANGE', 'from/to must be ISO dates');
    const { rows } = await db.query(
      `select f.pair, count(*)::int as fills, sum(f.qty)::bigint as volume, sum(f.notional)::bigint as notional,
              sum(f.buyer_commission)::bigint as buy_commission, sum(f.seller_commission)::bigint as sell_commission,
              sum(f.buyer_tax)::bigint as buyer_tax, sum(f.seller_tax)::bigint as seller_tax
         from fills f
        where f.created_at >= $1 and f.created_at < $2
          and not exists (select 1 from settlements s where s.fill_id = f.id and s.status <> 'SETTLED')
        group by f.pair order by f.pair`,
      [from, to],
    );
    const cfg = config.get().data;
    return rows.map((r) => {
      const pair = findPair(cfg, r.pair);
      const q = (v: bigint) => formatDecimal(v, pair?.quoteDecimals ?? 2);
      return {
        pair: r.pair,
        fills: r.fills,
        volume: formatDecimal(r.volume, pair?.baseDecimals ?? 2),
        notional: q(r.notional),
        commission: { buySide: q(r.buy_commission), sellSide: q(r.sell_commission), total: q(r.buy_commission + r.sell_commission) },
        tax: { buyers: q(r.buyer_tax), sellers: q(r.seller_tax), total: q(r.buyer_tax + r.seller_tax) },
        currency: pair?.quote ?? 'TRY',
      };
    });
  });

  /** Prototype only: moves the mock core's reference rate (drives the price band). */
  app.put<{ Params: { pair: string }; Body: { rate: string } }>('/ops/rates/:pair', async (req) => {
    const actor = auth.ops(req);
    const core = ctx.core as { setReferenceRate?: (pair: string, rate: string) => unknown };
    if (!core.setReferenceRate) throw new ApiError(501, 'NOT_SUPPORTED', 'the core banking adapter does not support setting rates');
    try {
      parseDecimal(req.body?.rate ?? '', 8);
    } catch {
      throw badRequest('INVALID_RATE', 'rate must be a decimal string');
    }
    const r = await core.setReferenceRate(req.params.pair, req.body.rate);
    await audit(db, actor, 'rate.set', { pair: req.params.pair, rate: req.body.rate });
    return r;
  });
}
