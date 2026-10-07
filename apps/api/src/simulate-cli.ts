/**
 * Phase 0 simulation: runs a synthetic day (or a replayed flow, `--flow file.json`) through the matching engine
 * under several scenarios and prints a sensitivity table against the Direct-only baseline.
 *
 *   pnpm simulate                       # default scenarios on USDTRY
 *   pnpm simulate -- --events 5000 --seed 3 --buy-share 0.8
 *   pnpm simulate -- --flow flow.json   # { prices: [{ t, mid }], flow: [{ t, customer, side, qty, channel, limitPips? }] } in decimals
 */
import { readFileSync } from 'node:fs';
import { DEFAULT_CONFIG, findPair, formatDecimal, parseDecimal, parsePrice, type BankConfig } from '@p2p/shared';
import { simulate, syntheticScenario, type FlowEvent, type PricePoint } from './simulation.js';

const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const pairSymbol = arg('pair', 'USDTRY');
const pair = findPair(DEFAULT_CONFIG, pairSymbol);
if (!pair) throw new Error(`unknown pair ${pairSymbol}`);

let data: { prices: PricePoint[]; flow: FlowEvent[] };
const file = arg('flow', '');
if (file) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  data = {
    prices: raw.prices.map((p: { t: number; mid: string }) => ({ t: p.t, mid: parsePrice(p.mid) })),
    flow: raw.flow.map((e: FlowEvent & { qty: string }) => ({ ...e, qty: parseDecimal(e.qty, pair.baseDecimals) })),
  };
} else {
  data = syntheticScenario({
    pair,
    start: parsePrice(arg('start', '49.15')),
    events: Number(arg('events', '2000')),
    seed: Number(arg('seed', '7')),
    buyShare: Number(arg('buy-share', '0.5')),
    boardShare: Number(arg('board-share', '0.6')),
    volatility: Number(arg('volatility', '0.0001')),
  });
}

const scenario = (name: string, patch: (c: BankConfig) => void) => {
  const c = structuredClone(DEFAULT_CONFIG);
  patch(c);
  return { name, config: c };
};
const scenarios = [
  scenario('Ladder + bot (default)', () => {}),
  scenario('Ladder only', (c) => (c.channels.botMarketMaker = false)),
  scenario('Bot only', (c) => (c.channels.bankMarketMaker = false)),
  scenario('Customers only (no bank liquidity)', (c) => {
    c.channels.bankMarketMaker = false;
    c.channels.botMarketMaker = false;
  }),
  scenario('Fee 300 pips', (c) => (c.pairs = c.pairs.map((p) => ({ ...p, commission: { mode: 'PIPS' as const, buy: 300, sell: 300 } })))),
  scenario('Fee 10 bps', (c) => (c.pairs = c.pairs.map((p) => ({ ...p, commission: { mode: 'BPS' as const, buy: 10, sell: 10 } })))),
];

const q = (v: bigint) => formatDecimal(v, pair.quoteDecimals);
const b = (v: bigint) => formatDecimal(v, pair.baseDecimals);
const rows = [];
for (const s of scenarios) {
  const r = await simulate({ config: s.config, pair: pairSymbol, ...data });
  rows.push({
    scenario: s.name,
    fillRate: `${(r.fillRate * 100).toFixed(1)}%`,
    p2pRatio: `${(r.p2pMatchRatio * 100).toFixed(1)}%`,
    c2c: b(r.volume.c2c),
    c2b: b(r.volume.c2bLadder + r.volume.c2bBot),
    direct: b(r.volume.direct),
    fees: q(r.fees),
    netPerLeg: q(r.netRevenuePerLeg),
    baselinePerLeg: q(r.baseline.netRevenuePerLeg),
    improvement: q(r.priceImprovement),
    peakInventory: b(r.peakInventory),
    hedges: r.hedges,
  });
}
console.log(`P2PFX Phase 0 simulation: ${pairSymbol}, ${data.flow.length} customer instructions${file ? ` from ${file}` : ' (synthetic)'}`);
console.table(rows);
console.log('Limit prices of a synthetic flow are assumptions (pips better than Direct), not observed demand.');
