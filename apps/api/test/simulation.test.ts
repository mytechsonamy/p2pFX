import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, findPair, parseDecimal, parsePrice, type BankConfig } from '@p2p/shared';
import { simulate, syntheticScenario, type FlowEvent } from '../src/simulation.js';

const usd = findPair(DEFAULT_CONFIG, 'USDTRY')!;
const qty = (v: string) => parseDecimal(v, 2);
const prices = [{ t: 0, mid: parsePrice('49.15') }];
const config = (patch: (c: BankConfig) => void = () => {}) => {
  const c = structuredClone(DEFAULT_CONFIG);
  patch(c);
  return c;
};
const noBank = (c: BankConfig) => {
  c.channels.bankMarketMaker = false;
  c.channels.botMarketMaker = false;
};

describe('Phase 0 simulation', () => {
  it('matches two customers on the board as P2P and charges both their commission', async () => {
    const flow: FlowEvent[] = [
      { t: 0, customer: 'a', side: 'SELL', qty: qty('1000'), channel: 'BOARD', limitPips: 1000 },
      { t: 1, customer: 'b', side: 'BUY', qty: qty('1000'), channel: 'BOARD' },
    ];
    const r = await simulate({ config: config(noBank), pair: 'USDTRY', prices, flow });
    expect(r.volume.c2c).toBe(qty('1000'));
    expect(r.p2pMatchRatio).toBe(1);
    // 500 pips = 0.05 TRY per unit on each side.
    expect(r.fees).toBe(qty('100'));
    expect(r.fillRate).toBe(1);
  });

  it('never lets the bank trade with itself, and counts bank liquidity as C2B', async () => {
    const { prices: p, flow } = syntheticScenario({ pair: usd, start: parsePrice('49.15'), events: 400, seed: 11 });
    const r = await simulate({ config: config(), pair: 'USDTRY', prices: p, flow });
    expect(r.bankSelfTrades).toBe(0);
    expect(r.volume.c2bLadder + r.volume.c2bBot).toBeGreaterThan(0n);
    expect(r.p2pMatchRatio).toBeLessThan(1);
  });

  it('is deterministic for a seed and compares with the Direct-only baseline', async () => {
    const s = syntheticScenario({ pair: usd, start: parsePrice('49.15'), events: 300, seed: 5 });
    const a = await simulate({ config: config(), pair: 'USDTRY', ...s, seed: 1 });
    const b = await simulate({ config: config(), pair: 'USDTRY', ...s, seed: 1 });
    expect(a).toEqual(b);
    const direct = await simulate({ config: config(), pair: 'USDTRY', prices: s.prices, flow: s.flow.map((e) => ({ ...e, channel: 'DIRECT' as const })) });
    expect(direct.directMargin).toBe(direct.baseline.directMargin);
  });

  it('keeps the bank inside its inventory cap under one-sided flow', async () => {
    const s = syntheticScenario({ pair: usd, start: parsePrice('49.15'), events: 600, seed: 9, buyShare: 0.95 });
    const c = config((x) => {
      x.inventory.maxPosition = { USD: '20000' };
      x.dealing.autoHedge = false;
    });
    const r = await simulate({ config: c, pair: 'USDTRY', ...s });
    expect(r.peakInventory).toBeLessThanOrEqual(qty('20000'));
  });
});
