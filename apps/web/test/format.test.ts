import { describe, expect, it } from 'vitest';
import { compareDecimal, formatDecimal, formatPrice, formatRate, sanitizeAmountInput, toApiDecimal, toInputText } from '../src/format';
import { endOfDay, localDate } from '../src/time';
import { createTranslator } from '../src/i18n';
import { mergeBranding, themeVars } from '../src/theme';

describe('formatting', () => {
  it('formats decimal strings in Turkish without float rounding', () => {
    expect(formatDecimal('49298.4', 'tr-TR')).toBe('49.298,40');
    expect(formatDecimal('1000000.00', 'tr-TR')).toBe('1.000.000,00');
    expect(formatDecimal('0.05', 'tr-TR')).toBe('0,05');
    expect(formatDecimal('12345678901234567.89', 'tr-TR')).toBe('12.345.678.901.234.567,89');
    expect(formatDecimal('49298.4', 'en-US')).toBe('49,298.40');
  });

  it('shows rates with four fraction digits', () => {
    expect(formatPrice('49.15', 'tr-TR')).toBe('49,1500');
    expect(formatPrice('49.1525', 'tr-TR')).toBe('49,1525');
    expect(formatPrice('49.1500', 'tr-TR')).toBe('49,1500');
    expect(formatPrice('49', 'tr-TR')).toBe('49,0000');
  });

  it('formats the tax rate as a percentage', () => {
    expect(formatRate('0.002', 'tr-TR')).toBe('%0,2');
    expect(formatRate('0.002', 'en-US')).toBe('0.2%');
  });
});

describe('amount input', () => {
  it('keeps digits and one decimal separator', () => {
    expect(sanitizeAmountInput('1.000,50', 2)).toBe('1.00');
    expect(sanitizeAmountInput('1000,505', 2)).toBe('1000,50');
    expect(sanitizeAmountInput('abc12', 2)).toBe('12');
    expect(sanitizeAmountInput(',5', 2)).toBe('0,5');
    expect(sanitizeAmountInput('10,5', 0)).toBe('105');
  });

  it('converts input text to API decimals', () => {
    expect(toApiDecimal('1000,50')).toBe('1000.5');
    expect(toApiDecimal('49.15')).toBe('49.15');
    expect(toApiDecimal('0050')).toBe('50');
    expect(toApiDecimal('0')).toBeUndefined();
    expect(toApiDecimal('0,00')).toBeUndefined();
    expect(toApiDecimal('12,')).toBeUndefined();
    expect(toApiDecimal('')).toBeUndefined();
    expect(toInputText('49.15', 'tr-TR')).toBe('49,15');
  });

  it('compares decimals exactly', () => {
    expect(compareDecimal('49298.40', '49298.4')).toBe(0);
    expect(compareDecimal('100000.00', '49298.40')).toBe(1);
    expect(compareDecimal('0.1', '0.10000001')).toBe(-1);
  });
});

describe('validity dates', () => {
  it('ends a GTD order at 23:59:59 Istanbul time', () => {
    expect(endOfDay('2026-10-10', 'Europe/Istanbul')).toBe('2026-10-10T23:59:59+03:00');
    expect(endOfDay('2026-01-10', 'Europe/London')).toBe('2026-01-10T23:59:59+00:00');
    expect(endOfDay('2026-07-10', 'Europe/London')).toBe('2026-07-10T23:59:59+01:00');
  });

  it('computes local dates in the bank time zone', () => {
    const lateUtc = new Date('2026-10-04T22:30:00Z'); // 01:30 on 5 October in Istanbul
    expect(localDate('Europe/Istanbul', 0, lateUtc)).toBe('2026-10-05');
    expect(localDate('Europe/Istanbul', 30, lateUtc)).toBe('2026-11-04');
  });
});

describe('strings and theme', () => {
  it('uses Turkish by default, English for en locales, and bank overrides on top', () => {
    expect(createTranslator('tr-TR')('confirm.submit')).toBe('Onayla');
    expect(createTranslator('en-GB')('confirm.submit')).toBe('Confirm');
    expect(createTranslator('tr-TR', { 'confirm.submit': 'Emri gönder' })('confirm.submit')).toBe('Emri gönder');
    expect(createTranslator('tr-TR')('ticket.buyTitle', { base: 'USD' })).toBe('USD al');
  });

  it('maps branding to CSS variables and merges a preview', () => {
    const base = { productName: 'Döviz Pazarı', colors: { primary: '#0B5FFF', buy: '#059669' }, radius: 12, locale: 'tr-TR', strings: {} };
    expect(themeVars(base)['--c-primary']).toBe('#0B5FFF');
    expect(themeVars(base)['--radius']).toBe('12px');
    const merged = mergeBranding(base, { productName: 'Yıldız Döviz', colors: { primary: '#14532D' }, radius: 4 });
    expect(merged).toMatchObject({ productName: 'Yıldız Döviz', radius: 4, colors: { primary: '#14532D', buy: '#059669' }, locale: 'tr-TR' });
  });
});

describe('market board', () => {
  it('adds decimals exactly', async () => {
    const { addDecimal } = await import('../src/format');
    expect(addDecimal('1000.50', '0.25', 2)).toBe('1000.75');
    expect(addDecimal('49.20', '-49.15', 4)).toBe('0.0500');
    expect(addDecimal('49.15', '-49.20', 4)).toBe('-0.0500');
  });

  it('folds a trade into the day statistics', async () => {
    const { applyTrade } = await import('../src/store');
    const trade = (price: string, qty: string) => ({ id: price + qty, pair: 'USDTRY', price, qty, takerSide: 'BUY' as const, at: '' });
    let s = applyTrade(undefined, trade('49.15', '100'), 2);
    s = applyTrade(s, trade('49.30', '50.5'), 2);
    s = applyTrade(s, trade('49.10', '10'), 2);
    expect(s).toMatchObject({ open: '49.15', high: '49.30', low: '49.10', last: '49.10', volume: '160.50', trades: 3 });
  });
});
