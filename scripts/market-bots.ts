// Demo order bots: keep every pair's board alive while the demo runs. Each tick a bot (demo-mm-*) posts a
// passive order a few kuruş off the reference rate, cancels a stale one, or trades with another bot inside
// the spread so the last price, chart and trade tape move.
//
// Bots never take a customer's order: passive orders are priced so they cannot cross the book, and bot
// trades happen at a free price strictly inside the spread. A customer can still take a bot's order, like
// any other order on the board. Demo only: in production resting liquidity would come from the bank's own
// market-making account, under its rules.
//
// Every setting (who the bots are, pace, offsets, sizes, on/off) is the bank parameter `bots`, edited in the
// back office and picked up within a few seconds without restarting.
//
// Usage: pnpm demo:bots
import type { BotsConfig } from '../packages/shared/src/config.js';
import { HttpError, api, login, ops, placeOrder, sleep, waitForApi, type OrderInput } from './lib/demo-client.js';

interface Pair {
  symbol: string;
  base: string;
  bipSize: string;
}
interface Level {
  price: string;
}
interface Order {
  id: string;
  pair: string;
  side: 'BUY' | 'SELL';
  createdAt: string;
}

const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const cents = (v: number) => Math.round(v * 100);
const price = (c: number) => (c / 100).toFixed(2);

/** The `bots` parameter, re-read every few seconds. */
let settings!: BotsConfig;
let settingsAt = 0;
async function refreshSettings() {
  if (settings && Date.now() - settingsAt < 5000) return;
  settings = (await ops('GET', '/ops/config')).data.bots;
  settingsAt = Date.now();
}

const lot = (p: Pair) => {
  const l = settings.lots[p.base] ?? settings.lots.default;
  const step = Number(l.step) || 1;
  return String(Math.round(rand(Number(l.min), Number(l.max)) / step) * step);
};

/** A bot's session; logs in again when its session runs out. */
class Bot {
  private token?: string;
  constructor(readonly ref: string) {}
  async call<T>(fn: (token: string) => Promise<T>): Promise<T> {
    this.token ??= await login(this.ref, settings.segment);
    try {
      return await fn(this.token);
    } catch (e) {
      if (!(e instanceof HttpError && e.status === 401)) throw e;
      this.token = await login(this.ref, settings.segment);
      return fn(this.token);
    }
  }
  place = (o: OrderInput) => this.call((t) => placeOrder(t, o));
  open = (): Promise<Order[]> => this.call((t) => api('GET', '/v1/orders?status=open&limit=200', t));
  cancel = (id: string) => this.call((t) => api('DELETE', `/v1/orders/${id}`, t));
}

await waitForApi();
await refreshSettings();

const known = new Map<string, Bot>();
const botsNow = () => settings.refs.map((ref) => known.get(ref) ?? known.set(ref, new Bot(ref)).get(ref)!);
console.log(`${settings.refs.length} bots, every ${settings.intervalMs} ms (bank parameter "bots")`);

async function tick() {
  const bots = botsNow();
  const viewer = bots[0];
  const pairs: Pair[] = (await viewer.call((t) => api('GET', '/v1/config', t))).pairs;
  if (!pairs.length) return;
  const pair = pick(pairs);
  const bot = pick(bots);
  // Offsets are set in bips of the pair; the bots work in kuruş (0.01).
  const bipCents = Math.max(1, Math.round(Number(pair.bipSize) * 100));
  const [book, rate] = await viewer.call((t) =>
    Promise.all([api('GET', `/v1/pairs/${pair.symbol}/book`, t), api('GET', `/v1/pairs/${pair.symbol}/rate`, t)]),
  );
  const ref = cents(Number(rate.rate));
  const bestBid = book.bids[0] ? cents(Number(book.bids[0].price)) : undefined;
  const bestAsk = book.asks[0] ? cents(Number(book.asks[0].price)) : undefined;
  const roll = Math.random();

  if (roll < settings.tradeShare && bestBid !== undefined && bestAsk !== undefined) {
    // Trade between two bots at a price inside the spread where no order rests, so only they can match.
    const taken = new Set([...book.bids, ...book.asks].map((l: Level) => cents(Number(l.price))));
    const free: number[] = [];
    for (let c = bestBid + 1; c < bestAsk; c++) if (!taken.has(c)) free.push(c);
    if (!free.length) return;
    // Lean towards the reference rate so the price wanders but does not run away.
    const at = free.sort((a, b) => Math.abs(a - ref) - Math.abs(b - ref))[Math.floor(Math.random() ** 2 * free.length)];
    const other = pick(bots.filter((b) => b !== bot));
    const qty = lot(pair);
    const sellFirst = Math.random() < 0.5;
    const [maker, taker] = sellFirst ? [bot, other] : [other, bot];
    const makerSide = sellFirst ? 'SELL' : 'BUY';
    const order = { pair: pair.symbol, qty, price: price(at) };
    await maker.place({ ...order, side: makerSide });
    await taker.place({ ...order, side: makerSide === 'SELL' ? 'BUY' : 'SELL' });
    return;
  }

  const mine = (await bot.open()).filter((o) => o.pair === pair.symbol);
  if (roll < settings.tradeShare + settings.cancelShare && mine.length) {
    await bot.cancel(pick(mine).id);
    return;
  }

  // Passive order offsetBips away from the reference rate, never crossing the other side of the book.
  const side = Math.random() < 0.5 ? 'BUY' : 'SELL';
  const offset = Math.round(rand(settings.offsetBips.min, Math.max(settings.offsetBips.min, settings.offsetBips.max))) * bipCents;
  let at = side === 'BUY' ? ref - offset : ref + offset;
  if (side === 'BUY' && bestAsk !== undefined) at = Math.min(at, bestAsk - 2);
  if (side === 'SELL' && bestBid !== undefined) at = Math.max(at, bestBid + 2);
  const sameSide = mine.filter((o) => o.side === side).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const stale of sameSide.slice(0, Math.max(0, sameSide.length - settings.maxOrdersPerSide + 1))) await bot.cancel(stale.id);
  await bot.place({ pair: pair.symbol, side, qty: lot(pair), price: price(at) });
}

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => (stopping = true));
while (!stopping) {
  try {
    await refreshSettings();
    if (settings.enabled) await tick();
  } catch (e) {
    // A bot that hits the order rate limit (right after the seeder, say) or races another order skips this tick.
    if (!(e instanceof HttpError && e.status === 429)) console.warn(`tick skipped: ${(e as Error).message}`);
  }
  await sleep((settings?.intervalMs ?? 1500) * rand(0.5, 1.5));
}
