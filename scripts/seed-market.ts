// Seeds a running stack with market activity: a trade history and a resting order book on every pair,
// placed through the public API by market-maker customers (demo-mm-*). Safe to re-run: skips pairs that
// already have trades. Usage: pnpm demo:seed
import type { BotsConfig } from '../packages/shared/src/config.js';
import { api, login, ops, placeOrder, waitForApi } from './lib/demo-client.js';

/** Trades in the history, per pair. */
const HISTORY = 14;
/** Price levels on each side of the book. */
const LEVELS = 6;

// Deterministic randomness so every demo starts from the same board.
let state = 20261004;
const rand = () => ((state = (state * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const between = (lo: number, hi: number) => lo + rand() * (hi - lo);
const decimalsOf = (v: string) => (v.split('.')[1] ?? '').length;

interface Pair {
  symbol: string;
  base: string;
  bipSize: string;
}

await waitForApi();
// Order sizes and the market makers' segment (with its own order rate limit) come from the bank parameter `bots`.
const bots: BotsConfig = (await ops('GET', '/ops/config')).data.bots;
const makers = await Promise.all(['demo-mm-1', 'demo-mm-2', 'demo-mm-3', 'demo-mm-4', 'demo-mm-5', 'demo-mm-6'].map((ref) => login(ref, bots.segment)));
const config = await api('GET', '/v1/config', makers[0]);

for (const [i, pair] of (config.pairs as Pair[]).entries()) {
  const [a, b] = [makers[(2 * i) % makers.length], makers[(2 * i + 1) % makers.length]];
  if ((await api('GET', `/v1/pairs/${pair.symbol}/trades?limit=1`, a)).length) {
    console.log(`${pair.symbol}: already has trades, skipping`);
    continue;
  }
  // Everything below is in bips of the pair (0.01 TRY for USD, 1 TRY for a gram of gold, 0.0001 for JPY).
  const bip = Number(pair.bipSize);
  const price = (b: number) => (b * bip).toFixed(decimalsOf(pair.bipSize));
  const ref = Math.round(Number((await api('GET', `/v1/pairs/${pair.symbol}/rate`, a)).rate) / bip);
  const l = bots.lots[pair.base] ?? bots.lots.default;
  const step = Number(l.step) || 1;
  const lot = (scale = 1) => (Math.max(1, Math.round((between(Number(l.min), Number(l.max)) * scale) / step)) * step).toFixed(decimalsOf(l.step));

  // History: a gentle walk from below the reference rate up to it, alternating which side takes.
  let p = ref - 22;
  for (let k = 0; k < HISTORY; k++) {
    p = k === HISTORY - 1 ? ref - 1 : Math.min(ref + 12, Math.max(ref - 30, p + Math.round(between(-5, 8))));
    // Stay inside the current best bid and offer (the bank's own ladder among them), so the history trades
    // are between the two market makers and never take resting liquidity.
    const top = await api('GET', `/v1/pairs/${pair.symbol}/book`, a);
    if (top.bids[0]) p = Math.max(p, Math.floor(Number(top.bids[0].price) / bip) + 1);
    if (top.asks[0]) p = Math.min(p, Math.ceil(Number(top.asks[0].price) / bip) - 1);
    const qty = lot();
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

  // Resting book: bids from 4 bips under the reference rate down, asks from 5 bips over it up. The spread
  // leaves room for the demo customers to trade at the reference rate itself (49.15 for USD/TRY).
  let orders = 0;
  for (let j = 0; j < LEVELS; j++) {
    const levels = [
      { side: 'BUY' as const, price: price(ref - 4 - 3 * j) },
      { side: 'SELL' as const, price: price(ref + 5 + 3 * j) },
    ];
    for (const level of levels) {
      const count = j % 3 === 1 ? 2 : 1;
      for (let n = 0; n < count; n++) {
        await placeOrder(n ? b : a, { pair: pair.symbol, ...level, qty: lot(1 + j * 0.25) });
        orders++;
      }
    }
  }
  console.log(`${pair.symbol}: ${HISTORY} trades around ${price(ref)}, ${orders} resting orders`);
}
