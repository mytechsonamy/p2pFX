import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { CoreBankingAdapter, LiquidityAdapter } from '@p2p/core-adapter';
import { formatPrice, type BankConfig } from '@p2p/shared';
import { createPool, type Db } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { AuthService } from './auth.js';
import { ConfigService } from './config-service.js';
import { EventBus } from './events.js';
import { SettlementService, type SettlementOptions } from './settlement.js';
import { Exchange } from './engine/exchange.js';
import { OrderEntry } from './order-entry.js';
import { Scheduler } from './scheduler.js';
import { ApiError } from './errors.js';
import { customerRoutes } from './routes/customer.js';
import { opsRoutes } from './routes/ops.js';
import { streamRoutes } from './routes/stream.js';
import { dealingRoutes } from './routes/dealing.js';
import { PriceEngine, segmentRates } from './dealing/price-engine.js';
import { PositionKeeper } from './dealing/positions.js';
import { DealingService } from './dealing/dealing.js';
import { BankAccount, BankBook, BotMarketMaker } from './dealing/bank-book.js';

/**
 * Commands that move money or risk (orders, cancels, bank deals, hedges, settlement retries). They run only on the
 * matching instance: it owns the book, the per-pair and per-hedge serialisation and the recovery jobs. Any other
 * instance refuses them before touching the database, core banking or an LP.
 */
const FINANCIAL_COMMANDS = new Set([
  'POST /v1/orders',
  'DELETE /v1/orders/:id',
  'POST /v1/bank/quotes',
  'POST /v1/bank/deals',
  'POST /ops/dealing/hedges',
  'POST /ops/dealing/hedges/:id/resolve',
  'POST /ops/dealing/deals/:id/retry',
  'POST /ops/settlements/:id/retry',
  'POST /ops/controls/cancel-orders',
]);

export interface AppOptions {
  databaseUrl: string;
  core: CoreBankingAdapter;
  /** The bank's liquidity providers (dealing). */
  liquidity: LiquidityAdapter;
  bankPublicKeyPem: string;
  sessionSecret: string;
  opsToken: string;
  /** Password for the first back office administrator (`admin`), used only while there are no operators. */
  opsAdminPassword?: string;
  /** Used only when the database has no configuration yet. */
  initialConfig?: BankConfig;
  clock?: () => Date;
  /**
   * Runs matching, the scheduler and the bank's ladder (default). Only one instance per database may: a second
   * one with matching on refuses to start. Instances with it off serve reads, config and streams only.
   */
  matching?: boolean;
  /** Overrides the configuration's settlement retry policy (tests). */
  settlement?: SettlementOptions;
  /** Scheduler interval; 0 disables it (tests call tick()). */
  schedulerIntervalMs?: number;
  /** LP price refresh interval; 0 disables it (prices are then pulled on demand). */
  priceIntervalMs?: number;
  /** How often the bank's own ladder in the book is checked and repriced; 0 disables it (tests call tick()). */
  bankBookIntervalMs?: number;
  /** How often the bot market maker checks its levels (it refreshes per its configuration); 0 disables it (tests call tick()). */
  botIntervalMs?: number;
  logger?: boolean;
}

export interface AppContext {
  db: Db;
  core: CoreBankingAdapter;
  auth: AuthService;
  config: ConfigService;
  events: EventBus;
  settlement: SettlementService;
  exchange: Exchange;
  entry: OrderEntry;
  scheduler: Scheduler;
  clock: () => Date;
  rateLimit: (customerId: string, segment?: string) => void;
  prices: PriceEngine;
  positions: PositionKeeper;
  dealing: DealingService;
  bankBook: BankBook;
  bot: BotMarketMaker;
  liquidity: LiquidityAdapter;
}

export async function buildApp(opts: AppOptions): Promise<{ app: FastifyInstance; ctx: AppContext; close: () => Promise<void> }> {
  const clock = opts.clock ?? (() => new Date());
  // Session tokens travel in the WebSocket URL (?token=): they are cut out of every logged URL.
  const app = Fastify({
    logger: opts.logger
      ? {
          serializers: {
            req: (req: { method: string; url: string; hostname?: string; ip?: string }) => ({
              method: req.method,
              url: redactUrl(req.url),
              hostname: req.hostname,
              remoteAddress: req.ip,
            }),
          },
        }
      : false,
  });
  await app.register(websocket);

  const db = createPool(opts.databaseUrl, (err) => app.log.error({ err }, 'idle database connection lost'));
  await migrate(db);

  const config = new ConfigService(db);
  await config.init(opts.initialConfig);
  await config.listen(opts.databaseUrl, app.log);
  const events = new EventBus(db, app.log);
  await events.start(opts.databaseUrl);
  const auth = new AuthService(db, { bankPublicKeyPem: opts.bankPublicKeyPem, sessionSecret: opts.sessionSecret, opsToken: opts.opsToken, clock, config });
  await auth.bootstrapAdmin(opts.opsAdminPassword);
  const settlement = new SettlementService(db, opts.core, config, app.log, opts.settlement);
  const prices = new PriceEngine(db, opts.liquidity, config, events, clock, app.log);
  const positions = new PositionKeeper(db, opts.liquidity, prices, config, app.log);
  const exchange = new Exchange(db, opts.core, config, settlement, events, app.log, clock, {
    evidence: (pair) => priceEvidence(config, prices, pair),
    headroom: (pair, side, resting) => positions.headroom(pair, side, resting),
    reserveExecution: (pair, delta) => positions.tryReserve(pair, delta),
  });
  const entry = new OrderEntry(db, opts.core, config, exchange, prices, clock);
  const dealing = new DealingService(db, opts.core, config, prices, positions, events, clock, app.log, opts.settlement);
  const account = new BankAccount(db, opts.core);
  const bankBook = new BankBook(db, config, exchange, prices, account, app.log);
  const bot = new BotMarketMaker(config, exchange, prices, account, app.log, clock);
  const scheduler = new Scheduler(db, exchange, settlement, dealing, positions, config, clock, app.log);

  // Per-customer order entry rate limit (sliding window, in memory).
  const hits = new Map<string, number[]>();
  const rateLimit = (customerId: string, segment?: string) => {
    const c = config.get().data;
    const { windowSeconds } = c.orderRateLimit;
    const max = (segment && c.limits.segments[segment]?.maxOrdersPerWindow) || c.orderRateLimit.max;
    const now = clock().getTime();
    const recent = (hits.get(customerId) ?? []).filter((t) => t > now - windowSeconds * 1000);
    if (recent.length >= max) throw new ApiError(429, 'RATE_LIMITED', 'too many orders, try again shortly');
    recent.push(now);
    hits.set(customerId, recent);
  };

  const ctx: AppContext = { db, core: opts.core, auth, config, events, settlement, exchange, entry, scheduler, clock, rateLimit, prices, positions, dealing, bankBook, bot, liquidity: opts.liquidity };

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.status).send({ error: err.code, message: err.message, details: err.details });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: 'BAD_REQUEST', message: (err as Error).message });
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: 'INTERNAL', message: 'internal error' });
  });

  // Liveness: the process answers.
  app.get('/health', async () => ({ ok: true, configVersion: config.get().version }));
  // Readiness: the database answers, events flow and (on the matching instance) matching runs; plus the
  // numbers operations should alert on.
  app.get('/ready', async (_req, reply) => {
    const checks: Record<string, unknown> = {};
    let ok = true;
    try {
      const { rows } = await db.query(
        `select
           (select count(*)::int from settlements where status in ('FAILED_NEEDS_REVIEW', 'UNKNOWN_OUTCOME', 'REVERSAL_PENDING')) as settlements_needing_review,
           (select count(*)::int from settlements where status = 'REVERSAL_PENDING') as reversals_unconfirmed,
           (select extract(epoch from now() - min(updated_at))::int from settlements where status = 'PENDING') as oldest_pending_settlement_s,
           (select count(*)::int from bank_deals where status in ('PENDING', 'FAILED_NEEDS_REVIEW')) as deals_open,
           (select count(*)::int from hedges where status in ('PENDING', 'UNKNOWN')) as hedges_unresolved,
           (select count(*)::int from hold_tasks where not done) as hold_tasks_open`,
      );
      Object.assign(checks, { database: true }, rows[0]);
    } catch {
      ok = false;
      checks.database = false;
    }
    checks.events = events.connected;
    checks.matching = exchange.running;
    if (!events.connected || ((opts.matching ?? true) && !exchange.running)) ok = false;
    const c = config.get().data;
    checks.lpPricesFresh = c.pairs.filter((p) => p.enabled).every((p) => !!prices.fresh(p.symbol));
    return reply.status(ok ? 200 : 503).send({ ok, ...checks });
  });
  // Checked before authentication and the handler, so a refused command has no side effect at all. This also
  // covers the matching instance after it lost its lock.
  app.addHook('onRequest', async (req) => {
    if (exchange.running || !FINANCIAL_COMMANDS.has(`${req.method} ${req.routeOptions.url}`)) return;
    throw new ApiError(503, 'MATCHING_UNAVAILABLE', 'this instance does not process trading commands; send them to the matching instance');
  });
  customerRoutes(app, ctx);
  opsRoutes(app, ctx);
  streamRoutes(app, ctx);
  dealingRoutes(app, ctx);

  const matching = opts.matching ?? true;
  if (matching) {
    await positions.load();
    await exchange.start();
    await positions.resolveOpenClips().catch((err) => app.log.error({ err }, 'resolving open hedge clips failed'));
    await dealing.resumePending().catch((err) => app.log.error({ err }, 'resuming pending deals failed'));
    if (opts.schedulerIntervalMs) scheduler.start(opts.schedulerIntervalMs);
    if (opts.bankBookIntervalMs) bankBook.start(opts.bankBookIntervalMs);
    if (opts.botIntervalMs) bot.start(opts.botIntervalMs);
  }
  // A configuration change (a source switched off, a halt, a disabled pair) reaches the bank's liquidity at once.
  config.onChange(() => {
    if (!exchange.running) return;
    void bankBook.enforce().catch((err) => app.log.error({ err }, 'withdrawing the bank ladder after a configuration change failed'));
    void bot.enforce().catch((err) => app.log.error({ err }, 'withdrawing the bot after a configuration change failed'));
  });
  if (opts.priceIntervalMs) prices.start(opts.priceIntervalMs);

  const close = async () => {
    scheduler.stop();
    prices.stop();
    bankBook.stop();
    bot.stop();
    await app.close();
    await exchange.idle();
    await positions.idle();
    await exchange.stop();
    await events.stop();
    await config.stop();
    await db.end();
  };
  return { app, ctx, close };
}

/** LP best bid/ask and the bank's Direct rates for a pair at this moment, stored with each fill. */
function priceEvidence(config: ConfigService, prices: PriceEngine, pair: string): Record<string, unknown> | undefined {
  const agg = prices.cached(pair);
  if (!agg) return undefined;
  const c = config.get().data;
  const p = c.pairs.find((x) => x.symbol === pair);
  const direct = p ? segmentRates(c, p, agg, c.bankBook.anchorSegment) : undefined;
  return {
    lp: { bid: formatPrice(agg.bid), ask: formatPrice(agg.ask), bidLp: agg.bidLp, askLp: agg.askLp, at: agg.at.toISOString(), fresh: !!prices.fresh(pair) },
    direct: direct && { buy: formatPrice(direct.buy), sell: formatPrice(direct.sell), segment: c.bankBook.anchorSegment },
  };
}

export function redactUrl(url: string) {
  return url.replace(/([?&](?:token|launchToken|access_token)=)[^&]*/gi, '$1[REDACTED]');
}
