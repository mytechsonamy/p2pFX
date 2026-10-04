// Fixed-point helpers. No floating point is used anywhere near money.
//
// - Amounts (FX quantities, TRY values) are bigint minor units of their currency
//   (e.g. cents, kuruş), with the number of decimals coming from configuration.
// - Prices and rates are bigint "units" with a fixed scale of 1e-8
//   (PRICE_SCALE), so 49.15 is 4_915_000_000n.

export const PRICE_DECIMALS = 8;
export const PRICE_SCALE = 10n ** BigInt(PRICE_DECIMALS);

export type RoundingMode = 'HALF_UP' | 'HALF_EVEN' | 'DOWN' | 'UP';

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

/** Parses a decimal string into a scaled bigint. Throws if it has more decimals than allowed. */
export function parseDecimal(value: string, decimals: number): bigint {
  const s = value.trim();
  if (!DECIMAL_RE.test(s)) throw new RangeError(`not a decimal number: "${value}"`);
  const negative = s.startsWith('-');
  const [intPart, fracPart = ''] = (negative ? s.slice(1) : s).split('.');
  const trimmedFrac = fracPart.replace(/0+$/, '');
  if (trimmedFrac.length > decimals) {
    throw new RangeError(`"${value}" has more than ${decimals} decimal places`);
  }
  const units = BigInt(intPart) * 10n ** BigInt(decimals) + BigInt(trimmedFrac.padEnd(decimals, '0') || '0');
  return negative ? -units : units;
}

/** Formats a scaled bigint as a decimal string with at least `minDecimals` decimals. */
export function formatDecimal(units: bigint, decimals: number, minDecimals = decimals): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const scale = 10n ** BigInt(decimals);
  const intPart = (abs / scale).toString();
  let frac = decimals > 0 ? (abs % scale).toString().padStart(decimals, '0') : '';
  while (frac.length > minDecimals && frac.endsWith('0')) frac = frac.slice(0, -1);
  return (negative ? '-' : '') + intPart + (frac.length ? '.' + frac : '');
}

export const parsePrice = (value: string) => parseDecimal(value, PRICE_DECIMALS);
export const formatPrice = (units: bigint, minDecimals = 2) => formatDecimal(units, PRICE_DECIMALS, minDecimals);

/** Integer division of a / b (b > 0) with the given rounding mode. */
export function divRound(a: bigint, b: bigint, mode: RoundingMode): bigint {
  if (b <= 0n) throw new RangeError('divisor must be positive');
  const negative = a < 0n;
  const abs = negative ? -a : a;
  let q = abs / b;
  const r = abs % b;
  if (r !== 0n) {
    switch (mode) {
      case 'DOWN':
        break;
      case 'UP':
        q += 1n;
        break;
      case 'HALF_UP':
        if (r * 2n >= b) q += 1n;
        break;
      case 'HALF_EVEN':
        if (r * 2n > b || (r * 2n === b && q % 2n === 1n)) q += 1n;
        break;
    }
  }
  return negative ? -q : q;
}

/**
 * Value of `qty` (minor units with `qtyDecimals`) at `price` (PRICE_SCALE units),
 * in minor units of the quote currency (`quoteDecimals`), rounded once.
 */
export function valueOf(
  qty: bigint,
  qtyDecimals: number,
  price: bigint,
  quoteDecimals: number,
  mode: RoundingMode,
): bigint {
  const exp = qtyDecimals + PRICE_DECIMALS - quoteDecimals;
  if (exp < 0) return qty * price * 10n ** BigInt(-exp);
  return divRound(qty * price, 10n ** BigInt(exp), mode);
}

/** amount × rate (rate in PRICE_SCALE units), rounded once. */
export function applyRate(amount: bigint, rate: bigint, mode: RoundingMode): bigint {
  return divRound(amount * rate, PRICE_SCALE, mode);
}

export const minBig = (a: bigint, b: bigint) => (a < b ? a : b);
export const maxBig = (a: bigint, b: bigint) => (a > b ? a : b);
