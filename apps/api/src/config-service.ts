import { ASSUMPTIONS, BankConfigSchema, DEFAULT_CONFIG, configIssues, diffConfig, pathMatches, type BankConfig, type ConfigChange, type ConfigIssue } from '@p2p/shared';
import { Listener, tx, type Db } from './db/pool.js';
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
  private listener?: Listener;

  constructor(private readonly db: Db) {}

  /** Loads the latest version, creating version 1 from `initial` on an empty database. */
  async init(initial: BankConfig = DEFAULT_CONFIG): Promise<VersionedConfig> {
    if (!(await this.reload())) {
      // A session lock must be taken and released on the same connection, so it gets a dedicated client.
      const lock = await this.db.connect();
      try {
        await lock.query('select pg_advisory_lock(727275)');
        if (!(await this.reload())) await this.save(BankConfigSchema.parse(initial), 'system', 'İlk yapılandırma (prototip varsayılanları)', []);
      } finally {
        await lock.query('select pg_advisory_unlock(727275)').catch(() => {});
        lock.release();
      }
    }
    return this.get();
  }

  /** Follows changes made through other API instances. */
  async listen(connectionString: string, log: { warn: (o: object, m: string) => void } = { warn: () => {} }) {
    const reload = () => void this.reload().catch((err) => log.warn({ err }, 'config reload failed'));
    // After a reconnect the latest version is reloaded: a change made while disconnected is not missed.
    this.listener = new Listener(connectionString, CHANNEL, (payload) => {
      if (Number(payload) > (this.current?.version ?? 0)) reload();
    }, log, reload);
    await this.listener.start();
  }

  async stop() {
    await this.listener?.stop();
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
  async update(input: unknown, actor: string, reason: string, opts: { dryRun?: boolean; expectedVersion?: number } = {}) {
    const parsed = BankConfigSchema.safeParse(input);
    if (!parsed.success) throw badRequest('INVALID_CONFIG', 'configuration is invalid', parsed.error.issues);
    const issues = [...configIssues(parsed.data), ...(await this.instrumentChanges(this.get().data, parsed.data))];
    if (issues.length) throw badRequest('INVALID_CONFIG', 'configuration is invalid', issues);
    // Optimistic concurrency: an editor working from an older version must reload instead of overwriting.
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== this.get().version) {
      throw new ApiError(409, 'VERSION_CONFLICT', `the configuration changed (now v${this.get().version}); reload and apply your change again`);
    }
    const diff = diffConfig(this.get().data, parsed.data);
    if (opts.dryRun) return { ...this.get(), diff, dryRun: true };
    if (!diff.length) throw new ApiError(409, 'NO_CHANGE', 'nothing changed');
    requireReason(reason);
    const saved = await this.save(parsed.data, actor, reason, diff);
    return { ...saved, diff };
  }

  /**
   * A pair that has orders or deals keeps its identity: its currencies and decimals cannot change (stored
   * minor-unit amounts would be read at the wrong scale) and it cannot be removed (close it instead).
   */
  private async instrumentChanges(from: BankConfig, to: BankConfig): Promise<ConfigIssue[]> {
    const issues: ConfigIssue[] = [];
    for (const old of from.pairs) {
      const i = to.pairs.findIndex((p) => p.symbol === old.symbol);
      const next = to.pairs[i];
      const changed = next ? (['base', 'quote', 'baseDecimals', 'quoteDecimals'] as const).filter((f) => next[f] !== old[f]) : [];
      if (next && !changed.length) continue;
      const { rows } = await this.db.query(
        `select (exists (select 1 from orders where pair = $1) or exists (select 1 from bank_deals where pair = $1)) as used`,
        [old.symbol],
      );
      if (!rows[0].used) continue;
      if (!next) issues.push({ path: ['pairs'], message: `${old.symbol} has trades and cannot be removed; close it instead` });
      else for (const f of changed) issues.push({ path: ['pairs', i, f], message: `${old.symbol} has trades; ${f} cannot change` });
    }
    return issues;
  }

  /** Restores an earlier version as a new version. */
  async revert(version: number, actor: string, reason: string) {
    requireReason(reason);
    const data = await this.byVersion(version);
    const issues = await this.instrumentChanges(this.get().data, data);
    if (issues.length) throw badRequest('INVALID_CONFIG', 'this version cannot be restored', issues);
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
