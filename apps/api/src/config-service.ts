import { BankConfigSchema, DEFAULT_CONFIG, type BankConfig } from '@p2p/shared';
import type { Db } from './db/pool.js';
import { audit } from './audit.js';
import { badRequest } from './errors.js';

export interface VersionedConfig {
  version: number;
  data: BankConfig;
}

/** Versioned bank configuration. Every change creates a new version; orders and fills record the version used. */
export class ConfigService {
  private current?: VersionedConfig;
  private listeners: ((c: VersionedConfig) => void)[] = [];

  constructor(private readonly db: Db) {}

  /** Loads the latest version, creating version 1 from `initial` on an empty database. */
  async init(initial: BankConfig = DEFAULT_CONFIG): Promise<VersionedConfig> {
    const { rows } = await this.db.query('select version, data from config order by version desc limit 1');
    if (rows.length) {
      this.current = { version: rows[0].version, data: BankConfigSchema.parse(rows[0].data) };
    } else {
      this.current = await this.save(initial, 'system');
    }
    return this.current;
  }

  get(): VersionedConfig {
    if (!this.current) throw new Error('config not loaded');
    return this.current;
  }

  async byVersion(version: number): Promise<BankConfig> {
    if (this.current?.version === version) return this.current.data;
    const { rows } = await this.db.query('select data from config where version = $1', [version]);
    return BankConfigSchema.parse(rows[0].data);
  }

  async update(input: unknown, actor: string): Promise<VersionedConfig> {
    const parsed = BankConfigSchema.safeParse(input);
    if (!parsed.success) throw badRequest('INVALID_CONFIG', 'configuration is invalid', parsed.error.issues);
    return this.save(parsed.data, actor);
  }

  onChange(fn: (c: VersionedConfig) => void) {
    this.listeners.push(fn);
  }

  private async save(data: BankConfig, actor: string): Promise<VersionedConfig> {
    const { rows } = await this.db.query('insert into config (data, created_by) values ($1, $2) returning version', [data, actor]);
    this.current = { version: rows[0].version, data };
    await audit(this.db, actor, 'config.update', { version: this.current.version, data });
    for (const fn of this.listeners) fn(this.current);
    return this.current;
  }
}
