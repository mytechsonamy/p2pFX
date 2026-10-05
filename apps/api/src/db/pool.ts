import pg from 'pg';

// bigint columns come back as strings by default; parse them as BigInt.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => BigInt(v));

export type Db = pg.Pool;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(connectionString: string, onError: (err: Error) => void = () => {}): Db {
  const pool = new pg.Pool({ connectionString, max: 10 });
  // An idle client losing its connection emits 'error' on the pool; unhandled, it would crash the process.
  pool.on('error', onError);
  return pool;
}

/**
 * A dedicated LISTEN connection that reconnects (with backoff) when the database drops it, calling
 * `onReconnect` so the owner can catch up on anything it missed while disconnected.
 */
export class Listener {
  private client?: pg.Client;
  private stopped = false;
  private retryMs = 500;

  constructor(
    private readonly connectionString: string,
    private readonly channel: string,
    private readonly onMessage: (payload: string | undefined) => void,
    private readonly log: { warn: (o: object, m: string) => void },
    private readonly onReconnect: () => void = () => {},
  ) {}

  async start() {
    const client = new pg.Client({ connectionString: this.connectionString });
    client.on('error', (err) => this.lost(client, err));
    client.on('end', () => this.lost(client));
    await client.connect();
    client.on('notification', (msg) => {
      if (msg.channel === this.channel) this.onMessage(msg.payload);
    });
    await client.query(`listen ${this.channel}`);
    this.client = client;
    this.retryMs = 500;
  }

  private lost(client: pg.Client, err?: Error) {
    if (this.stopped || this.client !== client) return;
    this.client = undefined;
    this.log.warn({ err, channel: this.channel }, 'LISTEN connection lost; reconnecting');
    const retry = () => {
      if (this.stopped) return;
      this.start().then(this.onReconnect, (e) => {
        this.log.warn({ err: e, channel: this.channel }, 'LISTEN reconnect failed');
        this.retryMs = Math.min(this.retryMs * 2, 30_000);
        setTimeout(retry, this.retryMs);
      });
    };
    setTimeout(retry, this.retryMs);
  }

  get connected() {
    return !!this.client;
  }

  async stop() {
    this.stopped = true;
    const c = this.client;
    this.client = undefined;
    await c?.end().catch(() => {});
  }
}

/** Runs `fn` in a transaction. */
export async function tx<T>(db: Db, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
