import { afterEach, describe, expect, it } from 'vitest';
import { LiquidityError, MockCoreBank } from '@p2p/core-adapter';
import { OPS, startHarness, type Harness } from './helpers.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
  h = undefined as unknown as Harness;
});

/** LPs that quote only USDTRY and the dollar crosses, like interbank LPs: gram gold and CHFTRY are synthetic. */
async function interbank() {
  const bank = new MockCoreBank();
  bank.setReferenceRate('USDTRY', '49.15');
  bank.setReferenceRate('XAUTRY', '6320.00');
  bank.setReferenceRate('CHFTRY', '57.20');
  return startHarness({ bank, interbank: true });
}

describe('synthetic crosses', () => {
  it('prices gram gold from XAUUSD and USDTRY and hedges it in two legs', async () => {
    h = await interbank();
    h.customer('ayse', { XAU: '0', TRY: '0' });
    const ayse = await h.login('ayse');
    const rates = (await h.req('GET', '/v1/bank/rates/XAUTRY', ayse)).body;
    // Both LP spreads (0.012 % each side) and the bank margin (10 bips of 1 TRY): within 0.3 % of the reference.
    expect(Number(rates.buy)).toBeGreaterThan(6320);
    expect(Number(rates.sell)).toBeLessThan(6320);
    expect(Math.abs(Number(rates.buy) / 6320 - 1)).toBeLessThan(0.003);

    const res = await h.req('POST', '/ops/dealing/hedges', OPS, { pair: 'XAUTRY', side: 'BUY', qty: '100' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ qty: '100.00', unknown: '0.00', clips: [expect.objectContaining({ lp: 'LP-A+LP-A', status: 'DONE' })] });
    expect(Number(res.body.clips[0].rate)).toBeCloseTo(6320 * 1.00012 * 1.00012, 0);
    expect(h.liquidity.executionCount).toBe(2);
  });

  it('keeps a clip open when only the cross traded and confirms it once the funding leg is done', async () => {
    h = await interbank();
    const execute = h.liquidity.execute.bind(h.liquidity);
    h.liquidity.execute = async (r) => {
      if (r.pair === 'USDTRY') throw new LiquidityError('USDTRY rejected');
      return execute(r);
    };
    const res = await h.req('POST', '/ops/dealing/hedges', OPS, { pair: 'CHFTRY', side: 'SELL', qty: '1000' });
    expect(res.body).toMatchObject({ qty: '0.00', unknown: '1000.00' });
    expect(h.liquidity.executionCount).toBe(1);
    // The open clip counts in the position, and is not sent anywhere else.
    let dealer = (await h.req('GET', '/ops/dealing', OPS)).body;
    expect(dealer.hedges).toEqual([expect.objectContaining({ pair: 'CHFTRY', status: 'UNKNOWN' })]);

    h.liquidity.execute = execute;
    expect((await h.req('POST', '/ops/dealing/hedges', OPS, { pair: 'CHFTRY', side: 'SELL', qty: '1' })).status).toBe(200);
    dealer = (await h.req('GET', '/ops/dealing', OPS)).body;
    const first = dealer.hedges.find((x: { qty: string }) => x.qty === '1000.00');
    expect(first).toMatchObject({ status: 'DONE', lp: expect.stringContaining('+') });
    expect(Number(first.rate)).toBeCloseTo(57.2, 0);
  });
});
