import { formatDecimal, formatPrice, parsePrice, findPair, type Side } from '@p2p/shared';
import { OrderBook, matchIncoming, type BookOrder, type MatchCandidate, type MatchDecision } from '@p2p/matching';
import { fromSnapshot, priceSide } from '@p2p/pricing';
import { CoreBankingError, type CoreBankingAdapter } from '@p2p/core-adapter';
import type { FastifyBaseLogger } from 'fastify';
import { tx, type Db } from '../db/pool.js';
import type { ConfigService } from '../config-service.js';
import type { EventBus } from '../events.js';
import { SettlementService } from '../settlement.js';
import { LIVE_STATUSES, loadOrder, loadOrders, orderView, remainingOf, requirementFor, type OrderRow } from '../orders.js';
import { audit } from '../audit.js';
import { fillViewFor, tradeView, type FillRow } from '../fills.js';

const BOOK_DEPTH = 20;

/** Serialises all work for one pair: matching, cancels and expiries never interleave. */
class PairWorker {
  readonly book = new OrderBook();
  /** Rows of orders resting in the book. */
  readonly resting = new Map<string, OrderRow>();
  private tail: Promise<unknown> = Promise.resolve();

  constructor(readonly pair: string) {}

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => {});
    return next;
  }
}

export interface MatchSummary {
  fills: string[];
}

/**
 * Runs one in-process matching worker per currency pair and turns matches into
 * fills: holds (in no_block mode), persistence, settlement, hold maintenance,
 * events and customer notifications.
 */
export class Exchange {
  private readonly workers = new Map<string, PairWorker>();

  constructor(
    private readonly db: Db,
    private readonly core: CoreBankingAdapter,
    private readonly config: ConfigService,
    private readonly settlement: SettlementService,
    private readonly events: EventBus,
    private readonly log: FastifyBaseLogger,
  ) {}

  private worker(pair: string) {
    let w = this.workers.get(pair);
    if (!w) {
      w = new PairWorker(pair);
      this.workers.set(pair, w);
    }
    return w;
  }

  /**
   * Recovers state after a restart: orders interrupted during entry are rejected,
   * pending settlements are finished, and live orders are replayed in arrival order
   * (so anything that should have matched does).
   */
  async start() {
    const interrupted = await loadOrders(this.db, `o.status = 'NEW'`, []);
    for (const o of interrupted) {
      await this.db.query(`update orders set status = 'REJECTED', cancel_reason = 'ENTRY_INTERRUPTED', updated_at = now() where id = $1`, [o.id]);
      if (o.hold_id) await this.releaseHold(o.hold_id);
    }
    await this.settlement.resumePending();
    const live = await loadOrders(this.db, `o.status = any($1) order by o.seq`, [LIVE_STATUSES]);
    for (const o of live) await this.submit(o.id);
  }

  /** Matches a newly accepted order and rests what is left. */
  submit(orderId: string, pair?: string): Promise<MatchSummary> {
    return (async () => {
      const p = pair ?? (await loadOrder(this.db, orderId))?.pair;
      if (!p) throw new Error(`order ${orderId} not found`);
      return this.worker(p).run(() => this.process(this.worker(p), orderId));
    })();
  }

  /** Cancels (or expires) a live or queued order and releases its hold. Returns the updated row. */
  async cancel(orderId: string, reason: 'USER' | 'EXPIRED'): Promise<OrderRow | undefined> {
    const row = await loadOrder(this.db, orderId);
    if (!row) return undefined;
    const w = this.worker(row.pair);
    return w.run(async () => {
      const current = await loadOrder(this.db, orderId);
      if (!current || !['OPEN', 'PARTIAL', 'QUEUED'].includes(current.status)) return current;
      w.book.remove(orderId);
      w.resting.delete(orderId);
      const updated = await this.closeOrder(current, reason === 'EXPIRED' ? 'EXPIRED' : 'CANCELLED', reason);
      await this.publishBook(w);
      return updated;
    });
  }

  depth(pair: string) {
    const w = this.workers.get(pair);
    const cfg = findPair(this.config.get().data, pair);
    const decimals = cfg?.baseDecimals ?? 2;
    const view = (side: Side) =>
      (w?.book.depth(side, BOOK_DEPTH) ?? []).map((l) => ({ price: formatPrice(l.price), qty: formatDecimal(l.qty, decimals), count: l.count }));
    return { pair, bids: view('BUY'), asks: view('SELL') };
  }

  /** Waits for all queued work on every pair (tests, shutdown). */
  async idle() {
    await Promise.all([...this.workers.values()].map((w) => w.run(async () => {})));
  }

  // ---- matching ----

  private async process(w: PairWorker, orderId: string): Promise<MatchSummary> {
    const taker = await loadOrder(this.db, orderId);
    if (!taker || !LIVE_STATUSES.includes(taker.status) || w.book.has(orderId)) return { fills: [] };

    const takerBook: BookOrder = {
      id: taker.id,
      ownerId: taker.customer_id,
      side: taker.side,
      price: parsePrice(taker.book_price),
      remaining: remainingOf(taker),
      seq: taker.seq,
    };
    const fills: string[] = [];
    let current = taker;

    const result = await matchIncoming(w.book, takerBook, async (c) => {
      const maker = w.resting.get(c.maker.id)!;
      const outcome = await this.tryFill(w, current, maker, c);
      if (outcome.action === 'filled') {
        fills.push(outcome.fillId);
        current = outcome.taker;
        const updatedMaker = outcome.maker;
        if (updatedMaker.status === 'FILLED') w.resting.delete(maker.id);
        else w.resting.set(maker.id, updatedMaker);
        return { action: 'filled' };
      }
      if (outcome.action === 'cancelMaker') {
        w.resting.delete(maker.id);
        await this.closeOrder(maker, 'CANCELLED', outcome.reason);
      }
      return outcome;
    });

    if (result.takerCancelled) {
      current = (await loadOrder(this.db, orderId))!;
      await this.closeOrder(current, 'CANCELLED', result.takerCancelled);
    } else if (result.rested) {
      w.resting.set(orderId, current);
    }
    await this.publishBook(w);
    return { fills };
  }

  /**
   * Executes one candidate match. In no_block mode it first places holds on both
   * sides; an order whose hold fails is cancelled with INSUFFICIENT_BALANCE.
   */
  private async tryFill(
    w: PairWorker,
    taker: OrderRow,
    maker: OrderRow,
    c: MatchCandidate,
  ): Promise<
    | { action: 'filled'; fillId: string; taker: OrderRow; maker: OrderRow }
    | Exclude<MatchDecision, { action: 'filled' }>
  > {
    const buy = taker.side === 'BUY' ? taker : maker;
    const sell = taker.side === 'SELL' ? taker : maker;
    const buyer = priceSide(c.qty, c.price, fromSnapshot(buy.pricing));
    const seller = priceSide(c.qty, c.price, fromSnapshot(sell.pricing));

    // Holds for this fill: the order's own hold in block mode, a fresh one in no_block mode.
    const placed: string[] = [];
    const holdFor = async (o: OrderRow, accountId: string, amount: bigint) => {
      if (o.balance_mode === 'block') return o.hold_id ? [o.hold_id] : [];
      const { holdId } = await this.core.placeHold(accountId, amount, `order:${o.id}`);
      placed.push(holdId);
      return [holdId];
    };
    let sellHolds: string[];
    let buyHolds: string[];
    // Taker first: if the incoming order is short, it is the one cancelled and matching stops.
    const first = taker.side === 'SELL' ? 'sell' : 'buy';
    let stage: 'sell' | 'buy' = first;
    try {
      if (first === 'sell') {
        sellHolds = await holdFor(sell, sell.fx_account_id, c.qty);
        stage = 'buy';
        buyHolds = await holdFor(buy, buy.try_account_id, buyer.total);
      } else {
        buyHolds = await holdFor(buy, buy.try_account_id, buyer.total);
        stage = 'sell';
        sellHolds = await holdFor(sell, sell.fx_account_id, c.qty);
      }
    } catch (err) {
      for (const h of placed) await this.releaseHold(h);
      const short = stage === 'sell' ? sell : buy;
      const reason = err instanceof CoreBankingError && err.code === 'INSUFFICIENT_FUNDS' ? 'INSUFFICIENT_BALANCE' : 'CORE_UNAVAILABLE';
      if (reason === 'CORE_UNAVAILABLE') this.log.error({ err, orderId: short.id }, 'hold failed at match time');
      return short.id === taker.id ? { action: 'cancelTaker', reason } : { action: 'cancelMaker', reason };
    }

    const cfg = this.config.get();
    const { fillId, fill, updated } = await tx(this.db, async (client) => {
      const { rows } = await client.query(
        `insert into fills (pair, maker_order_id, taker_order_id, buy_order_id, sell_order_id, book_price, qty, notional,
           buyer_effective_price, seller_effective_price, buyer_commission, seller_commission, buyer_tax, seller_tax,
           buyer_total, seller_total, config_version)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning *`,
        [
          w.pair, maker.id, taker.id, buy.id, sell.id, formatPrice(c.price, 8), c.qty, buyer.notional,
          formatPrice(buyer.effectivePrice, 8), formatPrice(seller.effectivePrice, 8),
          buyer.commission, seller.commission, buyer.tax, seller.tax, buyer.total, seller.total, cfg.version,
        ],
      );
      const fill = rows[0] as FillRow;
      const updated: Record<string, OrderRow> = {};
      for (const o of [taker, maker]) {
        await client.query(
          `update orders set filled_qty = filled_qty + $2,
             status = case when filled_qty + $2 = qty then 'FILLED' else 'PARTIAL' end, updated_at = now()
           where id = $1`,
          [o.id, c.qty],
        );
        updated[o.id] = (await loadOrder(client, o.id))!;
      }
      for (const [leg, holds] of [['BANK_BUY', sellHolds], ['BANK_SELL', buyHolds]] as const) {
        await client.query(
          `insert into settlements (fill_id, leg, idempotency_key, hold_ids, status) values ($1, $2, $3, $4, 'PENDING')`,
          [fill.id, leg, SettlementService.idempotencyKey(fill.id, leg), holds],
        );
      }
      await audit(client, 'system', 'fill', { fillId: fill.id, pair: w.pair, buy: buy.id, sell: sell.id, qty: c.qty, price: formatPrice(c.price) });
      return { fillId: fill.id as string, fill, updated };
    });

    await this.settlement.settle(fillId);

    // Hold maintenance after settlement captured the fill amounts.
    for (const h of placed) await this.releaseHold(h);
    for (const o of Object.values(updated)) {
      if (o.balance_mode !== 'block' || !o.hold_id) continue;
      if (o.status === 'FILLED') await this.releaseHold(o.hold_id);
      else if (o.side === 'BUY') await this.adjustHold(o.hold_id, requirementFor(o, remainingOf(o)));
    }

    await this.announceFill(fill, updated[buy.id], updated[sell.id]);
    return { action: 'filled', fillId, taker: updated[taker.id], maker: updated[maker.id] };
  }

  // ---- helpers ----

  private async closeOrder(o: OrderRow, status: 'CANCELLED' | 'EXPIRED', reason: string): Promise<OrderRow> {
    await this.db.query(`update orders set status = $2, cancel_reason = $3, updated_at = now() where id = $1`, [o.id, status, reason]);
    if (o.hold_id) await this.releaseHold(o.hold_id);
    await audit(this.db, 'system', `order.${status.toLowerCase()}`, { orderId: o.id, reason });
    const updated = (await loadOrder(this.db, o.id))!;
    await this.publishOrder(updated);
    const title = status === 'EXPIRED' ? 'Emrinizin süresi doldu' : 'Emriniz iptal edildi';
    const why: Record<string, string> = {
      USER: 'İsteğiniz üzerine iptal edildi.',
      EXPIRED: 'Geçerlilik süresi sona erdi.',
      SELF_MATCH: 'Kendi emrinizle eşleşeceği için iptal edildi.',
      INSUFFICIENT_BALANCE: 'Eşleşme anında bakiyeniz yetersiz olduğu için iptal edildi.',
      CORE_UNAVAILABLE: 'Bankacılık sistemine ulaşılamadığı için iptal edildi.',
    };
    await this.notify(o.customer_ref, { type: `order.${status.toLowerCase()}`, title, body: why[reason] ?? reason, data: { orderId: o.id } });
    return updated;
  }

  private async announceFill(fill: FillRow, buy: OrderRow, sell: OrderRow) {
    const config = this.config.get().data;
    await this.events.publish({ type: 'trade', pair: fill.pair, trade: tradeView(fill, config) });
    for (const o of [buy, sell]) {
      await this.publishOrder(o);
      const view = fillViewFor(fill, o.side, config);
      await this.events.publish({ type: 'fill', customerId: o.customer_id, fill: view });
      await this.notify(o.customer_ref, {
        type: 'fill',
        title: o.side === 'BUY' ? 'Döviz alış emriniz gerçekleşti' : 'Döviz satış emriniz gerçekleşti',
        body: `${view.qty} ${fill.pair.slice(0, 3)} @ ${view.effectivePrice}`,
        data: { fillId: fill.id, orderId: o.id },
      });
    }
  }

  private async publishOrder(o: OrderRow) {
    await this.events.publish({ type: 'order', customerId: o.customer_id, order: orderView(o, this.config.get().data) });
  }

  private async publishBook(w: PairWorker) {
    await this.events.publish({ type: 'book', ...this.depth(w.pair) });
  }

  private async notify(customerRef: string, event: { type: string; title: string; body: string; data?: unknown }) {
    await this.core.notify(customerRef, event).catch((err) => this.log.warn({ err }, 'notify failed'));
  }

  private async releaseHold(holdId: string) {
    await this.core.releaseHold(holdId).catch((err) => this.log.warn({ err, holdId }, 'release hold failed'));
  }

  private async adjustHold(holdId: string, amount: bigint) {
    await this.core.adjustHold(holdId, amount).catch((err) => this.log.warn({ err, holdId }, 'adjust hold failed'));
  }
}
