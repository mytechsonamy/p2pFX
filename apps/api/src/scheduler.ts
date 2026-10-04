import { isMarketOpen } from '@p2p/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from './db/pool.js';
import type { ConfigService } from './config-service.js';
import type { Exchange } from './engine/exchange.js';
import { audit } from './audit.js';
import type { SettlementService } from './settlement.js';

/** A settlement leg still PENDING this long after its last update was interrupted and is resumed. */
const STUCK_SETTLEMENT_MS = 60_000;

/**
 * Periodic jobs: expire orders past their validity (releasing holds), when the session
 * opens move queued orders into matching, and resume settlements that were interrupted.
 */
export class Scheduler {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly db: Db,
    private readonly exchange: Exchange,
    private readonly settlement: SettlementService,
    private readonly config: ConfigService,
    private readonly clock: () => Date,
    private readonly log: FastifyBaseLogger,
  ) {}

  start(intervalMs: number) {
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.tick()
        .catch((err) => this.log.error({ err }, 'scheduler tick failed'))
        .finally(() => (this.running = false));
    }, intervalMs);
  }

  stop() {
    clearInterval(this.timer);
  }

  async tick(): Promise<{ expired: number; released: number }> {
    const now = this.clock();
    const { rows: due } = await this.db.query(
      `select id from orders where status in ('OPEN', 'PARTIAL', 'QUEUED') and expires_at <= $1 order by seq`,
      [now],
    );
    for (const r of due) await this.exchange.cancel(r.id, 'EXPIRED');

    let released = 0;
    if (isMarketOpen(now, this.config.get().data.tradingHours)) {
      const { rows: queued } = await this.db.query(`select id, pair from orders where status = 'QUEUED' order by seq`);
      for (const r of queued) {
        const { rowCount } = await this.db.query(`update orders set status = 'OPEN', updated_at = now() where id = $1 and status = 'QUEUED'`, [r.id]);
        if (!rowCount) continue;
        await audit(this.db, 'system', 'order.released', { orderId: r.id });
        await this.exchange.submit(r.id, r.pair);
        released++;
      }
    }
    await this.settlement.resumePending(STUCK_SETTLEMENT_MS);
    return { expired: due.length, released };
  }
}
