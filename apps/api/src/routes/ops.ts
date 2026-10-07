import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { formatDecimal, findPair, parseDecimal } from '@p2p/shared';
import type { AppContext } from '../app.js';
import { ApiError, badRequest, notFound } from '../errors.js';
import { audit } from '../audit.js';
import { hashPassword } from '../auth.js';
import { exceptions, flowReport } from '../reports.js';

const parse = <T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T => {
  const r = schema.safeParse(value);
  if (!r.success) throw badRequest('INVALID_REQUEST', 'request is invalid', r.error.issues);
  return r.data;
};

const Role = z.enum(['viewer', 'editor', 'admin']);
const UserView = (r: Record<string, any>) => ({
  username: r.username,
  displayName: r.display_name,
  role: r.role,
  active: r.active,
  createdBy: r.created_by,
  createdAt: r.created_at,
  lastLoginAt: r.last_login_at,
});

/** Bank operations API: back office sign-in, parameters with history, audit log, operators, settlements, revenue, reference rates (prototype). */
export function opsRoutes(app: FastifyInstance, ctx: AppContext) {
  const { auth, config, db, settlement } = ctx;

  // ---- back office sign-in ----

  app.post('/ops/login', async (req) => {
    const { username, password } = parse(z.object({ username: z.string().min(1), password: z.string().min(1) }), req.body);
    const r = await auth.opsLogin(username.trim().toLowerCase(), password);
    await audit(db, r.operator.username, 'ops.login', {});
    return r;
  });

  app.get('/ops/me', async (req) => {
    const actor = await auth.ops(req);
    if (actor.startsWith('service:')) return { username: actor, displayName: actor, role: 'editor', service: true };
    return auth.operator(req.headers.authorization!.slice(7));
  });

  // ---- bank parameters ----

  app.get('/ops/config', async (req) => {
    await auth.ops(req);
    return config.get();
  });

  /**
   * Replaces the configuration. Body: { config, reason, dryRun?, expectedVersion? } (a stale expectedVersion is a 409) (a bare configuration is still accepted from
   * service integrations, with the X-Ops-Reason header as the reason). `dryRun` validates and returns the diff.
   */
  app.put<{ Body: Record<string, unknown> }>('/ops/config', async (req) => {
    const actor = await auth.ops(req, 'editor');
    const body = req.body ?? {};
    const wrapped = 'config' in body;
    const input = wrapped ? body.config : body;
    const reason = String((wrapped ? body.reason : req.headers['x-ops-reason']) ?? '');
    const expectedVersion = wrapped && typeof body.expectedVersion === 'number' ? body.expectedVersion : undefined;
    return config.update(input, actor, reason, { dryRun: wrapped && body.dryRun === true, expectedVersion });
  });

  app.get<{ Querystring: { limit?: string } }>('/ops/config/versions', async (req) => {
    await auth.ops(req);
    return config.history(Number(req.query.limit ?? 50) || 50);
  });

  app.get<{ Params: { version: string } }>('/ops/config/versions/:version', async (req) => {
    await auth.ops(req);
    const version = Number(req.params.version);
    if (!Number.isInteger(version)) throw notFound('version not found');
    return { version, data: await config.byVersion(version) };
  });

  app.post('/ops/config/revert', async (req) => {
    const actor = await auth.ops(req, 'editor');
    const { version, reason } = parse(z.object({ version: z.number().int(), reason: z.string() }), req.body);
    return config.revert(version, actor, reason);
  });

  /** Shipped defaults and whether an operator has changed or confirmed each. */
  app.get('/ops/config/assumptions', async (req) => {
    await auth.ops(req);
    return config.assumptions();
  });

  app.post('/ops/config/assumptions/confirm', async (req) => {
    const actor = await auth.ops(req, 'editor');
    const { keys, reason } = parse(z.object({ keys: z.array(z.string()).min(1), reason: z.string().default('') }), req.body);
    return config.confirm(keys, actor, reason ?? '');
  });

  // ---- audit log ----

  app.get<{ Querystring: { action?: string; actor?: string; limit?: string; before?: string } }>('/ops/audit', async (req) => {
    await auth.ops(req);
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
    // `action=backoffice`: everything but the customer order flow (orders and fills).
    const backoffice = req.query.action === 'backoffice';
    const { rows } = await db.query(
      `select id, actor, action, payload, created_at from audit_log
        where ($1::text is null or action like $1 || '%') and ($2::text is null or actor = $2) and ($3::bigint is null or id < $3)
          and (not $5 or (action not like 'order%' and action <> 'fill'))
        order by id desc limit $4`,
      [backoffice ? null : req.query.action || null, req.query.actor || null, req.query.before || null, limit, backoffice],
    );
    return rows.map((r) => ({ id: r.id.toString(), actor: r.actor, action: r.action, payload: r.payload, at: r.created_at }));
  });

  // ---- operators (admin) ----

  app.get('/ops/users', async (req) => {
    await auth.ops(req, 'admin');
    const { rows } = await db.query('select * from ops_users order by username');
    return rows.map(UserView);
  });

  app.post('/ops/users', async (req) => {
    const actor = await auth.ops(req, 'admin');
    const body = parse(
      z.object({ username: z.string().regex(/^[a-z0-9._-]{3,32}$/), displayName: z.string().min(1).max(80), role: Role, password: z.string().min(8) }),
      req.body,
    );
    const { rows } = await db.query(
      `insert into ops_users (username, display_name, role, password_hash, created_by) values ($1, $2, $3, $4, $5)
       on conflict do nothing returning *`,
      [body.username, body.displayName, body.role, await hashPassword(body.password), actor],
    );
    if (!rows.length) throw new ApiError(409, 'USER_EXISTS', `operator ${body.username} already exists`);
    await audit(db, actor, 'ops.user.create', { username: body.username, role: body.role });
    return UserView(rows[0]);
  });

  app.patch<{ Params: { username: string } }>('/ops/users/:username', async (req) => {
    const actor = await auth.ops(req, 'admin');
    const body = parse(z.object({ role: Role.optional(), active: z.boolean().optional(), password: z.string().min(8).optional(), displayName: z.string().min(1).max(80).optional() }), req.body);
    if (req.params.username === actor && (body.active === false || (body.role && body.role !== 'admin'))) {
      throw badRequest('SELF_LOCKOUT', 'you cannot disable yourself or drop your own admin role');
    }
    const { rows } = await db.query(
      `update ops_users set role = coalesce($2, role), active = coalesce($3, active), password_hash = coalesce($4, password_hash),
         display_name = coalesce($5, display_name),
         password_changed_at = case when $4::text is null then password_changed_at else $6 end where username = $1 returning *`,
      [req.params.username, body.role ?? null, body.active ?? null, body.password ? await hashPassword(body.password) : null, body.displayName ?? null, ctx.clock()],
    );
    if (!rows.length) throw notFound('operator not found');
    await audit(db, actor, 'ops.user.update', { username: req.params.username, role: body.role, active: body.active, passwordReset: !!body.password });
    return UserView(rows[0]);
  });

  app.get<{ Querystring: { status?: string } }>('/ops/settlements', async (req) => {
    await auth.ops(req);
    const statuses = req.query.status ? [req.query.status] : ['FAILED_NEEDS_REVIEW', 'UNKNOWN_OUTCOME', 'REVERSAL_PENDING'];
    const { rows } = await db.query(
      `select s.*, f.pair, f.qty, f.book_price, f.created_at as fill_created_at from settlements s join fills f on f.id = s.fill_id
        where s.status = any($1) order by f.seq desc limit 500`,
      [statuses],
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
    const actor = await auth.ops(req, 'editor');
    const { rows } = await db.query('select fill_id from settlements where id::text = $1 or fill_id::text = $1 limit 1', [req.params.id]);
    if (!rows.length) throw notFound('settlement not found');
    const outcome = await settlement.retry(rows[0].fill_id, actor);
    return { fillId: rows[0].fill_id, outcome };
  });

  /** Commission earned and tax collected on settled fills, per pair. */
  app.get<{ Querystring: { from?: string; to?: string } }>('/ops/revenue', async (req) => {
    await auth.ops(req);
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

  const range = (q: { from?: string; to?: string }) => {
    const from = q.from ? new Date(q.from) : new Date(0);
    const to = q.to ? new Date(q.to) : new Date(8.64e15);
    if (isNaN(from.getTime()) || isNaN(to.getTime())) throw badRequest('INVALID_RANGE', 'from/to must be ISO dates');
    return { from, to };
  };

  /** C2C, C2B (ladder, bot) and Direct volumes, the P2P match ratio, customer leg volume, fees and contribution per pair. */
  app.get<{ Querystring: { from?: string; to?: string } }>('/ops/reports', async (req) => {
    await auth.ops(req);
    return { pairs: await flowReport(db, config.get().data, range(req.query)) };
  });

  /** Settlements, deals and hedges in doubt, open hold tasks, and positions against their limits. */
  app.get('/ops/exceptions', async (req) => {
    await auth.ops(req);
    const positions = (await ctx.positions.snapshot()).map((p) => ({ pair: p.pair, qty: p.qty, limit: p.limit, maxPosition: p.maxPosition }));
    return { ...(await exceptions(db)), positions };
  });

  /**
   * Kill switch, second half: cancels open orders (all, one pair and/or one source). Stopping new entries is the
   * configuration's `killSwitch`; this takes out what is already resting. Audited with its reason.
   */
  app.post('/ops/controls/cancel-orders', async (req) => {
    const actor = await auth.ops(req, 'editor');
    const body = parse(
      z.object({ pair: z.string().optional(), source: z.enum(['CUSTOMER', 'BANK_MM', 'BOT_MM']).optional(), reason: z.string().min(3) }),
      req.body,
    );
    if (body.pair && !findPair(config.get().data, body.pair)) throw badRequest('UNKNOWN_PAIR', `pair ${body.pair} not found`);
    const cancelled = await ctx.exchange.cancelOrders({ pair: body.pair, source: body.source });
    await audit(db, actor, 'ops.orders.cancel', { pair: body.pair ?? null, source: body.source ?? null, reason: body.reason, cancelled });
    return { cancelled };
  });

  /** Prototype only: moves the mock core's reference rate (drives the price band). */
  app.put<{ Params: { pair: string }; Body: { rate: string } }>('/ops/rates/:pair', async (req) => {
    const actor = await auth.ops(req, 'editor');
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
