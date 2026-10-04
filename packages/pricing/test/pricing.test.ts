import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, parseDecimal, parsePrice, type BankConfig } from '@p2p/shared';
import { priceSide, pricingParams, toBreakdown, fromSnapshot, toSnapshot } from '../src/index.js';

const usd = DEFAULT_CONFIG.pairs[0];
const qty1000 = parseDecimal('1000', 2);

function cfg(over: Partial<BankConfig['tax']> = {}, rounding: BankConfig['rounding'] = 'HALF_UP'): BankConfig {
  return { ...DEFAULT_CONFIG, rounding, tax: { ...DEFAULT_CONFIG.tax, ...over } };
}

describe('priceSide', () => {
  it('matches the worked example: 1,000 USD at 49.15 with 5 bips per side', () => {
    const c = cfg({ buyRate: '0.002', sellRate: '0.002' });
    const buy = toBreakdown(usd, priceSide(qty1000, parsePrice('49.15'), pricingParams(c, usd, 'BUY')), pricingParams(c, usd, 'BUY'));
    const sell = toBreakdown(usd, priceSide(qty1000, parsePrice('49.15'), pricingParams(c, usd, 'SELL')), pricingParams(c, usd, 'SELL'));

    expect(buy).toMatchObject({
      bookPrice: '49.15',
      commissionPerUnit: '0.05',
      effectivePrice: '49.20',
      notional: '49150.00',
      commission: '50.00',
      gross: '49200.00',
      tax: '98.40',
      total: '49298.40',
    });
    expect(sell).toMatchObject({
      effectivePrice: '49.10',
      commission: '50.00',
      gross: '49100.00',
      tax: '98.20',
      total: '49001.80',
    });
  });

  it('bank earns commission on both sides; buyer and seller flows balance against the bank', () => {
    const c = cfg();
    const price = parsePrice('49.1537');
    const qty = parseDecimal('1234.56', 2);
    const b = priceSide(qty, price, pricingParams(c, usd, 'BUY'));
    const s = priceSide(qty, price, pricingParams(c, usd, 'SELL'));
    // buyer pays = seller receives + commissions + taxes
    expect(b.total - s.total).toBe(b.commission + s.commission + b.tax + s.tax);
    expect(b.notional).toBe(s.notional);
  });

  it('can tax the book value instead of the effective value', () => {
    const c = cfg({ base: 'book', buyRate: '0.01', sellRate: '0.01' });
    const b = priceSide(qty1000, parsePrice('49.15'), pricingParams(c, usd, 'BUY'));
    expect(b.tax).toBe(49150n); // 491.50 TRY = 1% of 49,150.00
  });

  it('applies the configured rounding mode', () => {
    // 0.5 kuruş tax: 2.50 TRY gross × 0.002 = 0.005
    const pair = { ...usd, commission: { buyBips: 0, sellBips: 0 } };
    const qty = parseDecimal('1', 2);
    const price = parsePrice('2.5');
    const tax = (r: BankConfig['rounding']) => priceSide(qty, price, pricingParams(cfg({}, r), pair, 'BUY')).tax;
    expect(tax('HALF_UP')).toBe(1n);
    expect(tax('HALF_EVEN')).toBe(0n);
    expect(tax('DOWN')).toBe(0n);
    expect(tax('UP')).toBe(1n);
  });

  it('round-trips the pricing snapshot', () => {
    const p = pricingParams(DEFAULT_CONFIG, usd, 'SELL');
    expect(fromSnapshot(JSON.parse(JSON.stringify(toSnapshot(p))))).toEqual(p);
  });
});
