import { describe, expect, it } from 'vitest';
import { currentOrNextSessionClose, divRound, formatDecimal, isMarketOpen, parseDecimal, valueOf, parsePrice, DEFAULT_CONFIG } from '../src/index.js';

describe('money', () => {
  it('parses and formats decimals', () => {
    expect(parseDecimal('49.15', 8)).toBe(4_915_000_000n);
    expect(parseDecimal('1000', 2)).toBe(100_000n);
    expect(() => parseDecimal('1.234', 2)).toThrow();
    expect(parseDecimal('1.230', 2)).toBe(123n);
    expect(formatDecimal(4_915_000_000n, 8, 2)).toBe('49.15');
    expect(formatDecimal(-5n, 2)).toBe('-0.05');
  });

  it('rounds', () => {
    expect(divRound(15n, 10n, 'HALF_UP')).toBe(2n);
    expect(divRound(25n, 10n, 'HALF_EVEN')).toBe(2n);
    expect(divRound(35n, 10n, 'HALF_EVEN')).toBe(4n);
    expect(divRound(-15n, 10n, 'HALF_UP')).toBe(-2n);
    expect(divRound(11n, 10n, 'UP')).toBe(2n);
  });

  it('computes value of qty at price in quote minor units', () => {
    expect(valueOf(parseDecimal('1000', 2), 2, parsePrice('49.15'), 2, 'HALF_UP')).toBe(4_915_000n);
    expect(valueOf(parseDecimal('0.01', 2), 2, parsePrice('49.155'), 2, 'HALF_UP')).toBe(49n);
  });
});

describe('trading hours', () => {
  const hours = { ...DEFAULT_CONFIG.tradingHours, days: [1, 2, 3, 4, 5], open: '09:00', close: '18:00', holidays: ['2026-10-29'] };

  it('knows when the market is open in Istanbul time', () => {
    expect(isMarketOpen(new Date('2026-10-05T06:00:00Z'), hours)).toBe(true); // Mon 09:00 TRT
    expect(isMarketOpen(new Date('2026-10-05T05:59:00Z'), hours)).toBe(false);
    expect(isMarketOpen(new Date('2026-10-05T15:00:00Z'), hours)).toBe(false); // 18:00 TRT
    expect(isMarketOpen(new Date('2026-10-04T10:00:00Z'), hours)).toBe(false); // Sunday
    expect(isMarketOpen(new Date('2026-10-29T10:00:00Z'), hours)).toBe(false); // holiday
  });

  it('finds the session close for DAY orders', () => {
    expect(currentOrNextSessionClose(new Date('2026-10-05T10:00:00Z'), hours).toISOString()).toBe('2026-10-05T15:00:00.000Z');
    // Saturday: next session is Monday
    expect(currentOrNextSessionClose(new Date('2026-10-03T10:00:00Z'), hours).toISOString()).toBe('2026-10-05T15:00:00.000Z');
    // 24:00 close means local midnight
    const allDay = { ...hours, days: [1, 2, 3, 4, 5, 6, 7], open: '00:00', close: '24:00' };
    expect(currentOrNextSessionClose(new Date('2026-10-04T10:00:00Z'), allDay).toISOString()).toBe('2026-10-04T21:00:00.000Z');
  });
});
