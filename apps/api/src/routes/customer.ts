import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PlaceOrderSchema, QuoteRequestSchema, findPair, formatDecimal, formatPrice, isMarketOpen, parsePrice } from '@p2p/shared';
import { toWire } from '@p2p/core-adapter';
import type { AppContext } from '../app.js';
import { ApiError, badRequest, notFound } from '../errors.js';
import { loadOrder, loadOrders, orderView } from '../orders.js';
import { fillViewFor, tradeView } from '../fills.js';
import { dealView } from '../dealing/dealing.js';

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const r = schema.safeParse(value);
  if (!r.success) throw badRequest('INVALID_REQUEST', 'request is invalid', r.error.issues);
  return r.data;
};

export function customerRoutes(app: FastifyInstance, ctx: AppContext) {
  const { auth, config, core, db, entry, exchange } = ctx;

  app.post('/v1/session', async (req) => {
    const { launchToken } = parse(z.object({ launchToken: z.string() }), req.body);
    const s = await auth.exchangeLaunchToken(launchToken);
    return { token: s.token, expiresAt: s.expiresAt, customer: { ref: s.session.customerRef, segment: s.session.segment, locale: s.session.locale } };
  });

  /** What the UI needs: branding, pairs with commission, tax, validity options, hours and the customer's limits. */
  app.get('/v1/config', async (req) => {
    const session = await auth.customer(req);
    const { data: c, version } = config.get();
    return {
      version,
      bank: c.bank,
      branding: c.branding,
      balanceMode: c.balanceMode,
      pairs: c.pairs
        .filter((p) => p.enabled)
        .map((p) => ({
          symbol: p.symbol,
          base: p.base,
          quote: p.quote,
          baseDecimals: p.baseDecimals,
          quoteDecimals: p.quoteDecimals,
          tickSize: p.tickSize,
          minQty: p.minQty,
          priceBandPct: p.priceBandPct,
          bipSize: p.bipSize,
          commissionPerUnit: {
            buy: formatPrice(BigInt(p.commission.buyBips) * parsePrice(p.bipSize)),
            sell: formatPrice(BigInt(p.commission.sellBips) * parsePrice(p.bipSize)),
          },
        })),
      tax: { buyRate: c.tax.buyRate, sellRate: c.tax.sellRate, base: c.tax.base },
      validity: c.validity,
      tradingHours: c.tradingHours,
      marketOpen: isMarketOpen(ctx.clock(), c.tradingHours),
      limits: c.limits.segments[session.segment] ?? c.limits.default,
      dealing: { enabled: c.dealing.enabled, quoteTtlSeconds: c.dealing.quoteTtlSeconds, maxDealQty: c.dealing.maxDealQty },
    };
  });

  app.get('/v1/accounts', async (req) => {
    const session = await auth.customer(req);
    const accounts = await core.getAccounts(session.customerRef);
    return accounts.map((a) => ({
      id: a.id,
      currency: a.currency,
      name: a.name,
      iban: a.iban,
      balance: formatDecimal(a.balance, a.decimals),
      held: formatDecimal(a.held, a.decimals),
      available: formatDecimal(a.available, a.decimals),
    }));
  });

  app.get<{ Params: { pair: string } }>('/v1/pairs/:pair/book', async (req) => {
    await auth.customer(req);
    if (!findPair(config.get().data, req.params.pair)) throw notFound(`pair ${req.params.pair} not found`);
    return exchange.depth(req.params.pair);
  });

  /** Bank reference rate plus indicative all-in buy and sell prices around it. */
  app.get<{ Params: { pair: string } }>('/v1/pairs/:pair/rate', async (req) => {
    await auth.customer(req);
    const pair = findPair(config.get().data, req.params.pair);
    if (!pair) throw notFound(`pair ${req.params.pair} not found`);
    const r = await core.getReferenceRate(pair.symbol).catch(() => {
      throw new ApiError(503, 'REFERENCE_RATE_UNAVAILABLE', 'reference rate unavailable');
    });
    const ref = parsePrice(r.rate);
    const bip = parsePrice(pair.bipSize);
    return {
      pair: pair.symbol,
      rate: formatPrice(ref),
      asOf: r.asOf,
      buyPrice: formatPrice(ref + BigInt(pair.commission.buyBips) * bip),
      sellPrice: formatPrice(ref - BigInt(pair.commission.sellBips) * bip),
      bandLow: formatPrice(ref - (ref * parsePrice(pair.priceBandPct)) / 100n / 10n ** 8n),
      bandHigh: formatPrice(ref + (ref * parsePrice(pair.priceBandPct)) / 100n / 10n ** 8n),
    };
  });

  /** Recent trades on the pair, newest first, as shown on the market board. */
  app.get<{ Params: { pair: string }; Querystring: { limit?: string } }>('/v1/pairs/:pair/trades', async (req) => {
    await auth.customer(req);
    const c = config.get().data;
    if (!findPair(c, req.params.pair)) throw notFound(`pair ${req.params.pair} not found`);
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    const { rows } = await db.query(
      `select id, pair, book_price, qty, taker_order_id, buy_order_id, created_at from fills where pair = $1 order by seq desc limit $2`,
      [req.params.pair, limit],
    );
    return rows.map((r) => tradeView(r, c));
  });

  /** Today's session on the pair (in the bank's time zone): open, high, low, last, volume, previous close. */
  app.get<{ Params: { pair: string } }>('/v1/pairs/:pair/stats', async (req) => {
    await auth.customer(req);
    const c = config.get().data;
    const pair = findPair(c, req.params.pair);
    if (!pair) throw notFound(`pair ${req.params.pair} not found`);
    const { rows } = await db.query(
      `with day as (select (date_trunc('day', now() at time zone $2) at time zone $2) as start),
            today as (select f.* from fills f, day where f.pair = $1 and f.created_at >= day.start)
       select (select book_price from today order by seq limit 1) as open,
              (select book_price from today order by seq desc limit 1) as last,
              (select max(book_price) from today) as high,
              (select min(book_price) from today) as low,
              (select coalesce(sum(qty), 0) from today) as volume,
              (select coalesce(sum(notional), 0) from today) as turnover,
              (select count(*) from today) as trades,
              (select book_price from fills f, day where f.pair = $1 and f.created_at < day.start order by seq desc limit 1) as prev_close`,
      // Fill timestamps come from the database clock, so the day boundary does too.
      [pair.symbol, c.tradingHours.timezone],
    );
    const r = rows[0];
    const price = (v: string | null) => (v == null ? null : formatPrice(parsePrice(v)));
    return {
      pair: pair.symbol,
      open: price(r.open),
      high: price(r.high),
      low: price(r.low),
      last: price(r.last),
      prevClose: price(r.prev_close),
      volume: formatDecimal(BigInt(r.volume), pair.baseDecimals),
      turnover: formatDecimal(BigInt(r.turnover), pair.quoteDecimals),
      trades: Number(r.trades),
    };
  });

  app.post('/v1/orders/quote', async (req) => {
    await auth.customer(req);
    return entry.quote(parse(QuoteRequestSchema, req.body));
  });

  app.post('/v1/orders', async (req, reply) => {
    const session = await auth.customer(req);
    ctx.rateLimit(session.customerId, session.segment);
    const body = parse(PlaceOrderSchema, req.body);
    const result = await entry.place(session, body, req.headers['idempotency-key'] as string | undefined);
    return reply.status(result.replayed ? 200 : 201).send(result.order);
  });

  app.get<{ Querystring: { status?: string; limit?: string } }>('/v1/orders', async (req) => {
    const session = await auth.customer(req);
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
    const open = req.query.status === 'open';
    const rows = await loadOrders(
      db,
      `o.customer_id = $1 and o.status <> 'NEW' ${open ? `and o.status in ('OPEN','PARTIAL','QUEUED')` : ''} order by o.seq desc limit $2`,
      [session.customerId, limit],
    );
    return rows.map((o) => orderView(o, config.get().data));
  });

  app.get<{ Params: { id: string } }>('/v1/orders/:id', async (req) => {
    const session = await auth.customer(req);
    const o = await ownOrder(req.params.id, session.customerId);
    return orderView(o, config.get().data);
  });

  app.delete<{ Params: { id: string } }>('/v1/orders/:id', async (req) => {
    const session = await auth.customer(req);
    const o = await ownOrder(req.params.id, session.customerId);
    if (!['OPEN', 'PARTIAL', 'QUEUED'].includes(o.status)) {
      throw new ApiError(409, 'ORDER_NOT_CANCELLABLE', `order is ${o.status}`);
    }
    const updated = await exchange.cancel(o.id, 'USER');
    return orderView(updated!, config.get().data);
  });

  app.get<{ Querystring: { limit?: string } }>('/v1/fills', async (req) => {
    const session = await auth.customer(req);
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
    const { rows } = await db.query(
      `select f.*, case when b.customer_id = $1 then 'BUY' else 'SELL' end as my_side,
              s.status as settlement_status, s.receipt_ref
         from fills f
         join orders b on b.id = f.buy_order_id
         join orders so on so.id = f.sell_order_id
         join settlements s on s.fill_id = f.id
          and s.leg = case when b.customer_id = $1 then 'BANK_SELL' else 'BANK_BUY' end
        where b.customer_id = $1 or so.customer_id = $1
        order by f.seq desc limit $2`,
      [session.customerId, limit],
    );
    const c = config.get().data;
    const p2p = rows.map((r) => fillViewFor(r, r.my_side, c, { status: r.settlement_status, receipt_ref: r.receipt_ref }));
    // Deals with the bank appear in the same list, with the bank as counterparty.
    const { rows: deals } = await db.query(
      `select * from bank_deals where customer_id = $1 and status <> 'REJECTED' order by seq desc limit $2`,
      [session.customerId, limit],
    );
    const bank = deals.flatMap((d) => {
      const pair = findPair(c, d.pair);
      return pair ? [dealView(d, pair)] : [];
    });
    return [...p2p, ...bank].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  });

  app.get<{ Params: { id: string } }>('/v1/fills/:id/receipt', async (req) => {
    const session = await auth.customer(req);
    const { rows } = await db.query(
      `select s.receipt_ref from fills f
         join orders b on b.id = f.buy_order_id join orders so on so.id = f.sell_order_id
         join settlements s on s.fill_id = f.id
          and s.leg = case when b.customer_id = $2 then 'BANK_SELL' else 'BANK_BUY' end
        where f.id = $1 and (b.customer_id = $2 or so.customer_id = $2)`,
      [req.params.id, session.customerId],
    );
    if (!rows.length) {
      const { rows: deal } = await db.query('select receipt_ref from bank_deals where id = $1 and customer_id = $2', [req.params.id, session.customerId]);
      rows.push(...deal);
    }
    if (!rows.length) throw notFound('fill not found');
    if (!rows[0].receipt_ref) throw new ApiError(409, 'NOT_SETTLED', 'the receipt is available once the fill is settled');
    return toWire(await core.getReceipt(rows[0].receipt_ref));
  });

  async function ownOrder(id: string, customerId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('order not found');
    const o = await loadOrder(db, id);
    if (!o || o.customer_id !== customerId || o.status === 'NEW') throw notFound('order not found');
    return o;
  }
}
