import pg from 'pg';
import { ASSUMPTIONS, BankConfigSchema, DEFAULT_CONFIG, diffConfig, pathMatches, type BankConfig, type ConfigChange } from '@p2p/shared';
import { tx, type Db } from './db/pool.js';
import { audit } from './audit.js';
import { ApiError, badRequest, notFound } from './errors.js';

export interface VersionedConfig {
  version: number;
  data: BankConfig;
}

export interface ConfigVersion {
  version: number;
  createdBy: string;
  createdAt: string;
  reason: string | null;
  revertedFrom: number | null;
  diff: ConfigChange[];
}

const CHANNEL = 'p2p_config';

/**
 * Versioned bank configuration. Every change creates a new version with who made it, why and what changed;
 * orders and fills record the version used. The current version is held in memory, so hot paths (pricing on
 * every LP tick, order entry) never read the database. Other API instances reload it on a Postgres NOTIFY.
 */
export class ConfigService {
  private current?: VersionedConfig;
  private listeners: ((c: VersionedConfig) => void)[] = [];
  private listener?: pg.Client;

  constructor(private readonly db: Db) {}

  /** Loads the latest version, creating version 1 from `initial` on an empty database. */
  async init(initial: BankConfig = DEFAULT_CONFIG): Promise<VersionedConfig> {
    if (!(await this.reload())) {
      await this.db.query('select pg_advisory_lock(727275)');
      try {
        if (!(await this.reload())) await this.save(BankConfigSchema.parse(initial), 'system', 'İlk yapılandırma (prototip varsayılanları)', []);
      } finally {
        await this.db.query('select pg_advisory_unlock(727275)');
      }
    }
    return this.get();
  }

  /** Follows changes made through other API instances. */
  async listen(connectionString: string) {
    this.listener = new pg.Client({ connectionString });
    await this.listener.connect();
    this.listener.on('notification', (msg) => {
      if (msg.channel === CHANNEL && Number(msg.payload) > (this.current?.version ?? 0)) void this.reload();
    });
    await this.listener.query(`listen ${CHANNEL}`);
  }

  async stop() {
    await this.listener?.end();
  }

  get(): VersionedConfig {
    if (!this.current) throw new Error('config not loaded');
    return this.current;
  }

  async byVersion(version: number): Promise<BankConfig> {
    if (this.current?.version === version) return this.current.data;
    const { rows } = await this.db.query('select data from config where version = $1', [version]);
    if (!rows.length) throw notFound(`config version ${version} not found`);
    return BankConfigSchema.parse(rows[0].data);
  }

  /**
   * Validates a full configuration and, unless `dryRun`, stores it as a new version. Returns the changes
   * against the current version; a configuration identical to the current one is refused.
   */
  async update(input: unknown, actor: string, reason: string, opts: { dryRun?: boolean } = {}) {
    const parsed = BankConfigSchema.safeParse(input);
    if (!parsed.success) throw badRequest('INVALID_CONFIG', 'configuration is invalid', parsed.error.issues);
    const diff = diffConfig(this.get().data, parsed.data);
    if (opts.dryRun) return { ...this.get(), diff, dryRun: true };
    if (!diff.length) throw new ApiError(409, 'NO_CHANGE', 'nothing changed');
    requireReason(reason);
    const saved = await this.save(parsed.data, actor, reason, diff);
    return { ...saved, diff };
  }

  /** Restores an earlier version as a new version. */
  async revert(version: number, actor: string, reason: string) {
    requireReason(reason);
    const data = await this.byVersion(version);
    const diff = diffConfig(this.get().data, data);
    if (!diff.length) throw new ApiError(409, 'NO_CHANGE', `version ${version} is the same as the current configuration`);
    const saved = await this.save(data, actor, reason, diff, version);
    return { ...saved, diff };
  }

  async history(limit = 50): Promise<ConfigVersion[]> {
    const { rows } = await this.db.query(
      'select version, created_by, created_at, reason, reverted_from, diff from config order by version desc limit $1',
      [Math.min(Math.max(limit, 1), 500)],
    );
    return rows.map((r) => ({
      version: r.version,
      createdBy: r.created_by,
      createdAt: r.created_at.toISOString(),
      reason: r.reason,
      revertedFrom: r.reverted_from,
      diff: r.diff,
    }));
  }

  /**
   * The shipped defaults the bank still has to confirm. One counts as settled once a named operator changed
   * any of its parameters or confirmed it as is (service integrations such as demo scripts do not count).
   */
  async assumptions() {
    const { rows: changes } = await this.db.query(
      `select version, created_by, created_at, diff from config where created_by <> 'system' and created_by not like 'service:%' order by version desc`,
    );
    const { rows: confirms } = await this.db.query('select * from config_confirmations order by id desc');
    return ASSUMPTIONS.map((a) => {
      const change = changes.find((c) => (c.diff as ConfigChange[]).some((d) => a.paths.some((p) => pathMatches(d.path, p))));
      const confirm = confirms.find((c) => c.assumption === a.key);
      const latest =
        change && (!confirm || change.created_at > confirm.created_at)
          ? { how: 'changed' as const, by: change.created_by, at: change.created_at.toISOString(), version: change.version }
          : confirm
            ? { how: 'confirmed' as const, by: confirm.confirmed_by, at: confirm.created_at.toISOString(), version: confirm.config_version }
            : null;
      return { key: a.key, label: a.label, paths: a.paths, settled: latest };
    });
  }

  async confirm(keys: string[], actor: string, reason: string) {
    const unknown = keys.filter((k) => !ASSUMPTIONS.some((a) => a.key === k));
    if (!keys.length || unknown.length) throw badRequest('INVALID_ASSUMPTION', `unknown assumption: ${unknown.join(', ') || '(none)'}`);
    const { version } = this.get();
    for (const key of keys) {
      await this.db.query('insert into config_confirmations (assumption, config_version, confirmed_by, reason) values ($1, $2, $3, $4)', [
        key,
        version,
        actor,
        reason || null,
      ]);
    }
    await audit(this.db, actor, 'config.confirm', { keys, version, reason });
    return this.assumptions();
  }

  onChange(fn: (c: VersionedConfig) => void): () => void {
    this.listeners.push(fn);
    return () => (this.listeners = this.listeners.filter((l) => l !== fn));
  }

  private async reload(): Promise<boolean> {
    const { rows } = await this.db.query('select version, data from config order by version desc limit 1');
    if (!rows.length) return false;
    if (this.current && rows[0].version <= this.current.version) return true;
    this.set({ version: rows[0].version, data: BankConfigSchema.parse(rows[0].data) });
    return true;
  }

  private set(c: VersionedConfig) {
    this.current = c;
    for (const fn of this.listeners) fn(c);
  }

  private async save(data: BankConfig, actor: string, reason: string, diff: ConfigChange[], revertedFrom?: number): Promise<VersionedConfig> {
    const version = await tx(this.db, async (client) => {
      const { rows } = await client.query(
        'insert into config (data, created_by, reason, diff, reverted_from) values ($1, $2, $3, $4, $5) returning version',
        [data, actor, reason, JSON.stringify(diff), revertedFrom ?? null],
      );
      const v: number = rows[0].version;
      await audit(client, actor, revertedFrom ? 'config.revert' : 'config.update', { version: v, reason, revertedFrom, changes: diff });
      await client.query('select pg_notify($1, $2)', [CHANNEL, String(v)]);
      return v;
    });
    if (!this.current || version > this.current.version) this.set({ version, data });
    return this.get();
  }
}

function requireReason(reason: string) {
  if (!reason || reason.trim().length < 3) throw badRequest('REASON_REQUIRED', 'a reason for the change is required');
}
