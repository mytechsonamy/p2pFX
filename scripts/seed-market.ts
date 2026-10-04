// Seeds a running stack with market activity: a trade history and a resting order book on every pair,
// placed through the public API by market-maker customers (demo-mm-*). Safe to re-run: skips pairs that
// already have trades. Usage: pnpm demo:seed
import { api, login, placeOrder, waitForApi } from './lib/demo-client.js';

/** Trades in the history, per pair. */
const HISTORY = 14;
/** Price levels on each side of the book. */
const LEVELS = 6;

// Deterministic randomness so every demo starts from the same board.
let state = 20261004;
const rand = () => ((state = (state * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const between = (lo: number, hi: number) => lo + rand() * (hi - lo);
const lot = (lo: number, hi: number, step: number) => String(Math.round(between(lo, hi) / step) * step);
const price = (v: number) => v.toFixed(2);

await waitForApi();
const makers = await Promise.all(['demo-mm-1', 'demo-mm-2', 'demo-mm-3', 'demo-mm-4', 'demo-mm-5', 'demo-mm-6'].map((ref) => login(ref, 'premium')));
const config = await api('GET', '/v1/config', makers[0]);

for (const [i, pair] of (config.pairs as { symbol: string; base: string }[]).entries()) {
  const [a, b] = [makers[(2 * i) % makers.length], makers[(2 * i + 1) % makers.length]];
  if ((await api('GET', `/v1/pairs/${pair.symbol}/trades?limit=1`, a)).length) {
    console.log(`${pair.symbol}: already has trades, skipping`);
    continue;
  }
  const ref = Number((await api('GET', `/v1/pairs/${pair.symbol}/rate`, a)).rate);
  const small = pair.base === 'GBP';

  // History: a gentle walk from below the reference rate up to it, alternating which side takes.
  let p = ref - 0.22;
  for (let k = 0; k < HISTORY; k++) {
    p = k === HISTORY - 1 ? ref - 0.01 : Math.min(ref + 0.12, Math.max(ref - 0.3, p + between(-0.05, 0.08)));
    // Stay inside the current best bid and offer (the bank's own ladder among them), so the history trades
    // are between the two market makers and never take resting liquidity.
    const top = await api('GET', `/v1/pairs/${pair.symbol}/book`, a);
    if (top.bids[0]) p = Math.max(p, Math.floor(Number(top.bids[0].price) * 100) / 100 + 0.01);
    if (top.asks[0]) p = Math.min(p, Math.ceil(Number(top.asks[0].price) * 100) / 100 - 0.01);
    const qty = lot(small ? 100 : 200, small ? 1500 : 4000, 50);
    const [seller, buyer] = k % 2 ? [a, b] : [b, a];
    const sellFirst = k % 3 !== 0;
    const sell = { pair: pair.symbol, side: 'SELL' as const, qty, price: price(p) };
    const buy = { ...sell, side: 'BUY' as const };
    if (sellFirst) {
      await placeOrder(seller, sell);
      await placeOrder(buyer, buy);
    } else {
      await placeOrder(buyer, buy);
      await placeOrder(seller, sell);
    }
  }

  // Resting book: bids from 0.04 under the reference rate down, asks from 0.05 over it up. The spread
  // leaves room for the demo customers to trade at the reference rate itself (49.15 for USD/TRY).
  let orders = 0;
  for (let j = 0; j < LEVELS; j++) {
    const levels = [
      { side: 'BUY' as const, price: price(ref - 0.04 - 0.03 * j) },
      { side: 'SELL' as const, price: price(ref + 0.05 + 0.03 * j) },
    ];
    for (const level of levels) {
      const count = j % 3 === 1 ? 2 : 1;
      for (let n = 0; n < count; n++) {
        await placeOrder(n ? b : a, { pair: pair.symbol, ...level, qty: lot(small ? 100 : 300, small ? 1200 : 3000 + j * 800, 50) });
        orders++;
      }
    }
  }
  console.log(`${pair.symbol}: ${HISTORY} trades around ${ref}, ${orders} resting orders`);
}
