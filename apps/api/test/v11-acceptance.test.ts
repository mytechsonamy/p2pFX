// Acceptance scenarios T01–T16 of the product definition v1.1 (section 16). Each builds its book from scratch,
// runs its commands in order and checks fills, balances and holds, and the bank's principal exposure.
import { afterEach, describe, expect, it } from 'vitest';
import { CoreBankingError, MockCoreBank, type FxTransactionRequest } from '@p2p/core-adapter';
import { DEFAULT_CONFIG, parsePrice, type BankConfig, type Side } from '@p2p/shared';
import { BankAccount, ladderLevels } from '../src/dealing/bank-book.js';
import type { LiquidityLevel } from '../src/engine/exchange.js';
import { OPS, startHarness, units, type Harness } from './helpers.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
  h = undefined as unknown as Harness;
});

/** USDTRY only, the bank's automatic ladder and bot left to the test (it enters bank liquidity itself). */
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

/** Enters one generation of bank liquidity (ladder: BANK_MM, bot: BOT_MM) as the bank's automatic sources would. */
async function liquidity(source: 'BANK_MM' | 'BOT_MM', levels: [Side, string, string][], strategyId = source === 'BANK_MM' ? 'bank-ladder' : 'bot-mm-1') {
  const config = h.ctx.config.get().data;
  const account = (await new BankAccount(h.ctx.db, h.bank).for(config, config.pairs.find((p) => p.symbol === 'USDTRY')!))!;
  const lv: LiquidityLevel[] = levels.map(([side, price, qty]) => ({ side, price: parsePrice(price), qty: units(qty) }));
  return h.ctx.exchange.replaceLiquidity({ pair: 'USDTRY', source, strategyId, account, levels: lv, generationId: await h.ctx.exchange.nextGenerationId() });
}

const fills = async () =>
  (
    await h.ctx.db.query(
      `select f.book_price::text as price, f.qty::text as qty, f.flow, f.maker_source, f.taker_source, m.generation_id::text as maker_generation
         from fills f join orders m on m.id = f.maker_order_id order by f.seq`,
    )
  ).rows;
const position = () => h.ctx.positions.current('USDTRY');
const depth = () => h.ctx.exchange.depth('USDTRY');

describe('v1.1 acceptance', () => {
  it('T01: a better bank price matches first; no source priority', async () => {
    await start();
    h.customer('ali', { USD: '1000', TRY: '0' });
    h.customer('veli', { USD: '0', TRY: '100000' });
    await h.place(await h.login('ali'), { side: 'SELL', qty: '500', price: '49.30' });
    await liquidity('BANK_MM', [['SELL', '49.29', '500']]);
    await h.place(await h.login('veli'), { side: 'BUY', qty: '1000', price: '49.35' });
    expect((await fills()).map((f) => [f.price, f.maker_source, f.flow])).toEqual([
      ['49.29000000', 'BANK_MM', 'C2B'],
      ['49.30000000', 'CUSTOMER', 'C2C'],
    ]);
    // The bank sold 500 USD as principal.
    expect(position()).toBe(-units('500'));
  });

  it('T02: at the same price the order accepted first works first, whatever its source', async () => {
    await start();
    h.customer('ali', { USD: '1000', TRY: '0' });
    h.customer('veli', { USD: '0', TRY: '100000' });
    await liquidity('BOT_MM', [['SELL', '49.30', '300']]);
    await h.place(await h.login('ali'), { side: 'SELL', qty: '300', price: '49.30' });
    await h.place(await h.login('veli'), { side: 'BUY', qty: '400', price: '49.30' });
    expect((await fills()).map((f) => [f.qty, f.maker_source])).toEqual([
      ['30000', 'BOT_MM'],
      ['10000', 'CUSTOMER'],
    ]);
  });

  it('T03: an LP move never changes a customer limit resting in the book', async () => {
    await start();
    h.customer('ali', { USD: '1000', TRY: '0' });
    await h.place(await h.login('ali'), { side: 'SELL', qty: '500', price: '49.40' });
    h.bank.setReferenceRate('USDTRY', '49.25');
    await h.ctx.prices.refreshAll();
    await h.ctx.bankBook.tick();
    const customerLevels = (await h.ctx.db.query(`select book_price::text from orders where source = 'CUSTOMER' and status = 'OPEN'`)).rows;
    expect(customerLevels).toEqual([{ book_price: '49.40000000' }]);
    expect(depth().asks.find((l) => l.price === '49.40')).toBeDefined();
  });

  it('T04: a customer order racing a generation swap sees the old or the new ladder, never a mix', async () => {
    await start();
    h.customer('veli', { USD: '0', TRY: '200000' });
    const veli = await h.login('veli');
    await liquidity('BANK_MM', [['SELL', '49.20', '1000'], ['SELL', '49.21', '1000']]);
    const [, order] = await Promise.all([
      liquidity('BANK_MM', [['SELL', '49.25', '1000'], ['SELL', '49.26', '1000']]),
      h.place(veli, { side: 'BUY', qty: '1500', price: '49.30' }),
    ]);
    expect(order.status).toBe(201);
    const f = await fills();
    expect(f.length).toBe(2);
    expect(new Set(f.map((x) => x.maker_generation)).size).toBe(1);
  });

  it('T05: a new bank price crossing a resting customer limit trades at the resting price, then the book is uncrossed', async () => {
    await start();
    h.customer('veli', { USD: '0', TRY: '100000' });
    await h.place(await h.login('veli'), { side: 'BUY', qty: '500', price: '49.30' });
    const res = await liquidity('BANK_MM', [['SELL', '49.25', '1000'], ['BUY', '49.10', '1000']]);
    expect(res.fills).toHaveLength(1);
    expect((await fills()).map((f) => [f.price, f.taker_source])).toEqual([['49.30000000', 'BANK_MM']]);
    const d = depth();
    expect(d.asks[0]).toMatchObject({ price: '49.25', qty: '500.00' });
    expect(parsePrice(d.bids[0].price)).toBeLessThan(parsePrice(d.asks[0].price));
  });

  it('T06: switching the market maker off takes its orders out; a firm fill still settles', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    class SlowBank extends MockCoreBank {
      override async postFxTransaction(r: FxTransactionRequest) {
        await gate;
        return super.postFxTransaction(r);
      }
    }
    await start({ bank: new SlowBank() });
    h.customer('veli', { USD: '0', TRY: '100000' });
    const veli = await h.login('veli');
    await liquidity('BANK_MM', [['SELL', '49.25', '1000'], ['SELL', '49.26', '1000']]);
    // Straight to the app: the harness would wait for the settlement the gate is holding.
    await h.app.inject({ method: 'POST', url: '/v1/orders', headers: { authorization: `Bearer ${veli}`, 'idempotency-key': 't06' }, payload: { pair: 'USDTRY', side: 'BUY', qty: '400', price: '49.25', validity: 'GTC' } });
    await h.ctx.config.update({ ...h.ctx.config.get().data, channels: { ...h.ctx.config.get().data.channels, bankMarketMaker: false } }, 'test', 'MM kapatıldı');
    await h.ctx.bankBook.enforce();
    expect(depth().asks).toEqual([]);
    const { rows } = await h.ctx.db.query(`select status, cancel_reason from orders where source = 'BANK_MM' and status = 'CANCELLED'`);
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.cancel_reason === 'WITHDRAWN')).toBe(true);
    release();
    await h.ctx.exchange.idle();
    expect((await h.ctx.db.query('select distinct status from settlements')).rows).toEqual([{ status: 'SETTLED' }]);
    expect(await h.balance('veli', 'USD')).toMatchObject({ balance: units('400') });
  });

  it('T07: a market order fills what the book has within its protection price and cancels the rest', async () => {
    await start();
    h.customer('veli', { USD: '0', TRY: '100000' });
    const veli = await h.login('veli');
    // LP ask 49.1559, 50 bps slippage: protection 49.4017. The 49.45 level is beyond it.
    await liquidity('BANK_MM', [['SELL', '49.20', '300'], ['SELL', '49.25', '300'], ['SELL', '49.45', '1000']]);
    const q = await h.req('POST', '/v1/orders/quote', veli, { pair: 'USDTRY', side: 'BUY', qty: '1000', type: 'MARKET' });
    expect(q.body).toMatchObject({ type: 'MARKET', protectionPrice: '49.4017', estimate: { fillableQty: '600.00' } });
    const res = await h.place(veli, { side: 'BUY', qty: '1000', type: 'MARKET', validity: undefined, protectionPrice: q.body.protectionPrice });
    expect(res.status).toBe(201);
    const order = (await h.req('GET', `/v1/orders/${res.body.id}`, veli)).body;
    expect(order).toMatchObject({ type: 'MARKET', status: 'CANCELLED', cancelReason: 'NO_LIQUIDITY', filledQty: '600.00' });
    expect((await fills()).map((f) => f.price)).toEqual(['49.20000000', '49.25000000']);
    expect(depth().asks).toEqual([{ price: '49.45', qty: '1000.00', count: 1 }]);
    // The hold covered the protection price; what is not used goes back.
    const b = await h.balance('veli', 'TRY');
    expect(b.available).toBe(b.balance);
  });

  it('T08: a bank funded bot selling to a customer lowers the bank USD position and is not P2P volume', async () => {
    await start();
    h.customer('veli', { USD: '0', TRY: '100000' });
    await liquidity('BOT_MM', [['SELL', '49.30', '1000']]);
    await h.place(await h.login('veli'), { side: 'BUY', qty: '1000', price: '49.30' });
    expect(position()).toBe(-units('1000'));
    const [r] = (await h.req('GET', '/ops/reports', OPS)).body.pairs;
    expect(r).toMatchObject({ c2c: { count: 0 }, c2b: { botMarketMaker: { count: 1, qty: '1000.00' } }, p2pMatchRatio: '0.0000', customerLegVolume: '1000.00' });
    const exec = (await h.ctx.db.query('select source, bank_side, position_delta::text from principal_executions')).rows;
    expect(exec).toEqual([{ source: 'BOT_MM', bank_side: 'SELL', position_delta: '-100000' }]);
  });

  it('T09: the ladder and the bot of the same principal never trade with each other', async () => {
    await start();
    await liquidity('BANK_MM', [['BUY', '49.30', '1000']]);
    await liquidity('BOT_MM', [['SELL', '49.28', '500']]);
    expect(await fills()).toEqual([]);
    expect((await h.ctx.db.query('select count(*)::int as n from fee_records')).rows[0].n).toBe(0);
    const bot = (await h.ctx.db.query(`select status, cancel_reason from orders where source = 'BOT_MM'`)).rows;
    expect(bot).toEqual([{ status: 'CANCELLED', cancel_reason: 'SELF_MATCH' }]);
    expect(depth().bids).toEqual([{ price: '49.30', qty: '1000.00', count: 1 }]);
    expect(position()).toBe(0n);
  });

  it('T10: a hedge timeout leaves the customer fill firm and opens a hedge exception', async () => {
    await start({ config: base((c) => (c.dealing.positionLimits = { USD: '500' })) });
    for (const lp of ['LP-A', 'LP-B', 'LP-C']) h.liquidity.losingResponses.add(lp);
    h.customer('veli', { USD: '0', TRY: '100000' });
    await liquidity('BANK_MM', [['SELL', '49.25', '1000']]);
    await h.place(await h.login('veli'), { side: 'BUY', qty: '1000', price: '49.25' });
    expect((await h.ctx.db.query('select distinct status from settlements')).rows).toEqual([{ status: 'SETTLED' }]);
    const ex = (await h.req('GET', '/ops/exceptions', OPS)).body;
    expect(ex.hedges.length).toBeGreaterThan(0);
    expect(ex.hedges[0]).toMatchObject({ pair: 'USDTRY', side: 'BUY', state: 'UNKNOWN_OUTCOME' });
    const hedges = (await h.req('GET', '/ops/dealing', OPS)).body.hedges;
    expect(hedges[0].state).toBe('UNKNOWN_OUTCOME');
  });

  it('T11: a lost core response is looked up; no leg is posted twice and no hold is released early', async () => {
    class LosingBank extends MockCoreBank {
      lose = true;
      lookupDown = true;
      booked: string[] = [];
      override async postFxTransaction(r: FxTransactionRequest) {
        const res = await super.postFxTransaction(r);
        if (!this.booked.includes(r.idempotencyKey)) this.booked.push(r.idempotencyKey);
        if (r.leg === 'BANK_BUY' && this.lose) throw new CoreBankingError('UNAVAILABLE', 'response lost');
        return res;
      }
      override async findFxTransaction(key: string) {
        if (this.lookupDown) throw new CoreBankingError('UNAVAILABLE', 'lookup unavailable');
        return super.findFxTransaction(key);
      }
    }
    const bank = new LosingBank();
    await start({ bank });
    h.customer('ali', { USD: '1000', TRY: '0' });
    h.customer('veli', { USD: '0', TRY: '100000' });
    await h.place(await h.login('ali'), { side: 'SELL', qty: '1000', price: '49.15' });
    await h.place(await h.login('veli'), { side: 'BUY', qty: '1000', price: '49.15' });
    expect((await h.ctx.db.query('select status from settlements order by leg')).rows.map((r) => r.status)).toEqual(['UNKNOWN_OUTCOME', 'PENDING']);
    // The buyer's TRY stays held for the leg not posted yet.
    const held = await h.balance('veli', 'TRY');
    expect(held.balance - held.available).toBe(units('49298.40'));
    bank.lose = false;
    bank.lookupDown = false;
    const fillId = (await h.ctx.db.query('select id from fills')).rows[0].id;
    expect(await h.ctx.settlement.settle(fillId)).toBe('SETTLED');
    expect(bank.booked.filter((k) => k.includes('BANK_BUY'))).toHaveLength(1);
    await h.ctx.exchange.idle();
    const after = await h.balance('veli', 'TRY');
    expect(after).toMatchObject({ balance: units('100000') - units('49298.40'), available: units('100000') - units('49298.40') });
  });

  it('T12: a duplicate settlement event and a restart replay give one fee, one position delta and the same book', async () => {
    await start();
    h.customer('ali', { USD: '1000', TRY: '0' });
    h.customer('veli', { USD: '0', TRY: '100000' });
    h.customer('ayse', { USD: '500', TRY: '0' });
    await liquidity('BANK_MM', [['SELL', '49.25', '1000']]);
    await h.place(await h.login('ali'), { side: 'SELL', qty: '400', price: '49.15' });
    await h.place(await h.login('veli'), { side: 'BUY', qty: '600', price: '49.25' });
    await h.place(await h.login('ayse'), { side: 'SELL', qty: '200', price: '49.40' });
    const fillIds = (await h.ctx.db.query('select id from fills order by seq')).rows.map((r) => r.id);
    const notified = h.bank.notifications.length;
    for (const id of fillIds) {
      await h.ctx.exchange.afterSettlement(id, 'SETTLED');
      await h.ctx.settlement.settle(id);
    }
    await h.ctx.exchange.idle();
    expect(h.bank.notifications.length).toBe(notified);
    const book = depth();
    const counts = async () =>
      (
        await h.ctx.db.query(
          `select (select count(*)::int from fee_records) as fees, (select count(*)::int from principal_executions) as executions,
                  (select coalesce(sum(position_delta), 0)::text from principal_executions) as delta`,
        )
      ).rows[0];
    const before = await counts();
    expect(before).toEqual({ fees: 2 + 1, executions: 1, delta: '-20000' });

    const bank = h.bank;
    await h.close();
    h = await startHarness({ bank, reset: false, config: base() });
    expect(await counts()).toEqual(before);
    expect(depth()).toEqual(book);
    expect(position()).toBe(-units('200'));
  });

  it('T13: stored bips become pips explicitly (no 100x surprise) and the all-in price is unchanged', async () => {
    await start();
    // A configuration stored before v1.1, in bips.
    const legacy = structuredClone(h.ctx.config.get().data) as unknown as Record<string, any>;
    for (const p of legacy.pairs) {
      p.bipSize = (parseFloat(p.pipSize) * 100).toFixed(8).replace(/0+$/, '');
      delete p.pipSize;
      p.commission = { buyBips: p.commission.buy / 100, sellBips: p.commission.sell / 100 };
    }
    legacy.dealing.enabled = true;
    legacy.dealing.margins = { default: { buyBips: 10, sellBips: 10 }, segments: { premium: { buyBips: 4, sellBips: 4 } } };
    legacy.bankBook = { ...legacy.bankBook, enabled: true, repriceBips: 2 };
    delete legacy.bankBook.repricePips;
    delete legacy.channels;
    delete legacy.botMarketMaker;
    await h.ctx.db.query(`insert into config (data, created_by, reason, diff) values ($1, 'system', 'eski sürüm', '[]')`, [legacy]);
    const bank = h.bank;
    await h.close();
    h = await startHarness({ bank, reset: false });
    const [latest] = (await h.req('GET', '/ops/config/versions', OPS)).body;
    expect(latest.reason).toMatch(/pip/);
    const c = h.ctx.config.get().data;
    expect(c.pairs.find((p) => p.symbol === 'USDTRY')).toMatchObject({ pipSize: '0.0001', commission: { mode: 'PIPS', buy: 500, sell: 500 } });
    expect(c.dealing.margins.default).toEqual({ buyPips: 1000, sellPips: 1000 });
    expect(c.bankBook.repricePips).toBe(200);
    expect(c.channels).toMatchObject({ bankDirect: true, bankMarketMaker: true });

    // The worked example still costs what it did: 1,000 USD at 49.15 with 0.05 TRY commission per unit.
    h.customer('veli', { USD: '0', TRY: '100000' });
    const q = await h.req('POST', '/v1/orders/quote', await h.login('veli'), { pair: 'USDTRY', side: 'BUY', qty: '1000', price: '49.15' });
    expect(q.body).toMatchObject({ commissionPerUnit: '0.05', effectivePrice: '49.20', commission: '50.00' });
    // Bank L1 parity: a ladder level plus the buyer's commission is never better than the Direct rate.
    const usd = c.pairs.find((p) => p.symbol === 'USDTRY')!;
    const [l1] = ladderLevels(c, usd, 'asks', parsePrice('49.2559'));
    expect(l1.price + parsePrice('0.05')).toBeGreaterThanOrEqual(parsePrice('49.2559'));
  });

  it('T14: a stale feed stops the bank ladder and the bot', async () => {
    await start();
    await h.ctx.bankBook.tick();
    await h.ctx.bot.tick();
    const sources = async () => (await h.ctx.db.query(`select distinct source from orders where status = 'OPEN' order by source`)).rows.map((r) => r.source);
    expect(await sources()).toEqual(['BANK_MM', 'BOT_MM']);
    h.clock.now = new Date(h.clock.now.getTime() + DEFAULT_CONFIG.dealing.maxStalenessMs + 1);
    await h.ctx.bankBook.tick();
    await h.ctx.bot.tick();
    expect(await sources()).toEqual([]);
    expect(depth()).toMatchObject({ asks: [], bids: [] });
  });

  it('T15: switching SEPARATE to UNIFIED keeps open orders and price-time priority', async () => {
    await start();
    h.customer('ali', { USD: '1000', TRY: '0' });
    h.customer('ayse', { USD: '1000', TRY: '0' });
    h.customer('veli', { USD: '0', TRY: '100000' });
    const first = await h.place(await h.login('ali'), { side: 'SELL', qty: '300', price: '49.30' });
    await h.place(await h.login('ayse'), { side: 'SELL', qty: '300', price: '49.30' });
    const book = depth();
    await h.setConfig((c) => ({ ...c, marketPresentation: 'UNIFIED' }));
    expect((await h.req('GET', '/v1/config', await h.login('veli'))).body.presentation).toBe('UNIFIED');
    expect(depth()).toEqual(book);
    await h.place(await h.login('veli'), { side: 'BUY', qty: '300', price: '49.30' });
    const { rows } = await h.ctx.db.query(`select maker_order_id from fills`);
    expect(rows).toEqual([{ maker_order_id: first.body.id }]);
  });

  it('T16: Direct and board trades racing for the inventory cap never take the bank past it', async () => {
    await start({ config: base((c) => (c.inventory.maxPosition = { USD: '1500' })) });
    h.customer('veli', { USD: '0', TRY: '100000' });
    h.customer('ayse', { USD: '0', TRY: '100000' });
    await liquidity('BANK_MM', [['SELL', '49.25', '1000']]);
    const ayse = await h.login('ayse');
    const quote = (await h.req('POST', '/v1/bank/quotes', ayse, { pair: 'USDTRY', side: 'BUY', qty: '1000' })).body;
    const [deal, order] = await Promise.all([
      h.req('POST', '/v1/bank/deals', ayse, { quoteId: quote.id }),
      h.place(await h.login('veli'), { side: 'BUY', qty: '1000', price: '49.25' }),
    ]);
    const done = (await h.ctx.db.query('select coalesce(sum(position_delta), 0)::bigint as d from principal_executions')).rows[0].d;
    expect(BigInt(done)).toBeGreaterThanOrEqual(-units('1500'));
    expect(position()).toBeGreaterThanOrEqual(-units('1500'));
    // Exactly one of the two got the bank's USD.
    const dealt = deal.status === 201 ? 1 : 0;
    const boardFills = (await fills()).length;
    expect(dealt + boardFills).toBe(1);
    if (!dealt) expect(deal.body.error).toBe('INVENTORY_LIMIT');
    // The board order the bank could not fill rests; the bank's offer that would breach the cap is withdrawn.
    else expect(order.body).toMatchObject({ status: 'OPEN', filledQty: '0.00' });
  });
});

describe('v1.1 controls and records', () => {
  it('kill switch: halts new orders, Direct and bank liquidity; operations cancel what rests, audited', async () => {
    await start();
    h.customer('ali', { USD: '1000', TRY: '0' });
    const ali = await h.login('ali');
    await h.place(ali, { side: 'SELL', qty: '100', price: '49.40' });
    await h.ctx.bankBook.tick();
    await h.setConfig((c) => ({ ...c, killSwitch: { ...c.killSwitch, haltedPairs: ['USDTRY'] } }));
    expect((await h.place(ali, { side: 'SELL', qty: '100', price: '49.41' })).body.error).toBe('TRADING_HALTED');
    expect((await h.req('POST', '/v1/bank/quotes', ali, { pair: 'USDTRY', side: 'SELL', qty: '100' })).body.error).toBe('TRADING_HALTED');
    await h.ctx.bankBook.enforce();
    expect((await h.ctx.db.query(`select count(*)::int as n from orders where source = 'BANK_MM' and status = 'OPEN'`)).rows[0].n).toBe(0);

    const res = await h.req('POST', '/ops/controls/cancel-orders', OPS, { pair: 'USDTRY', reason: 'Piyasa durduruldu' });
    expect(res.body).toEqual({ cancelled: 1 });
    expect(depth()).toMatchObject({ asks: [], bids: [] });
    const audit = (await h.req('GET', '/ops/audit?action=ops.orders.cancel', OPS)).body;
    expect(JSON.stringify(audit)).toContain('Piyasa durduruldu');
    const held = await h.balance('ali', 'USD');
    expect(held.available).toBe(held.balance);
  });

  it('BPS commission: charged as a share of the price and recorded per side with its policy version', async () => {
    await start({ config: base((c) => (c.pairs[0].commission = { mode: 'BPS', buy: 10, sell: 10 })) });
    h.customer('ali', { USD: '1000', TRY: '0' });
    h.customer('veli', { USD: '0', TRY: '100000' });
    await h.place(await h.login('ali'), { side: 'SELL', qty: '1000', price: '49.15' });
    await h.place(await h.login('veli'), { side: 'BUY', qty: '1000', price: '49.15' });
    const fees = (await h.ctx.db.query('select side, fee_mode, fee_rate::text, fee_amount::text from fee_records order by side')).rows;
    expect(fees).toEqual([
      { side: 'BUY', fee_mode: 'BPS', fee_rate: '0.001000000000', fee_amount: '4915' },
      { side: 'SELL', fee_mode: 'BPS', fee_rate: '0.001000000000', fee_amount: '4915' },
    ]);
  });

  it('event log: a trade leaves its events in pair order, append only', async () => {
    await start();
    h.customer('ali', { USD: '1000', TRY: '0' });
    h.customer('veli', { USD: '0', TRY: '100000' });
    await h.place(await h.login('ali'), { side: 'SELL', qty: '100', price: '49.15' });
    await h.place(await h.login('veli'), { side: 'BUY', qty: '100', price: '49.15' });
    const { rows } = await h.ctx.db.query(`select type, pair_seq::int from events where pair = 'USDTRY' order by pair_seq`);
    expect(rows.map((r) => r.type)).toEqual(['OrderAccepted', 'OrderAccepted', 'FillCommitted', 'SettlementUpdated']);
    expect(rows.map((r) => r.pair_seq)).toEqual([1, 2, 3, 4]);
    await expect(h.ctx.db.query(`update events set type = 'x'`)).rejects.toThrow();
  });
});
