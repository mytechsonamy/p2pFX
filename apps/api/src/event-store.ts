import { randomUUID } from 'node:crypto';
import type { Queryable } from './db/pool.js';

/** The bank's own principal (one deployment = one bank); see migration 006. */
export const BANK_PRINCIPAL_ID = '00000000-0000-0000-0000-000000000001';

export type LiquiditySource = 'CUSTOMER' | 'BANK_MM' | 'BOT_MM';

export type EventType =
  | 'OrderAccepted'
  | 'OrderCancelled'
  | 'LiquidityGenerationReplaced'
  | 'FillCommitted'
  | 'PrincipalExecutionCommitted'
  | 'PositionUpdated'
  | 'HedgeRequested'
  | 'HedgeUpdated'
  | 'SettlementUpdated'
  | 'ConfigChanged';

export interface DomainEvent {
  type: EventType;
  aggregateType: 'order' | 'fill' | 'generation' | 'execution' | 'position' | 'hedge' | 'settlement' | 'config';
  aggregateId: string;
  pair?: string;
  /** The request or command the event belongs to (one fill's events share their fill id). */
  correlationId?: string;
  /** The event or command that caused this one. */
  causationId?: string;
  configVersion?: number;
  payload: Record<string, unknown>;
}

/**
 * Appends to the event log, in the caller's transaction so an event exists exactly when the change it describes
 * does. Pair events get the pair's next sequence number (they are written by the pair's one sequencer); every
 * event gets the aggregate's next version, so a duplicate or a reordering is visible. Returns the event id.
 */
export async function appendEvent(db: Queryable, e: DomainEvent): Promise<string> {
  const eventId = randomUUID();
  let pairSeq: string | null = null;
  if (e.pair) {
    const { rows } = await db.query(
      `insert into pair_sequences (pair, seq) values ($1, 1) on conflict (pair) do update set seq = pair_sequences.seq + 1 returning seq`,
      [e.pair],
    );
    pairSeq = rows[0].seq;
  }
  await db.query(
    `insert into events (event_id, type, aggregate_type, aggregate_id, aggregate_version, pair, pair_seq, correlation_id, causation_id, config_version, payload)
     values ($1, $2, $3, $4,
       coalesce((select max(aggregate_version) from events where aggregate_type = $3 and aggregate_id = $4), 0) + 1,
       $5, $6, $7, $8, $9, $10)`,
    [
      eventId, e.type, e.aggregateType, e.aggregateId, e.pair ?? null, pairSeq, e.correlationId ?? null, e.causationId ?? null,
      e.configVersion ?? null, JSON.stringify(e.payload, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
    ],
  );
  return eventId;
}
