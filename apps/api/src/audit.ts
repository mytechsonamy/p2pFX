import type { Queryable } from './db/pool.js';

const replacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

/** Appends to the audit log (the table rejects updates and deletes). */
export async function audit(db: Queryable, actor: string, action: string, payload: unknown): Promise<void> {
  await db.query('insert into audit_log (actor, action, payload) values ($1, $2, $3)', [
    actor,
    action,
    JSON.stringify(payload, replacer),
  ]);
}
