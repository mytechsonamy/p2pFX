// Fixes for the general code and architecture review of PR #8 (G01–G05), on PostgreSQL with the production services.
import { afterEach, describe, expect, it } from 'vitest';
import { LiquidityError, type LpExecutionRequest } from '@p2p/core-adapter';
import { DEFAULT_CONFIG, parsePrice, type BankConfig } from '@p2p/shared';
import { BankAccount } from '../src/dealing/bank-book.js';
import { startHarness, units, type Harness } from './helpers.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
  h = undefined as unknown as Harness;
});

const base = (patch: (c: BankConfig) => void = () => {}) => {
  const c = structuredClone(DEFAULT_CONFIG);
  c.bankBook.pairs = { USDTRY: c.bankBook.pairs.USDTRY };
  patch(c);
  return c;
};

async function start(config = base()) {
  h = await startHarness({ config });
  h.customer('bank-desk', { USD: '1000000', TRY: '100000000' });
  await h.ctx.prices.refreshAll();
}

const position = () => h.ctx.positions.current('USDTRY');
const liveBot = async () =>
  (await h.ctx.db.query(`select strategy_id, count(*)::int as n from orders where source = 'BOT_MM' and status in ('OPEN', 'PARTIAL') group by 1 order by 1`)).rows;

describe('G01: a hedge clip waiting on its LP takes part in the shared inventory reservation', () => {
  for (const outcome of ['FILLED', 'REJECTED', 'UNKNOWN'] as const) {
    it(`reserves before it is sent; the LP ${outcome.toLowerCase()} closes it accordingly`, async () => {
      await start(base((c) => {
        c.inventory.maxPosition = { USD: '1500' };
        c.dealing.autoHedge = false;
        c.dealing.hedging.maxClipQty = {};
      }));
      // The bank sells 1000 USD Direct: −1000.
      h.customer('ayse', { USD: '0', TRY: '100000' });
      const ayse = await h.login('ayse');
      const q = (await h.req('POST', '/v1/bank/quotes', ayse, { pair: 'USDTRY', side: 'BUY', qty: '1000' })).body;
      expect((await h.req('POST', '/v1/bank/deals', ayse, { quoteId: q.id })).status).toBe(201);
      expect(position()).toBe(-units('1000'));

      // Logged in before the hedge starts: the harness waits for hedges in flight after each request.
      h.customer('veli', { USD: '5000', TRY: '0' });
      const veli = await h.login('veli');
      let enter!: () => void;
      const entered = new Promise<void>((r) => (enter = r));
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const execute = h.liquidity.execute.bind(h.liquidity);
      h.liquidity.execute = async (req: LpExecutionRequest) => {
        enter();
        await gate;
        if (outcome === 'REJECTED') throw new LiquidityError(`${req.lp} rejected the order`);
        if (outcome === 'UNKNOWN') throw new Error('LP timed out');
        return execute(req);
      };
      const pair = h.ctx.config.get().data.pairs.find((p) => p.symbol === 'USDTRY')!;
      const hedge = h.ctx.positions.hedge(pair, 'BUY', units('1000'), 'MANUAL', 'ops').catch((e) => e);
      await entered;

      // While the LP has not answered: the clip's +1000 counts for the buy side. The bank buying 2000 more (a customer
      // selling 2000 Direct) would be +2000 if the hedge fills: refused.
      expect(h.ctx.positions.bounds('USDTRY')).toEqual({ long: 0n, short: -units('1000') });
      expect(h.ctx.positions.allows('USDTRY', units('2000'))).toBe(false);
      const sell = await h.app.inject({ method: 'POST', url: '/v1/bank/quotes', headers: { authorization: `Bearer ${veli}` }, payload: { pair: 'USDTRY', side: 'SELL', qty: '2000' } });
      expect(sell.json().error).toBe('INVENTORY_LIMIT');
      // A reload in this window keeps the reservation and does not apply a read that may contain the clip.
      const reloading = h.ctx.positions.reload('USDTRY');
      expect(h.ctx.positions.reservations('USDTRY')).toEqual([units('1000')]);

      release();
      await hedge;
      await reloading;
      await h.ctx.positions.idle();
      expect(h.ctx.positions.reservations('USDTRY')).toEqual([]);
      if (outcome === 'FILLED') {
        expect(position()).toBe(0n);
        expect(h.ctx.positions.bounds('USDTRY')).toEqual({ long: 0n, short: 0n });
      } else if (outcome === 'REJECTED') {
        expect(position()).toBe(-units('1000'));
      } else {
        // Unknown: counted in the position (it may have happened), and the cap's worst case covers it not having
        // happened. Selling 600 more would be −1600 if the hedge did not happen: refused.
        expect(position()).toBe(0n);
        expect(h.ctx.positions.bounds('USDTRY')).toEqual({ long: 0n, short: -units('1000') });
        expect(h.ctx.positions.allows('USDTRY', -units('600'))).toBe(false);
        // The same after a reload from the database.
        await h.ctx.positions.reload('USDTRY');
        expect(h.ctx.positions.bounds('USDTRY')).toEqual({ long: 0n, short: -units('1000') });
      }
    });
  }

  it('a manual hedge the cap does not allow is refused before anything is written or sent', async () => {
    await start(base((c) => {
      c.inventory.maxPosition = { USD: '1500' };
      c.dealing.autoHedge = false;
    }));
    let sent = 0;
    const execute = h.liquidity.execute.bind(h.liquidity);
    h.liquidity.execute = async (req: LpExecutionRequest) => {
      sent++;
      return execute(req);
    };
    const pair = h.ctx.config.get().data.pairs.find((p) => p.symbol === 'USDTRY')!;
    await expect(h.ctx.positions.hedge(pair, 'BUY', units('2000'), 'MANUAL', 'ops')).rejects.toMatchObject({ code: 'INVENTORY_LIMIT' });
    expect(sent).toBe(0);
    expect((await h.ctx.db.query('select count(*)::int as n from hedges')).rows[0].n).toBe(0);
  });
});

describe('G02: a bot strategy that is not the configured one is withdrawn', () => {
  it('changing the strategy id withdraws the old orders; switching the bot off leaves none', async () => {
    await start();
    await h.ctx.bot.tick(true);
    expect((await liveBot()).map((r) => r.strategy_id)).toEqual(['bot-mm-1']);
    await h.setConfig((c) => ({ ...c, botMarketMaker: { ...c.botMarketMaker, strategyId: 'bot-mm-2' } }));
    await h.ctx.bot.tick(true);
    expect((await liveBot()).map((r) => r.strategy_id)).toEqual(['bot-mm-2']);
    expect(h.ctx.exchange.strategies('USDTRY', 'BOT_MM')).toEqual(['bot-mm-2']);

    // Old orders entered again behind the bot's back (a restart replaying them, say): the enforce pass takes them out.
    const config = h.ctx.config.get().data;
    const account = (await new BankAccount(h.ctx.db, h.bank).for(config, config.pairs.find((p) => p.symbol === 'USDTRY')!))!;
    await h.ctx.exchange.replaceLiquidity({
      pair: 'USDTRY', source: 'BOT_MM', strategyId: 'bot-mm-1', account, levels: [{ side: 'SELL', price: parsePrice('49.60'), qty: units('100') }],
      generationId: await h.ctx.exchange.nextGenerationId(),
    });
    await h.setConfig((c) => ({ ...c, channels: { ...c.channels, botMarketMaker: false } }));
    await h.ctx.bot.enforce();
    expect(await liveBot()).toEqual([]);
    const d = h.ctx.exchange.depth('USDTRY');
    expect([...d.asks, ...d.bids].filter((l) => l.price === '49.60')).toEqual([]);
  });
});

describe('G03: an LP switched off is out of trading at once, cache or not', () => {
  it('the cached aggregate resting on a disabled LP is not fresh any more; hedges skip that LP', async () => {
    await start(base((c) => (c.dealing.autoHedge = false)));
    const agg = h.ctx.prices.fresh('USDTRY')!;
    expect(agg).toBeDefined();
    const off = [...new Set([agg.bidLp, agg.askLp])];
    // Straight on the configuration (no refresh in between).
    await h.ctx.config.update({ ...h.ctx.config.get().data, killSwitch: { ...h.ctx.config.get().data.killSwitch, disabledLps: off } }, 'test', 'LP kapatıldı');
    const now = h.ctx.prices.fresh('USDTRY');
    if (now) {
      expect(off).not.toContain(now.bidLp);
      expect(off).not.toContain(now.askLp);
    }
    const sentTo: string[] = [];
    const execute = h.liquidity.execute.bind(h.liquidity);
    h.liquidity.execute = async (req: LpExecutionRequest) => {
      sentTo.push(req.lp);
      return execute(req);
    };
    const pair = h.ctx.config.get().data.pairs.find((p) => p.symbol === 'USDTRY')!;
    await h.ctx.positions.hedge(pair, 'BUY', units('100'), 'MANUAL', 'ops');
    expect(sentTo.length).toBeGreaterThan(0);
    expect(sentTo.filter((lp) => off.includes(lp))).toEqual([]);
  });
});

describe('G04: matching stops writing the moment leadership is lost', () => {
  it('a command queued before the loss never runs', async () => {
    await start();
    h.customer('ali', { USD: '1000', TRY: '0' });
    const ex = h.ctx.exchange as unknown as { worker: (p: string) => { run: (fn: () => Promise<unknown>) => Promise<unknown> }; active: boolean; process: (...a: unknown[]) => Promise<unknown> };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    void ex.worker('USDTRY').run(() => gate);
    const { rows } = await h.ctx.db.query(
      `insert into orders (customer_id, principal_id, source, order_type, pair, side, book_price, qty, validity, expires_at, fx_account_id, try_account_id, status, pricing, config_version, balance_mode, notional, idempotency_key, request_hash)
       select o.customer_id, o.principal_id, 'CUSTOMER', 'LIMIT', 'USDTRY', 'SELL', 49.40, 10000, 'GTC', now() + interval '1 day', 'x', 'y', 'OPEN', '{}'::jsonb, 1, 'no_block', 0, 'g04', 'g04'
         from (select id as customer_id, principal_id from customers limit 1) o returning id`,
    ).catch(() => ({ rows: [] as { id: string }[] }));
    let processed = 0;
    const process = ex.process.bind(h.ctx.exchange);
    ex.process = async (...a: unknown[]) => {
      processed++;
      return process(...a);
    };
    const queued = h.ctx.exchange.submit(rows[0]?.id ?? '00000000-0000-0000-0000-00000000dead', 'USDTRY').catch((e) => e);
    ex.active = false;
    release();
    expect(await queued).toMatchObject({ code: 'MATCHING_UNAVAILABLE' });
    expect(processed).toBe(0);
  });

  it('after a takeover (the leadership epoch moved on) a former leader cannot commit a fill, and stops', async () => {
    await start();
    h.customer('ali', { USD: '1000', TRY: '0' });
    h.customer('veli', { USD: '0', TRY: '100000' });
    await h.place(await h.login('ali'), { side: 'SELL', qty: '100', price: '49.15' });
    // Another instance took the lock and a new epoch; this one has not noticed yet.
    await h.ctx.db.query('update matching_leader set epoch = epoch + 1 where id = 1');
    const res = await h.place(await h.login('veli'), { side: 'BUY', qty: '100', price: '49.15' });
    expect(res.status).toBe(503);
    expect((await h.ctx.db.query('select count(*)::int as n from fills')).rows[0].n).toBe(0);
    expect(h.ctx.exchange.running).toBe(false);
    // The buyer's per-fill hold was not left behind.
    const ali = await h.balance('ali', 'USD');
    expect(ali.available).toBeGreaterThan(0n);
  });
});

describe('G05: the bot refreshes on its configured interval', () => {
  it('ticks every 500 ms but enters a new generation only every refreshMs', async () => {
    await start(base((c) => (c.botMarketMaker.refreshMs = 5000)));
    let generations = 0;
    const replace = h.ctx.exchange.replaceLiquidity.bind(h.ctx.exchange);
    h.ctx.exchange.replaceLiquidity = async (cmd) => {
      if (cmd.source === 'BOT_MM') generations++;
      return replace(cmd);
    };
    await h.ctx.bot.tick();
    for (let i = 0; i < 4; i++) {
      h.clock.now = new Date(h.clock.now.getTime() + 500);
      await h.ctx.bot.tick();
    }
    expect(generations).toBe(1);
    h.clock.now = new Date(h.clock.now.getTime() + 3000);
    await h.ctx.prices.refreshAll();
    await h.ctx.bot.tick();
    expect(generations).toBe(2);
  });
});

describe('architecture follow-ups', () => {
  it('a configuration stored by another instance meanwhile is not overwritten (atomic version check)', async () => {
    await start();
    // Another instance stores a version this one has not heard about yet.
    await h.ctx.db.query(`insert into config (data, created_by, reason, diff) select data, 'other', 'başka sunucu', '[]' from config order by version desc limit 1`);
    const res = await h.req('PUT', '/ops/config', 'ops-secret', { config: { ...h.ctx.config.get().data, balanceMode: 'no_block' }, reason: 'deneme' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('VERSION_CONFLICT');
  });

  it('an LP execution that does not match the clip (partial quantity) is left open for reconciliation, not taken as done', async () => {
    await start(base((c) => (c.dealing.autoHedge = false)));
    const execute = h.liquidity.execute.bind(h.liquidity);
    h.liquidity.execute = async (req: LpExecutionRequest) => ({ ...(await execute(req)), qty: '40.00' });
    const pair = h.ctx.config.get().data.pairs.find((p) => p.symbol === 'USDTRY')!;
    const res = await h.ctx.positions.hedge(pair, 'BUY', units('100'), 'MANUAL', 'ops');
    expect(res).toMatchObject({ unknown: '100.00', clips: [] });
    expect((await h.ctx.db.query('select status from hedges')).rows).toEqual([{ status: 'UNKNOWN' }]);
  });
});
