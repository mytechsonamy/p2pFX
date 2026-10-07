// Fixes for the v1.1 code review of PR #8 (findings 1–10). Each scenario reproduces the reviewed failure through the
// API or the production services and checks the corrected behaviour.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { CoreBankingError, MockCoreBank, type FxTransactionRequest } from '@p2p/core-adapter';
import { DEFAULT_CONFIG, parsePrice, type BankConfig, type Side } from '@p2p/shared';
import { BankAccount } from '../src/dealing/bank-book.js';
import type { LiquidityLevel } from '../src/engine/exchange.js';
import { OPS, startHarness, units, type Harness } from './helpers.js';

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

async function start(opts: { config?: BankConfig; bank?: MockCoreBank } = {}) {
  if (opts.bank) opts.bank.setReferenceRate('USDTRY', '49.15');
  h = await startHarness({ config: opts.config ?? base(), bank: opts.bank });
  h.customer('bank-desk', { USD: '1000000', TRY: '100000000' });
  await h.ctx.prices.refreshAll();
}

async function bankAccount() {
  const config = h.ctx.config.get().data;
  return (await new BankAccount(h.ctx.db, h.bank).for(config, config.pairs.find((p) => p.symbol === 'USDTRY')!))!;
}

async function liquidity(source: 'BANK_MM' | 'BOT_MM', levels: [Side, string, string][]) {
  const lv: LiquidityLevel[] = levels.map(([side, price, qty]) => ({ side, price: parsePrice(price), qty: units(qty) }));
  return h.ctx.exchange.replaceLiquidity({
    pair: 'USDTRY', source, strategyId: source === 'BANK_MM' ? 'bank-ladder' : 'bot-mm-1', account: await bankAccount(), levels: lv,
    generationId: await h.ctx.exchange.nextGenerationId(),
  });
}

const legs = async () => (await h.ctx.db.query('select status from settlements order by leg')).rows.map((r) => r.status);
const position = () => h.ctx.positions.current('USDTRY');

/** Core banking whose BANK_BUY posting and its lookup can be made unavailable; the posting may still be booked. */
class UnknownBank extends MockCoreBank {
  down = true;
  bookedButLost = false;
  booked: string[] = [];
  override async postFxTransaction(r: FxTransactionRequest) {
    if (r.leg === 'BANK_BUY' && this.down) {
      if (this.bookedButLost) {
        await super.postFxTransaction(r);
        if (!this.booked.includes(r.idempotencyKey)) this.booked.push(r.idempotencyKey);
      }
      throw new CoreBankingError('UNAVAILABLE', 'response lost');
    }
    const res = await super.postFxTransaction(r);
    if (!this.booked.includes(r.idempotencyKey)) this.booked.push(r.idempotencyKey);
    return res;
  }
  override async findFxTransaction(key: string) {
    if (key.includes('BANK_BUY') && this.down) throw new CoreBankingError('UNAVAILABLE', 'lookup unavailable');
    return super.findFxTransaction(key);
  }
}

describe('1: settlement holds follow each leg, UNKNOWN keeps the funds', () => {
  for (const mode of ['block', 'no_block'] as const) {
    for (const booked of [false, true]) {
      it(`${mode}: the seller's USD stays covered while BANK_BUY is unknown (core ${booked ? 'booked' : 'did not book'} it)`, async () => {
        const bank = new UnknownBank();
        bank.bookedButLost = booked;
        await start({ bank, config: base((c) => (c.balanceMode = mode)) });
        h.customer('ali', { USD: '1000', TRY: '0' });
        h.customer('veli', { USD: '0', TRY: '100000' });
        await h.place(await h.login('ali'), { side: 'SELL', qty: '100', price: '49.15' });
        await h.place(await h.login('veli'), { side: 'BUY', qty: '100', price: '49.15' });
        expect(await legs()).toEqual(['UNKNOWN_OUTCOME', 'PENDING']);

        // Whether or not core banking took the 100 USD, Ali cannot spend them again while the outcome is unknown.
        const ali = await h.balance('ali', 'USD');
        expect(ali.available).toBe(units('900'));
        // The buyer's TRY stays held for the leg not posted yet.
        const veli = await h.balance('veli', 'TRY');
        expect(veli.balance - veli.available).toBeGreaterThan(0n);

        // The outcome becomes known: settled once, and every hold that is left goes back.
        bank.down = false;
        const fillId = (await h.ctx.db.query('select id from fills')).rows[0].id;
        expect(await h.ctx.settlement.settle(fillId)).toBe('SETTLED');
        await h.ctx.exchange.idle();
        await h.ctx.exchange.retryHoldTasks();
        expect(bank.booked.filter((k) => k.includes('BANK_BUY'))).toHaveLength(1);
        expect(await h.balance('ali', 'USD')).toEqual({ balance: units('900'), available: units('900') });
        const after = await h.balance('veli', 'TRY');
        expect(after.available).toBe(after.balance);
        expect(await h.balance('veli', 'USD')).toMatchObject({ balance: units('100') });
      });
    }
  }

  it('a leg failed and waiting for the operations retry keeps its hold; the retry posts it from that hold', async () => {
    class RefusingBank extends MockCoreBank {
      refuse = true;
      override async postFxTransaction(r: FxTransactionRequest) {
        if (r.leg === 'BANK_BUY' && this.refuse) throw new CoreBankingError('INVALID_REQUEST', 'account blocked');
        return super.postFxTransaction(r);
      }
    }
    const bank = new RefusingBank();
    await start({ bank, config: base((c) => (c.balanceMode = 'no_block')) });
    h.customer('ali', { USD: '1000', TRY: '0' });
    h.customer('veli', { USD: '0', TRY: '100000' });
    await h.place(await h.login('ali'), { side: 'SELL', qty: '100', price: '49.15' });
    await h.place(await h.login('veli'), { side: 'BUY', qty: '100', price: '49.15' });
    expect(await legs()).toEqual(['FAILED_NEEDS_REVIEW', 'FAILED_NEEDS_REVIEW']);
    expect((await h.balance('ali', 'USD')).available).toBe(units('900'));
    bank.refuse = false;
    const fillId = (await h.ctx.db.query('select id from fills')).rows[0].id;
    expect((await h.req('POST', `/ops/settlements/${fillId}/retry`, OPS)).body).toMatchObject({ outcome: 'SETTLED' });
    expect(await h.balance('ali', 'USD')).toEqual({ balance: units('900'), available: units('900') });
  });
});

describe('2–3: one atomic inventory reservation for Direct, the ladder and the bot', () => {
  it('a board fill waiting on its holds has reserved its capacity: Direct cannot take the same headroom', async () => {
    let enter!: () => void;
    const entered = new Promise<void>((r) => (enter = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    class GatedBank extends MockCoreBank {
      gated?: string;
      override async placeHold(accountId: string, amount: bigint, ref: string) {
        if (accountId === this.gated) {
          enter();
          await gate;
        }
        return super.placeHold(accountId, amount, ref);
      }
    }
    const bank = new GatedBank();
    await start({ bank, config: base((c) => (c.inventory.maxPosition = { USD: '1500' })) });
    h.customer('veli', { USD: '0', TRY: '100000' });
    h.customer('ayse', { USD: '0', TRY: '100000' });
    await liquidity('BANK_MM', [['SELL', '49.25', '1000']]);
    const ayse = await h.login('ayse');
    const veli = await h.login('veli');
    const quote = (await h.req('POST', '/v1/bank/quotes', ayse, { pair: 'USDTRY', side: 'BUY', qty: '1000' })).body;
    expect(quote.id).toBeDefined();

    // Veli's order matches the ladder; the fill now waits for the hold on the bank's USD.
    bank.gated = (await bankAccount()).fxAccountId;
    const order = h.app.inject({
      method: 'POST', url: '/v1/orders', headers: { authorization: `Bearer ${veli}`, 'idempotency-key': 'r04' },
      payload: { pair: 'USDTRY', side: 'BUY', qty: '1000', price: '49.25', validity: 'GTC' },
    });
    await entered;
    expect(h.ctx.positions.reservations('USDTRY')).toEqual([-units('1000')]);
    // Direct in that window: 1000 more would take the bank to −2000 against a 1500 cap.
    const deal = await h.app.inject({ method: 'POST', url: '/v1/bank/deals', headers: { authorization: `Bearer ${ayse}` }, payload: { quoteId: quote.id } });
    expect(deal.statusCode).toBe(422);
    expect(deal.json().error).toBe('INVENTORY_LIMIT');

    release();
    expect((await order).statusCode).toBe(201);
    await h.ctx.exchange.idle();
    await h.ctx.positions.idle();
    expect(position()).toBe(-units('1000'));
    expect(h.ctx.positions.reservations('USDTRY')).toEqual([]);
    const total = (await h.ctx.db.query('select coalesce(sum(position_delta), 0)::bigint as d from principal_executions')).rows[0].d;
    expect(BigInt(total)).toBe(-units('1000'));
  });

  it('a reload never drops an open reservation; commit and release each take effect once', async () => {
    await start({ config: base((c) => (c.inventory.maxPosition = { USD: '1500' })) });
    const p = h.ctx.positions;
    const r = p.reserve('USDTRY', -units('1000'));
    // The database still says 0 (nothing committed). Reloading must keep the reservation.
    const reload = p.reload('USDTRY');
    expect(p.current('USDTRY')).toBe(-units('1000'));
    expect(p.tryReserve('USDTRY', -units('1000'))).toBeUndefined();
    r.release();
    await reload;
    expect(p.current('USDTRY')).toBe(0n);
    r.release();
    r.commit();
    expect(p.current('USDTRY')).toBe(0n);

    const s = p.reserve('USDTRY', units('500'));
    s.commit();
    s.commit();
    s.release();
    expect(p.committedPosition('USDTRY')).toBe(units('500'));
    expect(p.reservations('USDTRY')).toEqual([]);
  });
});

describe('re-review F01–F02: pending executions never make room, a rejection leaves the position once', () => {
  it('F01: a pending bank buy waiting on its hold does not let Direct sell past the cap; its failure leaves the cap intact', async () => {
    let enter!: () => void;
    const entered = new Promise<void>((r) => (enter = r));
    let fail!: () => void;
    const gate = new Promise<void>((r) => (fail = r));
    class GatedBank extends MockCoreBank {
      gated?: string;
      override async placeHold(accountId: string, amount: bigint, ref: string) {
        if (accountId === this.gated) {
          enter();
          await gate;
          throw new CoreBankingError('INSUFFICIENT_FUNDS', 'bank TRY account short');
        }
        return super.placeHold(accountId, amount, ref);
      }
    }
    const bank = new GatedBank();
    await start({ bank, config: base((c) => (c.inventory.maxPosition = { USD: '1500' })) });
    h.customer('ali', { USD: '1000', TRY: '0' });
    h.customer('ayse', { USD: '0', TRY: '200000' });
    await liquidity('BANK_MM', [['BUY', '49.05', '1000']]);
    const ayse = await h.login('ayse');
    const ali = await h.login('ali');

    // Ali sells into the bank's bid: +1000 USD reserved, the fill waits for the hold on the bank's TRY.
    bank.gated = (await bankAccount()).tryAccountId;
    const order = h.app.inject({
      method: 'POST', url: '/v1/orders', headers: { authorization: `Bearer ${ali}`, 'idempotency-key': 'f01' },
      payload: { pair: 'USDTRY', side: 'SELL', qty: '1000', price: '49.05', validity: 'GTC' },
    });
    await entered;
    expect(h.ctx.positions.reservations('USDTRY')).toEqual([units('1000')]);
    expect(h.ctx.positions.bounds('USDTRY')).toEqual({ long: units('1000'), short: 0n });

    // Direct: the bank selling 2000 would be −2000 if the pending buy fails. Refused; 1500 fits.
    const inject = (url: string, payload: object) => h.app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${ayse}` }, payload });
    const big = await inject('/v1/bank/quotes', { pair: 'USDTRY', side: 'BUY', qty: '2000' });
    expect(big.json().error).toBe('INVENTORY_LIMIT');
    const quote = (await inject('/v1/bank/quotes', { pair: 'USDTRY', side: 'BUY', qty: '1500' })).json();
    expect((await inject('/v1/bank/deals', { quoteId: quote.id })).statusCode).toBe(201);
    expect(h.ctx.positions.bounds('USDTRY')).toEqual({ long: units('1000') - units('1500'), short: -units('1500') });
    // A further sale is refused even now, while the pending buy is still open.
    expect(h.ctx.positions.allows('USDTRY', -units('1'))).toBe(false);

    // The bank's hold fails: the board fill does not happen and its reservation goes.
    fail();
    await order;
    await h.ctx.exchange.idle();
    await h.ctx.positions.idle();
    expect(h.ctx.positions.reservations('USDTRY')).toEqual([]);
    expect(position()).toBe(-units('1500'));
    const total = (await h.ctx.db.query('select coalesce(sum(position_delta), 0)::bigint as d from principal_executions')).rows[0].d;
    expect(BigInt(total)).toBe(-units('1500'));
  });

  it('F01: headroom for the ladder counts pending buys on the buy side and pending sells on the sell side only', async () => {
    await start({ config: base((c) => (c.inventory.maxPosition = { USD: '1500' })) });
    const p = h.ctx.positions;
    const buy = p.reserve('USDTRY', units('1000'));
    const sell = p.reserve('USDTRY', -units('400'));
    expect(p.headroom('USDTRY', 'BUY')).toBe(units('500'));
    expect(p.headroom('USDTRY', 'SELL')).toBe(units('1100'));
    expect(p.tryReserve('USDTRY', -units('1101'))).toBeUndefined();
    // Releases in either order leave both sides where they started.
    buy.release();
    sell.commit();
    expect(p.bounds('USDTRY')).toEqual({ long: -units('400'), short: -units('400') });
    expect(p.headroom('USDTRY', 'SELL')).toBe(units('1100'));
  });

  it('F02: a reload landing between the REJECTED write and the memory update never takes the deal out twice', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    class RejectingBank extends MockCoreBank {
      override async postFxTransaction(_r: FxTransactionRequest): Promise<never> {
        await gate;
        throw new CoreBankingError('INSUFFICIENT_FUNDS', 'insufficient funds');
      }
    }
    await start({ bank: new RejectingBank() });
    h.customer('ayse', { USD: '0', TRY: '100000' });
    const ayse = await h.login('ayse');
    const quote = (await h.req('POST', '/v1/bank/quotes', ayse, { pair: 'USDTRY', side: 'BUY', qty: '1000' })).body;

    // Real database, real reload: right after the REJECTED update commits, a reload runs before execute continues.
    const db = h.ctx.db as unknown as { query: (...a: unknown[]) => Promise<unknown> };
    const query = db.query.bind(h.ctx.db);
    let reloads = 0;
    db.query = async (...a: unknown[]) => {
      const res = await query(...a);
      if (typeof a[0] === 'string' && a[0].includes(`set status = 'REJECTED'`)) {
        reloads++;
        await h.ctx.positions.reload('USDTRY');
      }
      return res;
    };
    const deal = h.app.inject({ method: 'POST', url: '/v1/bank/deals', headers: { authorization: `Bearer ${ayse}` }, payload: { quoteId: quote.id } });
    for (let i = 0; i < 100 && h.ctx.positions.committedPosition('USDTRY') === 0n; i++) await new Promise((r) => setTimeout(r, 10));
    expect(position()).toBe(-units('1000'));
    release();
    expect((await deal).statusCode).toBe(422);
    db.query = query;
    expect(reloads).toBe(1);
    expect(position()).toBe(0n);
    await h.ctx.positions.reload('USDTRY');
    expect(position()).toBe(0n);

    // A second settlement of the same deal (resume, retry) finds it REJECTED already and changes nothing.
    await h.ctx.dealing.resumePending();
    await h.ctx.positions.reload('USDTRY');
    expect(position()).toBe(0n);
  });
});

describe('5: a firm board fill stays in the position whatever its settlement status', () => {
  it('a fill whose settlement went to review still counts after a reload', async () => {
    class RefusingBank extends MockCoreBank {
      override async postFxTransaction(r: FxTransactionRequest) {
        if (r.leg === 'BANK_SELL') throw new CoreBankingError('INVALID_REQUEST', 'account blocked');
        return super.postFxTransaction(r);
      }
    }
    await start({ bank: new RefusingBank() });
    h.customer('veli', { USD: '0', TRY: '100000' });
    await liquidity('BANK_MM', [['SELL', '49.25', '1000']]);
    await h.place(await h.login('veli'), { side: 'BUY', qty: '1000', price: '49.25' });
    expect((await legs()).sort()).toEqual(['FAILED_NEEDS_REVIEW', 'REVERSED']);
    expect(position()).toBe(-units('1000'));
    await h.ctx.positions.reload('USDTRY');
    expect(position()).toBe(-units('1000'));
  });
});

describe('10: the upgrade backfills Direct deals still PENDING', () => {
  const backfill = () => {
    const sql = readFileSync(new URL('../../../db/migrations/006_v11_liquidity_sources.sql', import.meta.url), 'utf8');
    const start = sql.indexOf("insert into principal_executions (channel, ref_id, pair, source, bank_side, qty, price, position_delta, created_at)");
    const end = sql.indexOf(';', start);
    return sql.slice(start, end);
  };

  for (const outcome of ['SETTLED', 'REJECTED'] as const) {
    it(`a deal PENDING at the upgrade counts, and leaves the position only if core banking rejects it (${outcome})`, async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      class SlowBank extends MockCoreBank {
        override async postFxTransaction(r: FxTransactionRequest) {
          await gate;
          if (outcome === 'REJECTED') throw new CoreBankingError('INSUFFICIENT_FUNDS', 'insufficient funds');
          return super.postFxTransaction(r);
        }
      }
      await start({ bank: new SlowBank() });
      h.customer('ayse', { USD: '0', TRY: '100000' });
      const ayse = await h.login('ayse');
      const quote = (await h.req('POST', '/v1/bank/quotes', ayse, { pair: 'USDTRY', side: 'BUY', qty: '1000' })).body;
      const deal = h.app.inject({ method: 'POST', url: '/v1/bank/deals', headers: { authorization: `Bearer ${ayse}` }, payload: { quoteId: quote.id } });
      for (let i = 0; i < 100 && !(await h.ctx.db.query(`select 1 from bank_deals where status = 'PENDING'`)).rows.length; i++) await new Promise((r) => setTimeout(r, 10));

      // As before the upgrade: the PENDING deal has no execution; the migration's backfill adds it.
      await h.ctx.db.query('delete from principal_executions');
      await h.ctx.db.query(backfill());
      expect((await h.ctx.db.query('select channel, position_delta::text from principal_executions')).rows).toEqual([{ channel: 'DIRECT', position_delta: '-100000' }]);
      await h.ctx.positions.reload('USDTRY');
      expect(position()).toBe(-units('1000'));

      release();
      await deal;
      await h.ctx.positions.idle();
      await h.ctx.positions.reload('USDTRY');
      expect(position()).toBe(outcome === 'SETTLED' ? -units('1000') : 0n);
    });
  }
});

describe('4: a market order is bound to the protection price the customer confirmed', () => {
  it('refuses when the price moved against the customer, accepts the new confirmation, and is never looser', async () => {
    await start();
    h.customer('veli', { USD: '0', TRY: '200000' });
    const veli = await h.login('veli');
    await liquidity('BANK_MM', [['SELL', '49.20', '300']]);
    const shown = (await h.req('POST', '/v1/orders/quote', veli, { pair: 'USDTRY', side: 'BUY', qty: '100', type: 'MARKET' })).body.protectionPrice;
    expect(shown).toBe('49.4017');

    expect((await h.place(veli, { side: 'BUY', qty: '100', type: 'MARKET', validity: undefined })).status).toBe(400);

    // The LP moves up 0.50 after the confirmation: the protection the bank would give now is worse for the buyer.
    const quotes = h.liquidity.quotes.bind(h.liquidity);
    let shift = 0.5;
    h.liquidity.quotes = async (pair: string) =>
      (await quotes(pair)).map((q) => ({ ...q, bid: (Number(q.bid) + shift).toFixed(4), ask: (Number(q.ask) + shift).toFixed(4) }));
    await h.ctx.prices.refreshAll();
    const refused = await h.place(veli, { side: 'BUY', qty: '100', type: 'MARKET', validity: undefined, protectionPrice: shown });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: 'PROTECTION_PRICE_CHANGED' });
    expect((await h.ctx.db.query('select count(*)::int as n from orders where source = $1', ['CUSTOMER'])).rows[0].n).toBe(0);

    const renewed = (await h.req('POST', '/v1/orders/quote', veli, { pair: 'USDTRY', side: 'BUY', qty: '100', type: 'MARKET' })).body.protectionPrice;
    const ok = await h.place(veli, { side: 'BUY', qty: '100', type: 'MARKET', validity: undefined, protectionPrice: renewed });
    expect(ok.status).toBe(201);

    // Back down: the confirmed (higher) limit is not used, the better current protection is.
    shift = 0;
    await h.ctx.prices.refreshAll();
    const better = await h.place(veli, { side: 'BUY', qty: '100', type: 'MARKET', validity: undefined, protectionPrice: renewed });
    expect(better.status).toBe(201);
    const { rows } = await h.ctx.db.query('select book_price::text from orders where id = $1', [better.body.id]);
    expect(rows[0].book_price).toBe('49.40170000');
  });
});

describe('6: a generation that fails after its commit is withdrawn as a whole', () => {
  it('cancels its orders still live in the database and rebuilds the book from it', async () => {
    await start();
    const exchange = h.ctx.exchange as unknown as { process: (...a: unknown[]) => Promise<unknown> };
    const process = exchange.process.bind(h.ctx.exchange);
    let calls = 0;
    exchange.process = async (...a: unknown[]) => {
      if (++calls === 2) throw new Error('injected failure');
      return process(...a);
    };
    await expect(liquidity('BANK_MM', [['SELL', '49.25', '100'], ['SELL', '49.26', '100'], ['SELL', '49.27', '100']])).rejects.toThrow('injected failure');
    exchange.process = process;
    const live = (await h.ctx.db.query(`select count(*)::int as n from orders where source = 'BANK_MM' and status in ('OPEN', 'PARTIAL')`)).rows[0].n;
    expect(live).toBe(0);
    expect(h.ctx.exchange.depth('USDTRY').asks).toEqual([]);
    // The next generation goes in normally.
    expect((await liquidity('BANK_MM', [['SELL', '49.25', '100']])).applied).toBe(true);
    expect(h.ctx.exchange.depth('USDTRY').asks).toEqual([{ price: '49.25', qty: '100.00', count: 1 }]);
  });

  it('a command whose transaction failed can be sent again with the same generation id', async () => {
    await start();
    const account = await bankAccount();
    const generationId = await h.ctx.exchange.nextGenerationId();
    const levels: LiquidityLevel[] = [{ side: 'SELL', price: parsePrice('49.25'), qty: units('100') }];
    await expect(
      h.ctx.exchange.replaceLiquidity({ pair: 'USDTRY', source: 'BANK_MM', strategyId: 'bank-ladder', account: { ...account, customerId: 'not-a-uuid' }, levels, generationId }),
    ).rejects.toThrow();
    const again = await h.ctx.exchange.replaceLiquidity({ pair: 'USDTRY', source: 'BANK_MM', strategyId: 'bank-ladder', account, levels, generationId });
    expect(again).toMatchObject({ applied: true, placed: 1 });
  });
});

describe('7: LP freshness is measured from the LP quote time', () => {
  it('a quote refreshed close to its timeout is not stretched by the refresh', async () => {
    await start({ config: base((c) => (c.dealing.maxStalenessMs = 3000)) });
    const quotes = h.liquidity.quotes.bind(h.liquidity);
    h.liquidity.quotes = async (pair: string) => (await quotes(pair)).map((q) => ({ ...q, at: new Date(h.clock.now.getTime() - 2999).toISOString() }));
    await h.ctx.prices.refresh('USDTRY');
    expect(h.ctx.prices.fresh('USDTRY')).toBeDefined();
    h.clock.now = new Date(h.clock.now.getTime() + 2);
    expect(h.ctx.prices.fresh('USDTRY')).toBeUndefined();
    // current() does not hand out the stale aggregate either: it asks the LPs again.
    const again = await h.ctx.prices.current('USDTRY');
    expect(again.sourceAt.getTime()).toBe(h.clock.now.getTime() - 2999);
  });
});

describe('8–9: reports keep the board match ratio and value economics like the simulation', () => {
  it('C2C 100 + C2B 100: board ratio 50%, customer leg share 2/3; net contribution has its parts', async () => {
    await start();
    h.customer('ali', { USD: '1000', TRY: '0' });
    h.customer('veli', { USD: '0', TRY: '100000' });
    h.customer('ayse', { USD: '0', TRY: '100000' });
    await h.place(await h.login('ali'), { side: 'SELL', qty: '100', price: '49.15' });
    await h.place(await h.login('veli'), { side: 'BUY', qty: '100', price: '49.15' });
    await liquidity('BANK_MM', [['SELL', '49.30', '100']]);
    await h.place(await h.login('ayse'), { side: 'BUY', qty: '100', price: '49.30' });
    const [r] = (await h.req('GET', '/ops/reports', OPS)).body.pairs;
    // Commission 500 pips (0.05 TRY) per side: C2C 5 + 5, C2B the customer's 5. The bank sold 100 at 49.30 against
    // an LP ask of 49.1559.
    expect(r).toMatchObject({
      p2pMatchRatio: '0.5000',
      customerLegP2PShare: '0.6666',
      fees: '15.00',
      principalContribution: '14.41',
      hedgeCost: '0.00',
      netContribution: '29.41',
    });

    // A Direct deal changes the customer leg share, not the board ratio.
    const ayse = await h.login('ayse');
    const quote = (await h.req('POST', '/v1/bank/quotes', ayse, { pair: 'USDTRY', side: 'BUY', qty: '100' })).body;
    expect((await h.req('POST', '/v1/bank/deals', ayse, { quoteId: quote.id })).status).toBe(201);
    const [after] = (await h.req('GET', '/ops/reports', OPS)).body.pairs;
    expect(after).toMatchObject({ p2pMatchRatio: '0.5000', customerLegP2PShare: '0.5000' });
  });

  it('Direct only: no board ratio', async () => {
    await start();
    h.customer('ayse', { USD: '0', TRY: '100000' });
    const ayse = await h.login('ayse');
    const quote = (await h.req('POST', '/v1/bank/quotes', ayse, { pair: 'USDTRY', side: 'BUY', qty: '100' })).body;
    await h.req('POST', '/v1/bank/deals', ayse, { quoteId: quote.id });
    const [r] = (await h.req('GET', '/ops/reports', OPS)).body.pairs;
    expect(r).toMatchObject({ p2pMatchRatio: null, customerLegP2PShare: '0.0000' });
  });
});
