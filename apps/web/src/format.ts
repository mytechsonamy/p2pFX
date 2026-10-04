// Display and input helpers for decimal strings. Amounts come from the API as exact decimal strings,
// so they are formatted as text and compared as scaled bigints, never as floats.

const separators = new Map<string, { group: string; decimal: string }>();
function seps(locale: string) {
  let s = separators.get(locale);
  if (!s) {
    const parts = new Intl.NumberFormat(locale).formatToParts(12345.6);
    s = {
      group: parts.find((p) => p.type === 'group')?.value ?? ',',
      decimal: parts.find((p) => p.type === 'decimal')?.value ?? '.',
    };
    separators.set(locale, s);
  }
  return s;
}

/**
 * Formats a decimal string for display: `formatDecimal('49298.4', 'tr-TR', 2)` → `49.298,40`.
 * Shows at least `minFraction` and at most `maxFraction` fraction digits; extra digits are truncated, not rounded,
 * because the API has already rounded money.
 */
export function formatDecimal(value: string, locale: string, minFraction = 2, maxFraction = minFraction): string {
  const neg = value.startsWith('-');
  const [int = '0', frac = ''] = (neg ? value.slice(1) : value).split('.');
  const { group, decimal } = seps(locale);
  const grouped = int.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, group);
  let f = frac.slice(0, maxFraction);
  while (f.length > minFraction && f.endsWith('0')) f = f.slice(0, -1);
  f = f.padEnd(minFraction, '0');
  return (neg ? '-' : '') + grouped + (f ? decimal + f : '');
}

/** Prices: 2 to 4 fraction digits (tick size is 0.0001). */
export const formatPrice = (value: string, locale: string) => formatDecimal(value, locale, 2, 4);
/** Bank dealing rates always carry four decimals so the live price does not jump in width. */
export const formatBankRate = (value: string, locale: string) => formatDecimal(value, locale, 4);

export function formatMoney(value: string, currency: string, locale: string, decimals = 2) {
  return `${formatDecimal(value, locale, decimals)} ${currencySymbol(currency)}`;
}

export function currencySymbol(currency: string) {
  return ({ TRY: 'TL', USD: 'USD', EUR: 'EUR', GBP: 'GBP' } as Record<string, string>)[currency] ?? currency;
}

/** `0.002` → `%0,2` in Turkish, `0.2%` in English. */
export function formatRate(fraction: string, locale: string) {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 4 }).format(Number(fraction));
}

export function formatDateTime(iso: string, locale: string, timeZone = 'Europe/Istanbul') {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short', timeZone }).format(new Date(iso));
}

/**
 * Keeps what the customer types in an amount field to digits and one decimal separator ("," or "."),
 * with at most `maxFraction` fraction digits. No thousands separators while typing.
 */
export function sanitizeAmountInput(text: string, maxFraction: number): string {
  let out = '';
  let sep = false;
  let frac = 0;
  for (const ch of text) {
    if (ch >= '0' && ch <= '9') {
      if (sep) {
        if (frac >= maxFraction) continue;
        frac++;
      }
      out += ch;
    } else if ((ch === ',' || ch === '.') && !sep && maxFraction > 0) {
      sep = true;
      out += out === '' ? '0' + ch : ch;
    }
  }
  return out;
}

/** Input text → API decimal string ("1000,5" → "1000.5"), or undefined if it is not a positive number. */
export function toApiDecimal(text: string): string | undefined {
  const v = text.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(v)) return undefined;
  const normal = v.replace(/^0+(?=\d)/, '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return /^0(\.0*)?$/.test(normal) ? undefined : normal;
}

/** API decimal string → text for an input field in the customer's locale ("49.15" → "49,15"). */
export function toInputText(value: string, locale: string) {
  return value.replace('.', seps(locale).decimal);
}

const SCALE = 8;
function scaled(v: string): bigint {
  const neg = v.startsWith('-');
  const [i = '0', f = ''] = (neg ? v.slice(1) : v).split('.');
  const n = BigInt(i || '0') * 10n ** BigInt(SCALE) + BigInt((f + '0'.repeat(SCALE)).slice(0, SCALE) || '0');
  return neg ? -n : n;
}

/** Compares two decimal strings exactly: -1, 0 or 1. */
export function compareDecimal(a: string, b: string): number {
  const d = scaled(a) - scaled(b);
  return d === 0n ? 0 : d < 0n ? -1 : 1;
}

/** Exact sum of two decimal strings, with `decimals` fraction digits. */
export function addDecimal(a: string, b: string, decimals: number): string {
  const n = scaled(a) + scaled(b);
  const neg = n < 0n;
  const abs = (neg ? -n : n).toString().padStart(SCALE + 1, '0');
  const int = abs.slice(0, -SCALE);
  const frac = abs.slice(-SCALE).slice(0, decimals);
  return (neg ? '-' : '') + int + (decimals ? '.' + frac : '');
}
