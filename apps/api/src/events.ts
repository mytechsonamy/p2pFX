import { EventEmitter } from 'node:events';
import type pg from 'pg';
import { Listener } from './db/pool.js';

export type StreamEvent =
  | { type: 'book'; pair: string; bids: LevelView[]; asks: LevelView[] }
  | { type: 'order'; customerId: string; order: unknown }
  | { type: 'fill'; customerId: string; fill: unknown }
  | { type: 'trade'; pair: string; trade: unknown }
  /** Best LP prices; the stream turns them into each customer's segment rates. */
  | { type: 'lp'; pair: string; bid: string; ask: string; at: string };

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
  private listener?: Listener;

  constructor(
    private readonly db: pg.Pool,
    private readonly log: { warn: (o: object, m: string) => void } = { warn: () => {} },
  ) {
    this.emitter.setMaxListeners(0);
  }

  /**
   * Delivery is best effort: an event lost while the LISTEN connection is down is not replayed. Clients
   * reload their state when their socket reconnects, and the database stays the source of truth.
   */
  async start(connectionString: string) {
    this.listener = new Listener(
      connectionString,
      CHANNEL,
      (payload) => {
        if (payload) this.emitter.emit('event', JSON.parse(payload) as StreamEvent);
      },
      this.log,
    );
    await this.listener.start();
  }

  get connected() {
    return this.listener?.connected ?? false;
  }

  async stop() {
    await this.listener?.stop();
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
