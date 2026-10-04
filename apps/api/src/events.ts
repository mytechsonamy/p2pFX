import { EventEmitter } from 'node:events';
import pg from 'pg';

export type StreamEvent =
  | { type: 'book'; pair: string; bids: LevelView[]; asks: LevelView[] }
  | { type: 'order'; customerId: string; order: unknown }
  | { type: 'fill'; customerId: string; fill: unknown }
  | { type: 'trade'; pair: string; trade: unknown };

export interface LevelView {
  price: string;
  qty: string;
  count: number;
}

const CHANNEL = 'p2p_events';

/**
 * Publishes stream events through Postgres NOTIFY and delivers them to local
 * subscribers via LISTEN, so several API instances can serve WebSocket clients.
 */
export class EventBus {
  private readonly emitter = new EventEmitter();
  private listener?: pg.Client;

  constructor(private readonly db: pg.Pool) {
    this.emitter.setMaxListeners(0);
  }

  async start(connectionString: string) {
    this.listener = new pg.Client({ connectionString });
    await this.listener.connect();
    this.listener.on('notification', (msg) => {
      if (msg.channel === CHANNEL && msg.payload) this.emitter.emit('event', JSON.parse(msg.payload) as StreamEvent);
    });
    await this.listener.query(`listen ${CHANNEL}`);
  }

  async stop() {
    await this.listener?.end();
  }

  async publish(event: StreamEvent) {
    const payload = JSON.stringify(event, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    await this.db.query('select pg_notify($1, $2)', [CHANNEL, payload]);
  }

  subscribe(fn: (e: StreamEvent) => void): () => void {
    this.emitter.on('event', fn);
    return () => this.emitter.off('event', fn);
  }
}
