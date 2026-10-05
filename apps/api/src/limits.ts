import { localParts, parseDecimal, zonedTime, type BankConfig, type PairConfig } from '@p2p/shared';
import type pg from 'pg';
import type { Session } from './auth.js';
import { unprocessable } from './errors.js';

/**
 * The customer's daily limit, shared by P2P orders and bank deals (one risk limit per customer).
 * Must run inside the transaction that records the new order or deal: the per-customer advisory lock makes
 * concurrent requests queue, so two of them can never both see the same unused limit.
 *
 * Counted today (in the market's timezone): live and filled orders at full value, cancelled or expired orders
 * only for what they filled, and every bank deal that was not rejected. Values are quote-currency minor units
 * (all pairs are quoted in TRY).
 */
export async function reserveDailyLimit(client: pg.PoolClient, config: BankConfig, session: Session, notional: bigint, pair: PairConfig, now: Date) {
  const limits = config.limits.segments[session.segment] ?? config.limits.default;
  await client.query(`select pg_advisory_xact_lock(hashtext('daily-limit:' || $1::text))`, [session.customerId]);
  const p = localParts(now, config.tradingHours.timezone);
  const dayStart = zonedTime(p.year, p.month, p.day, '00:00', config.tradingHours.timezone);
  const { rows } = await client.query(
    `select
       (select coalesce(sum(case when status in ('CANCELLED', 'EXPIRED') then notional * filled_qty / qty else notional end), 0)
          from orders where customer_id = $1 and created_at >= $2 and status <> 'REJECTED')
     + (select coalesce(sum(notional), 0) from bank_deals where customer_id = $1 and created_at >= $2 and status <> 'REJECTED')
       as total`,
    [session.customerId, dayStart],
  );
  if (BigInt(rows[0].total) + notional > parseDecimal(limits.maxDailyNotional, pair.quoteDecimals)) {
    throw unprocessable('DAILY_LIMIT_EXCEEDED', `daily limit of ${limits.maxDailyNotional} ${pair.quote} exceeded`);
  }
}
