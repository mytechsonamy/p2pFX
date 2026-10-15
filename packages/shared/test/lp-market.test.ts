import { describe, expect, it } from 'vitest';
import { DEFAULT_LP_MARKET, isLpMarketOpen, nextLpMarketOpen } from '../src/index.js';

const m = DEFAULT_LP_MARKET;
const at = (iso: string) => new Date(iso);

describe('LP market hours', () => {
  it('follows the FX week: Sunday 17:00 to Friday 17:00 New York', () => {
    // October 2026: New York is on EDT (UTC−4), so 17:00 NY is 21:00 UTC.
    expect(isLpMarketOpen(at('2026-10-09T20:59:00Z'), m, 'fx')).toBe(true); // Friday
    expect(isLpMarketOpen(at('2026-10-09T21:00:00Z'), m, 'fx')).toBe(false);
    expect(isLpMarketOpen(at('2026-10-10T12:00:00Z'), m, 'fx')).toBe(false); // Saturday
    expect(isLpMarketOpen(at('2026-10-11T20:59:00Z'), m, 'fx')).toBe(false); // Sunday
    expect(isLpMarketOpen(at('2026-10-11T21:00:00Z'), m, 'fx')).toBe(true);
    expect(isLpMarketOpen(at('2026-10-14T03:00:00Z'), m, 'fx')).toBe(true); // midweek
  });

  it('closes metals for their daily break, and follows New York daylight saving', () => {
    expect(isLpMarketOpen(at('2026-10-13T21:30:00Z'), m, 'metal')).toBe(false); // Tuesday 17:30 NY
    expect(isLpMarketOpen(at('2026-10-13T21:30:00Z'), m, 'fx')).toBe(true);
    expect(isLpMarketOpen(at('2026-10-13T22:00:00Z'), m, 'metal')).toBe(true);
    // December: EST (UTC−5), 17:00 NY is 22:00 UTC.
    expect(isLpMarketOpen(at('2026-12-04T21:30:00Z'), m, 'fx')).toBe(true);
    expect(isLpMarketOpen(at('2026-12-04T22:00:00Z'), m, 'fx')).toBe(false);
  });

  it('closes on holidays and is always open when switched off', () => {
    const xmas = { ...m, holidays: ['2026-12-25'] };
    expect(isLpMarketOpen(at('2026-12-25T15:00:00Z'), xmas, 'fx')).toBe(false);
    expect(isLpMarketOpen(at('2026-10-10T12:00:00Z'), { ...m, enabled: false }, 'fx')).toBe(true);
  });

  it('finds the next opening to the minute', () => {
    expect(nextLpMarketOpen(at('2026-10-10T12:07:00Z'), m, 'fx')?.toISOString()).toBe('2026-10-11T21:00:00.000Z');
    expect(nextLpMarketOpen(at('2026-10-13T21:10:00Z'), m, 'metal')?.toISOString()).toBe('2026-10-13T22:00:00.000Z');
    // A holiday closes the whole New York date: Thursday 24 December reopens at midnight NY (05:00 UTC).
    const eve = { ...m, holidays: ['2026-12-24'] };
    expect(nextLpMarketOpen(at('2026-12-24T15:00:00Z'), eve, 'fx')?.toISOString()).toBe('2026-12-25T05:00:00.000Z');
    // Friday 25 December reopens with the new week on Sunday 17:00 NY.
    const xmas = { ...m, holidays: ['2026-12-25'] };
    expect(nextLpMarketOpen(at('2026-12-25T15:00:00Z'), xmas, 'fx')?.toISOString()).toBe('2026-12-27T22:00:00.000Z');
  });
});
