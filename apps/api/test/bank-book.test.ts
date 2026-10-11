import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, formatPrice, parsePrice } from '@p2p/shared';
import { OPS, startHarness, type Harness } from './helpers.js';
import { ladderLevels } from '../src/dealing/bank-book.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
  h = undefined as unknown as Harness;
});

// Frozen LPs around 49.15: best 49.1441 / 49.1559; default segment margin 1000 pips → bank rate 49.2559 / 49.0441.
// Ladder default: 0.02 % from the bank rate, 0.02 % steps, commission (500 pips = 0.05) taken out of the book price.
const usd = DEFAULT_CONFIG.pairs[0];
const only = (pair: string) => ({
  ...DEFAULT_CONFIG,
  bankBook: { ...DEFAULT_CONFIG.bankBook, pairs: { [pair]: DEFAULT_CONFIG.bankBook.pairs[pair] } },
});

async function start() {
  h = await startHarness({ config: only('USDTRY') });
  h.customer('bank-desk', { USD: '1000000', TRY: '100000000' });
  await h.ctx.prices.refreshAll();
}
const book = async () => (await h.req('GET', '/v1/pairs/USDTRY/book', await h.login('viewer'))).body;

describe('bank orders in the book', () => {
  it('prices the ladder off the bank rate, with the commission taken out', () => {
    const asks = ladderLevels(DEFAULT_CONFIG, usd, 'asks', parsePrice('49.2559'));
    const bids = ladderLevels(DEFAULT_CONFIG, usd, 'bids', parsePrice('49.0441'));
    expect(asks.map((l) => formatPrice(l.price))).toEqual(['49.2158', '49.2257', '49.2355']);
    expect(bids.map((l) => formatPrice(l.price))).toEqual(['49.0842', '49.0744', '49.0646']);
    // What a buyer pays on the best level (49.2158 + 0.05) is above the bank's own rate (49.2559).
    expect(asks[0].price + parsePrice('0.05')).toBeGreaterThan(parsePrice('49.2559'));

    const raw = { ...DEFAULT_CONFIG, bankBook: { ...DEFAULT_CONFIG.bankBook, includeCommission: false } };
    expect(formatPrice(ladderLevels(raw, usd, 'asks', parsePrice('49.2559'))[0].price)).toBe('49.2658');
  });

  it('keeps the ladder in the book, refills what customers take and books the position', async () => {
    await start();
    await h.ctx.bankBook.tick();
    let b = await book();
    expect(b.asks.slice(0, 3)).toEqual([
      { price: '49.2158', qty: '5000.00', count: 1 },
      { price: '49.2257', qty: '10000.00', count: 1 },
      { price: '49.2355', qty: '20000.00', count: 1 },
    ]);
    expect(b.bids[0]).toEqual({ price: '49.0842', qty: '5000.00', count: 1 });

    // Nothing moved: a second pass leaves the orders alone.
    const before = (await h.req('GET', '/ops/dealing', OPS)).body.bankBook.orders;
    await h.ctx.bankBook.tick();
    expect((await h.req('GET', '/ops/dealing', OPS)).body.bankBook.orders).toEqual(before);

    // A customer buys 3,000 USD from the best bank offer: commission and tax on the customer only.
    h.customer('mehmet', { USD: '0', TRY: '1000000' });
    const mehmet = await h.login('mehmet');
    const res = await h.place(mehmet, { side: 'BUY', qty: '3000', price: '49.2158' });
    expect(res.status).toBe(201);
    await h.ctx.exchange.idle();
    const fills = (await h.req('GET', '/v1/fills', mehmet)).body;
    expect(fills[0]).toMatchObject({ qty: '3000.00', bookPrice: '49.2158', effectivePrice: '49.2658', commission: '150.00' });

    const desk = (await h.req('GET', '/ops/dealing', OPS)).body;
    expect(desk.positions.find((p: { pair: string }) => p.pair === 'USDTRY')).toMatchObject({ qty: '-3000.00', avgRate: '49.2158' });

    // The next pass restores the full ladder.
    await h.ctx.bankBook.tick();
    b = await book();
    expect(b.asks[0]).toEqual({ price: '49.2158', qty: '5000.00', count: 1 });
  });

  it('reprices when the bank rate changes and pulls the orders when switched off', async () => {
    await start();
    await h.ctx.bankBook.tick();
    // Wider default margin: bank rate 49.2559 → 49.3559, the ladder follows.
    await h.setConfig((c) => ({ ...c, dealing: { ...c.dealing, margins: { ...c.dealing.margins, default: { buyPips: 2000, sellPips: 1000 } } } }));
    await h.ctx.bankBook.tick();
    const asks = (await book()).asks;
    expect(asks[0]).toEqual({ price: '49.3158', qty: '5000.00', count: 1 });
    expect(asks).toHaveLength(3);

    await h.setConfig((c) => ({ ...c, channels: { ...c.channels, bankMarketMaker: false } }));
    await h.ctx.bankBook.tick();
    const b = await book();
    expect([...b.asks, ...b.bids]).toEqual([]);
  });
});
