import { findPair, formatDecimal, type BankConfig } from '@p2p/shared';
import type { Queryable } from './db/pool.js';

export interface ReportRange {
  from: Date;
  to: Date;
}

/**
 * Volume and economics per pair over a range, by flow:
 * - C2C: two customers matched on the board (the only true P2P volume; two customer legs per fill);
 * - C2B: a customer matched with the bank's ladder (BANK_MM) or bot (BOT_MM) on the board;
 * - Direct: the customer's instant deal with the bank (BANK_DIRECT).
 * The P2P match ratio is the share of customer leg volume that met another customer. Contribution is the
 * commission charged plus the Direct margin (the bank's spread over the LP on its own deals). Failed board
 * fills and rejected Direct deals are left out.
 */
export async function flowReport(db: Queryable, config: BankConfig, range: ReportRange) {
  const { rows: board } = await db.query(
    `select f.pair, f.flow,
            case when f.flow = 'C2B' then (case when f.maker_source = 'CUSTOMER' then f.taker_source else f.maker_source end) end as bank_source,
            count(*)::int as fills, coalesce(sum(f.qty), 0)::bigint as qty, coalesce(sum(f.notional), 0)::bigint as notional,
            coalesce(sum(f.buyer_commission + f.seller_commission), 0)::bigint as commission,
            coalesce(sum(f.buyer_tax + f.seller_tax), 0)::bigint as tax
       from fills f
      where f.created_at >= $1 and f.created_at < $2
        and not exists (select 1 from settlements s where s.fill_id = f.id and s.status in ('FAILED_NEEDS_REVIEW', 'REVERSED', 'REVERSAL_PENDING'))
      group by 1, 2, 3`,
    [range.from, range.to],
  );
  const { rows: direct } = await db.query(
    `select pair, count(*)::int as deals, coalesce(sum(qty), 0)::bigint as qty, coalesce(sum(notional), 0)::bigint as notional,
            coalesce(sum(margin), 0)::bigint as margin, coalesce(sum(tax), 0)::bigint as tax
       from bank_deals where created_at >= $1 and created_at < $2 and status in ('PENDING', 'SETTLED', 'FAILED_NEEDS_REVIEW')
      group by pair`,
    [range.from, range.to],
  );
  const pairs = new Set([...board.map((r) => r.pair as string), ...direct.map((r) => r.pair as string)]);
  const out = [];
  for (const symbol of [...pairs].sort()) {
    const pair = findPair(config, symbol);
    const b = pair?.baseDecimals ?? 2;
    const q = pair?.quoteDecimals ?? 2;
    const pick = (flow: string, source?: string) =>
      board.filter((r) => r.pair === symbol && r.flow === flow && (source === undefined || r.bank_source === source));
    const sum = (rows: Record<string, any>[], k: string) => rows.reduce((a, r) => a + BigInt(r[k]), 0n);
    const c2c = pick('C2C');
    const mm = pick('C2B', 'BANK_MM');
    const bot = pick('C2B', 'BOT_MM');
    const d = direct.filter((r) => r.pair === symbol);
    const c2cQty = sum(c2c, 'qty');
    const c2bQty = sum(mm, 'qty') + sum(bot, 'qty');
    const directQty = sum(d, 'qty');
    // Customer legs: both sides of a C2C fill are customers; one side of a C2B fill or a Direct deal is.
    const customerLegQty = 2n * c2cQty + c2bQty + directQty;
    const commission = sum([...c2c, ...mm, ...bot], 'commission');
    const margin = sum(d, 'margin');
    const flow = (rows: Record<string, any>[], countKey = 'fills') => ({
      count: rows.reduce((a, r) => a + Number(r[countKey]), 0),
      qty: formatDecimal(sum(rows, 'qty'), b),
      notional: formatDecimal(sum(rows, 'notional'), q),
    });
    out.push({
      pair: symbol,
      currency: pair?.quote ?? 'TRY',
      c2c: flow(c2c),
      c2b: { bankMarketMaker: flow(mm), botMarketMaker: flow(bot), total: flow([...mm, ...bot]) },
      direct: flow(d, 'deals'),
      customerLegVolume: formatDecimal(customerLegQty, b),
      /** Share of customer leg volume matched with another customer (0–1, four decimals). */
      p2pMatchRatio: customerLegQty === 0n ? null : formatDecimal((2n * c2cQty * 10_000n) / customerLegQty, 4),
      fees: formatDecimal(commission, q),
      directMargin: formatDecimal(margin, q),
      contribution: formatDecimal(commission + margin, q),
      tax: formatDecimal(sum([...c2c, ...mm, ...bot], 'tax') + sum(d, 'tax'), q),
    });
  }
  return out;
}

/** What operations should look at now: settlements, deals and hedges in doubt, open hold tasks, positions past limits. */
export async function exceptions(db: Queryable) {
  const { rows: settlements } = await db.query(
    `select s.fill_id, s.leg, s.status, s.last_error, s.updated_at, f.pair from settlements s join fills f on f.id = s.fill_id
      where s.status in ('FAILED_NEEDS_REVIEW', 'UNKNOWN_OUTCOME', 'REVERSAL_PENDING') order by s.updated_at limit 200`,
  );
  const { rows: deals } = await db.query(
    `select id, pair, status, last_error, updated_at from bank_deals where status = 'FAILED_NEEDS_REVIEW'
        or (status = 'PENDING' and updated_at < now() - interval '1 minute') order by updated_at limit 200`,
  );
  const { rows: hedges } = await db.query(
    `select id, pair, side, qty, lp, status, created_at from hedges where status in ('PENDING', 'UNKNOWN') order by seq limit 200`,
  );
  const { rows: holds } = await db.query(`select id, hold_id, ref, action, attempts, last_error from hold_tasks where not done order by id limit 200`);
  return {
    settlements: settlements.map((r) => ({ fillId: r.fill_id, pair: r.pair, leg: r.leg, status: r.status, lastError: r.last_error, since: r.updated_at })),
    deals: deals.map((r) => ({ dealId: r.id, pair: r.pair, status: r.status, lastError: r.last_error, since: r.updated_at })),
    hedges: hedges.map((r) => ({ hedgeId: r.id, pair: r.pair, side: r.side, qty: String(r.qty), lp: r.lp, state: r.status === 'PENDING' ? 'SENT' : 'UNKNOWN_OUTCOME', since: r.created_at })),
    holdTasks: holds.map((r) => ({ id: String(r.id), holdId: r.hold_id, ref: r.ref, action: r.action, attempts: r.attempts, lastError: r.last_error })),
  };
}
