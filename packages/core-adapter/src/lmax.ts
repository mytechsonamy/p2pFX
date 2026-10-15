import { createHash, randomBytes } from 'node:crypto';
import { divRound, formatDecimal, parseDecimal } from '@p2p/shared';
import { FixSession, fixTime, fromFixTime, type FixMessage, type FixSessionOptions } from './fix.js';
import {
  LiquidityError,
  LiquidityOutcomeUnknownError,
  type FindExecutionOptions,
  type LiquidityAdapter,
  type LpExecution,
  type LpExecutionRequest,
  type LpQuote,
} from './liquidity.js';

/** An LMAX order book: its id, the base units in one contract, the smallest order (contracts) and the price tick. */
export interface LmaxInstrument {
  id: string;
  /** Base units per contract (10 000 for FX, 10 ounces for gold, 500 for silver). */
  contract: string;
  /** Smallest order, in contracts; orders are taken as multiples of it. */
  minQty: string;
  tick: string;
}

/** LMAX Global order books (from LMAX-Instruments.csv) for the pairs the bank prices and hedges. */
export const LMAX_INSTRUMENTS: Record<string, LmaxInstrument> = {
  USDTRY: { id: '100541', contract: '10000', minQty: '0.1', tick: '0.00001' },
  EURTRY: { id: '100537', contract: '10000', minQty: '0.1', tick: '0.00001' },
  GBPTRY: { id: '100539', contract: '10000', minQty: '0.1', tick: '0.00001' },
  EURUSD: { id: '4001', contract: '10000', minQty: '0.1', tick: '0.00001' },
  GBPUSD: { id: '4002', contract: '10000', minQty: '0.1', tick: '0.00001' },
  USDJPY: { id: '4004', contract: '10000', minQty: '0.1', tick: '0.001' },
  AUDUSD: { id: '4007', contract: '10000', minQty: '0.1', tick: '0.00001' },
  USDCHF: { id: '4010', contract: '10000', minQty: '0.1', tick: '0.00001' },
  USDCAD: { id: '4013', contract: '10000', minQty: '0.1', tick: '0.00001' },
  XAUUSD: { id: '100637', contract: '10', minQty: '0.1', tick: '0.01' },
  XAGUSD: { id: '100639', contract: '500', minQty: '0.1', tick: '0.001' },
};

type SessionEndpoint = Pick<FixSessionOptions, 'host' | 'port'> & { targetCompId: string };

export interface LmaxOptions {
  username: string;
  password: string;
  /** LP name the quotes and trades carry. */
  name?: string;
  marketData?: SessionEndpoint;
  trading?: SessionEndpoint;
  /** Pairs to price and trade (keys of `instruments`). */
  pairs: string[];
  instruments?: Record<string, LmaxInstrument>;
  /** TLS to LMAX; false for a plain TCP test server. */
  tls?: boolean;
  heartbeatSec?: number;
  reconnectMs?: number;
  /** How long to wait for an order's final execution report before its outcome is unknown. */
  fillTimeoutMs?: number;
  /** How long a lookup (order status, trade history) may take before it fails. */
  lookupTimeoutMs?: number;
  /** How far back a lookup without the original request searches the trade history. */
  historyDays?: number;
  log?: FixSessionOptions['log'];
}

/** LMAX demo FIX gateways (production hosts come from LMAX onboarding). */
export const LMAX_DEMO = {
  marketData: { host: 'fix-marketdata.london-demo.lmax.com', port: 443, targetCompId: 'LMXBDM' },
  trading: { host: 'fix-order.london-demo.lmax.com', port: 443, targetCompId: 'LMXBD' },
};

const dec8 = (v: string) => parseDecimal(v, 8);

/** The ClOrdID for a bank reference: LMAX allows 20 characters, the bank's references are longer. Deterministic, so a
 * lookup after a restart finds the order. */
export function lmaxClOrdId(ref: string): string {
  return createHash('sha256').update(ref).digest('base64url').slice(0, 20);
}

type Waiter = (msg: FixMessage) => void;

/**
 * LMAX Global over FIX 4.4 as one LP: a market data session streams top-of-book prices for the configured order books,
 * a trading session sends Fill-or-Kill orders and reads their execution reports. With a limit rate the order is a
 * FOK limit at that rate (LMAX enforces the worst price itself); without one, a FOK market order. A clip is all or
 * nothing: filled, definitely not filled (rejected, or cancelled with nothing done), or unknown. Every failure after an
 * order was written to the session is an unknown outcome; nothing is ever sent twice under one reference.
 */
export class LmaxLiquidity implements LiquidityAdapter {
  readonly name: string;
  private readonly instrumentsByPair: Record<string, LmaxInstrument>;
  private readonly pairById = new Map<string, string>();
  private readonly md: FixSession;
  private readonly trading: FixSession;
  private readonly prices = new Map<string, LpQuote>();
  private readonly waiters = new Map<string, Set<Waiter>>();
  private readonly tradeRequests = new Map<string, Waiter>();
  private readonly sent = new Set<string>();
  private orderSeqs = new Map<number, string>();
  private mdReq = 0;

  constructor(private readonly opts: LmaxOptions) {
    this.name = opts.name ?? 'LMAX';
    const all = opts.instruments ?? LMAX_INSTRUMENTS;
    this.instrumentsByPair = Object.fromEntries(opts.pairs.filter((p) => all[p]).map((p) => [p, all[p]!]));
    for (const [pair, i] of Object.entries(this.instrumentsByPair)) this.pairById.set(i.id, pair);
    const session = (ep: SessionEndpoint) =>
      new FixSession({
        host: ep.host,
        port: ep.port,
        targetCompId: ep.targetCompId,
        senderCompId: opts.username,
        username: opts.username,
        password: opts.password,
        heartbeatSec: opts.heartbeatSec,
        reconnectMs: opts.reconnectMs,
        tls: opts.tls,
        log: opts.log,
      });
    this.md = session(opts.marketData ?? LMAX_DEMO.marketData);
    this.trading = session(opts.trading ?? LMAX_DEMO.trading);
    this.md.on('logon', () => this.subscribe());
    // No stale prices: a dropped market data session takes LMAX's quotes away until it is back.
    this.md.on('logout', () => this.prices.clear());
    this.md.on('message', (m: FixMessage) => this.onMarketData(m));
    this.trading.on('message', (m: FixMessage) => this.onTrading(m));
    // Orders in flight when the trading session drops: their outcome is unknown.
    this.trading.on('logout', () => {
      for (const [id, set] of this.waiters) for (const w of set) w(disconnected(id));
    });
  }

  start() {
    this.md.start();
    this.trading.start();
  }

  stop() {
    this.md.stop();
    this.trading.stop();
  }

  /** Whether both sessions are logged on (readiness, tests). */
  get connected() {
    return this.md.loggedOn && this.trading.loggedOn;
  }

  private subscribe() {
    const ids = Object.values(this.instrumentsByPair).map((i) => i.id);
    if (!ids.length) return;
    this.md.send('V', [
      [262, `p2pfx-${++this.mdReq}`],
      [263, 1],
      [264, 1],
      [265, 0],
      [267, 2],
      [269, 0],
      [269, 1],
      [146, ids.length],
      ...ids.flatMap((id) => [[48, id], [22, 8]] as [number, string | number][]),
    ]);
  }

  private onMarketData(m: FixMessage) {
    if (m.type === 'Y') {
      this.opts.log?.warn({ reqId: m.get(262), reason: m.get(281), text: m.get(58) }, 'LMAX market data request rejected');
      return;
    }
    if (m.type !== 'W') return;
    const pair = this.pairById.get(m.get(48) ?? '');
    if (!pair) return;
    let bid: string | undefined;
    let ask: string | undefined;
    let date: string | undefined;
    let time: string | undefined;
    let side: string | undefined;
    for (const [tag, value] of m.fields) {
      if (tag === 269) side = value;
      else if (tag === 270 && side === '0' && bid === undefined) bid = value;
      else if (tag === 270 && side === '1' && ask === undefined) ask = value;
      else if (tag === 272) date ??= value;
      else if (tag === 273) time ??= value;
    }
    // A side without a price (an empty book side) is no tradable quote.
    if (!bid || !ask) {
      this.prices.delete(pair);
      return;
    }
    const at = fromFixTime(date, time) ?? fromFixTime(m.get(52)) ?? new Date().toISOString();
    this.prices.set(pair, { lp: this.name, pair, bid, ask, at });
  }

  private onTrading(m: FixMessage) {
    if (m.type === '8') {
      const id = m.get(11);
      for (const w of [...(id ? this.waiters.get(id) ?? [] : [])]) w(m);
      return;
    }
    if (m.type === '3') {
      // A session-level reject of an order: the order was never processed.
      const id = this.orderSeqs.get(Number(m.get(45)));
      if (id) for (const w of [...(this.waiters.get(id) ?? [])]) w(m);
      return;
    }
    if (m.type === 'AQ' || m.type === 'AE') {
      const w = this.tradeRequests.get(m.get(568) ?? '');
      w?.(m);
    }
  }

  private wait(clOrdId: string, onMessage: (m: FixMessage) => boolean, timeoutMs: number, onTimeout: () => Error) {
    return new Promise<FixMessage>((resolve, reject) => {
      const set = this.waiters.get(clOrdId) ?? new Set<Waiter>();
      this.waiters.set(clOrdId, set);
      const done = () => {
        clearTimeout(timer);
        set.delete(waiter);
        if (!set.size) this.waiters.delete(clOrdId);
      };
      const waiter: Waiter = (m) => {
        if (m.type === 'disconnected') {
          done();
          return reject(new LiquidityOutcomeUnknownError(`LMAX trading session dropped before ${clOrdId} was confirmed`));
        }
        if (!onMessage(m)) return;
        done();
        resolve(m);
      };
      const timer = setTimeout(() => {
        done();
        reject(onTimeout());
      }, timeoutMs);
      set.add(waiter);
    });
  }

  async instruments() {
    return Object.keys(this.instrumentsByPair);
  }

  async quotes(pair: string): Promise<LpQuote[]> {
    const q = this.prices.get(pair);
    if (!q) throw new LiquidityError(`LMAX has no price for ${pair}`);
    return [q];
  }

  /** Contracts for a base quantity, or a rejection when it is not a whole number of the smallest order. */
  private contracts(pair: string, qty: string) {
    const inst = this.instrumentsByPair[pair];
    if (!inst) throw new LiquidityError(`LMAX does not trade ${pair}`);
    const units = dec8(qty);
    const step = (dec8(inst.contract) * dec8(inst.minQty)) / 10n ** 8n;
    if (units <= 0n || units % step !== 0n) {
      throw new LiquidityError(`LMAX trades ${pair} in steps of ${formatDecimal(step, 8, 0)}; ${qty} is not one`);
    }
    return { inst, contracts: formatDecimal((units * 10n ** 8n) / dec8(inst.contract), 8, 0) };
  }

  async execute(req: LpExecutionRequest): Promise<LpExecution> {
    if (req.lp !== this.name) throw new LiquidityError(`unknown LP ${req.lp}`);
    const { inst, contracts } = this.contracts(req.pair, req.qty);
    const clOrdId = lmaxClOrdId(req.ref);
    // A reference this process already sent is never sent again: it is filled, or its outcome is still open.
    if (this.sent.has(clOrdId)) {
      const done = await this.findExecution(req.lp, req.ref, req);
      if (done) return done;
      throw new LiquidityOutcomeUnknownError(`LMAX order for ${req.ref} was already sent and is not confirmed filled`);
    }
    if (!this.trading.loggedOn) throw new LiquidityError('LMAX trading session is not connected');
    const fields: [number, string | number][] = [[11, clOrdId], [48, inst.id], [22, 8], [54, req.side === 'BUY' ? 1 : 2], [60, fixTime(new Date())], [38, contracts]];
    if (req.limitRate) {
      // The worst price the bank accepts, on LMAX's tick, never looser: down for a buy, up for a sell.
      const tick = dec8(inst.tick);
      const limit = divRound(dec8(req.limitRate), tick, req.side === 'BUY' ? 'DOWN' : 'UP') * tick;
      fields.push([40, 2], [44, formatDecimal(limit, 8, 0)]);
    } else {
      fields.push([40, 1]);
    }
    fields.push([59, 4]);
    const final = this.wait(
      clOrdId,
      (m) => m.type === '3' || ['2', '4', '8'].includes(m.get(39) ?? ''),
      this.opts.fillTimeoutMs ?? 5000,
      () => new LiquidityOutcomeUnknownError(`LMAX order ${clOrdId} not confirmed in time`),
    );
    const seq = this.trading.send('D', fields);
    if (seq === false) {
      final.catch(() => {});
      throw new LiquidityError('LMAX trading session is not connected');
    }
    this.sent.add(clOrdId);
    this.orderSeqs.set(seq, clOrdId);
    let m: FixMessage;
    try {
      m = await final;
    } finally {
      this.orderSeqs.delete(seq);
    }
    if (m.type === '3') throw new LiquidityError(`LMAX rejected the order message: ${m.get(58) ?? 'invalid'}`);
    const status = m.get(39);
    if (status === '2') return this.toExecution(req, m);
    const filled = dec8(m.get(14) ?? '0');
    if (status === '4' && filled > 0n) {
      throw new LiquidityOutcomeUnknownError(`LMAX order ${clOrdId} was cancelled after a partial fill of ${m.get(14)}`);
    }
    throw new LiquidityError(`LMAX ${status === '8' ? 'rejected' : 'did not fill'} order ${clOrdId}: ${m.get(58) ?? ''}`.trim());
  }

  private toExecution(req: Pick<LpExecutionRequest, 'lp' | 'ref'> & Partial<LpExecutionRequest>, m: FixMessage): LpExecution {
    const pair = req.pair ?? this.pairById.get(m.get(48) ?? '') ?? '';
    const inst = this.instrumentsByPair[pair];
    const contracts = m.get(14) ?? m.get(32) ?? m.get(38) ?? '0';
    return {
      lp: req.lp,
      ref: req.ref,
      pair,
      side: req.side ?? (m.get(54) === '2' ? 'SELL' : 'BUY'),
      qty: req.qty ?? (inst ? formatDecimal((dec8(contracts) * dec8(inst.contract)) / 10n ** 8n, 8, 0) : contracts),
      rate: m.get(6) && m.get(6) !== '0' ? m.get(6)! : m.get(31) ?? '0',
      tradeRef: `LMAX-${m.get(37) ?? m.get(17)}`,
      at: fromFixTime(m.get(60)) ?? new Date().toISOString(),
    };
  }

  /**
   * The fill for the bank's reference. With the original request the order's status is asked for (OrderStatusRequest);
   * without it the trade history of the last `historyDays` is searched. A lookup that cannot complete fails, so the
   * trade stays open; "not found" means LMAX shows no fill for the order.
   */
  async findExecution(lp: string, ref: string, request?: Omit<LpExecutionRequest, 'lp' | 'ref'>, _options?: FindExecutionOptions) {
    if (lp !== this.name) return undefined;
    if (!this.trading.loggedOn) throw new LiquidityError('LMAX trading session is not connected; the lookup cannot run');
    const clOrdId = lmaxClOrdId(ref);
    const inst = request && this.instrumentsByPair[request.pair];
    if (request && inst) {
      const statusId = randomBytes(7).toString('hex').replace(/^0+/, '1');
      const answer = this.wait(
        clOrdId,
        (m) => m.type === '8' && (m.get(790) === statusId || m.get(150) === 'I'),
        this.opts.lookupTimeoutMs ?? 5000,
        () => new LiquidityError(`LMAX did not answer the status request for ${clOrdId}`),
      );
      if (this.trading.send('H', [[11, clOrdId], [790, statusId], [48, inst.id], [22, 8], [54, request.side === 'BUY' ? 1 : 2]]) === false) {
        answer.catch(() => {});
        throw new LiquidityError('LMAX trading session is not connected; the lookup cannot run');
      }
      const m = await answer;
      return m.get(39) === '2' ? this.toExecution({ lp, ref, ...request }, m) : undefined;
    }
    return this.fromHistory(lp, ref, clOrdId);
  }

  /** Searches the trade history for fills of the order; their quantities add up, the price is their average. */
  private fromHistory(lp: string, ref: string, clOrdId: string) {
    const reqId = randomBytes(8).toString('hex');
    const days = this.opts.historyDays ?? 7;
    const now = new Date();
    return new Promise<LpExecution | undefined>((resolve, reject) => {
      const fills: FixMessage[] = [];
      const timer = setTimeout(() => {
        this.tradeRequests.delete(reqId);
        reject(new LiquidityError(`LMAX trade history for ${clOrdId} did not arrive in time`));
      }, this.opts.lookupTimeoutMs ?? 5000);
      const finish = () => {
        clearTimeout(timer);
        this.tradeRequests.delete(reqId);
        const mine = fills.filter((f) => f.get(11) === clOrdId);
        if (!mine.length) return resolve(undefined);
        const qty = mine.reduce((s, f) => s + dec8(f.get(32) ?? '0'), 0n);
        const value = mine.reduce((s, f) => s + dec8(f.get(32) ?? '0') * dec8(f.get(31) ?? '0'), 0n);
        const first = mine[0]!;
        const pair = this.pairById.get(first.get(48) ?? '') ?? '';
        const inst = this.instrumentsByPair[pair];
        resolve({
          lp,
          ref,
          pair,
          side: first.get(54) === '2' ? 'SELL' : 'BUY',
          qty: inst ? formatDecimal((qty * dec8(inst.contract)) / 10n ** 8n, 8, 0) : formatDecimal(qty, 8, 0),
          rate: formatDecimal(qty ? value / qty : 0n, 8, 0),
          tradeRef: `LMAX-${first.get(37) ?? first.get(17)}`,
          at: fromFixTime(first.get(60)) ?? now.toISOString(),
        });
      };
      this.tradeRequests.set(reqId, (m) => {
        if (m.type === 'AQ') {
          if (m.get(750) === '2') {
            clearTimeout(timer);
            this.tradeRequests.delete(reqId);
            return reject(new LiquidityError(`LMAX refused the trade history request: ${m.get(58) ?? ''}`));
          }
          if (m.get(748) === '0') finish();
          return;
        }
        fills.push(m);
        if (m.get(912) === 'Y') finish();
      });
      const sent = this.trading.send('AD', [
        [568, reqId],
        [569, 1],
        [263, 0],
        [580, 2],
        [60, fixTime(new Date(now.getTime() - days * 86_400_000))],
        [60, fixTime(now)],
      ]);
      if (sent === false) {
        clearTimeout(timer);
        this.tradeRequests.delete(reqId);
        reject(new LiquidityError('LMAX trading session is not connected; the lookup cannot run'));
      }
    });
  }
}

/** The pseudo-message a waiter gets when the trading session drops. */
function disconnected(clOrdId: string): FixMessage {
  return { type: 'disconnected', fields: [[11, clOrdId]], get: (t) => (t === 11 ? clOrdId : undefined) };
}
