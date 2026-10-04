import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { CoreBankingAdapter } from '@p2p/core-adapter';
import type { BankConfig } from '@p2p/shared';
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

export interface AppOptions {
  databaseUrl: string;
  core: CoreBankingAdapter;
  bankPublicKeyPem: string;
  sessionSecret: string;
  opsToken: string;
  /** Used only when the database has no configuration yet. */
  initialConfig?: BankConfig;
  clock?: () => Date;
  settlement?: SettlementOptions;
  /** Scheduler interval; 0 disables it (tests call tick()). */
  schedulerIntervalMs?: number;
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
  rateLimit: (customerId: string) => void;
}

export async function buildApp(opts: AppOptions): Promise<{ app: FastifyInstance; ctx: AppContext; close: () => Promise<void> }> {
  const clock = opts.clock ?? (() => new Date());
  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(websocket);

  const db = createPool(opts.databaseUrl);
  await migrate(db);

  const config = new ConfigService(db);
  await config.init(opts.initialConfig);
  const events = new EventBus(db);
  await events.start(opts.databaseUrl);
  const auth = new AuthService(db, { bankPublicKeyPem: opts.bankPublicKeyPem, sessionSecret: opts.sessionSecret, opsToken: opts.opsToken, clock });
  const settlement = new SettlementService(db, opts.core, config, app.log, opts.settlement ?? { attempts: 3, baseDelayMs: 500 });
  const exchange = new Exchange(db, opts.core, config, settlement, events, app.log);
  const entry = new OrderEntry(db, opts.core, config, exchange, clock);
  const scheduler = new Scheduler(db, exchange, config, clock, app.log);

  // Per-customer order entry rate limit (sliding window, in memory).
  const hits = new Map<string, number[]>();
  const rateLimit = (customerId: string) => {
    const { max, windowSeconds } = config.get().data.orderRateLimit;
    const now = clock().getTime();
    const recent = (hits.get(customerId) ?? []).filter((t) => t > now - windowSeconds * 1000);
    if (recent.length >= max) throw new ApiError(429, 'RATE_LIMITED', 'too many orders, try again shortly');
    recent.push(now);
    hits.set(customerId, recent);
  };

  const ctx: AppContext = { db, core: opts.core, auth, config, events, settlement, exchange, entry, scheduler, clock, rateLimit };

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.status).send({ error: err.code, message: err.message, details: err.details });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: 'BAD_REQUEST', message: (err as Error).message });
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: 'INTERNAL', message: 'internal error' });
  });

  app.get('/health', async () => ({ ok: true, configVersion: config.get().version }));
  customerRoutes(app, ctx);
  opsRoutes(app, ctx);
  streamRoutes(app, ctx);

  await exchange.start();
  if (opts.schedulerIntervalMs) scheduler.start(opts.schedulerIntervalMs);

  const close = async () => {
    scheduler.stop();
    await app.close();
    await exchange.idle();
    await events.stop();
    await db.end();
  };
  return { app, ctx, close };
}
