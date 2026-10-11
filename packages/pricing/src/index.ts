import {
  applyRate,
  formatDecimal,
  formatPrice,
  parseDecimal,
  parsePrice,
  valueOf,
  type BankConfig,
  type FeeMode,
  type PairConfig,
  type QuoteBreakdown,
  type RoundingMode,
  type Side,
  taxRates,
} from '@p2p/shared';

/**
 * Everything needed to price one side of a trade. Stored on each order at entry
 * (as `PricingSnapshot`) so a customer's fills use the commission and tax they confirmed.
 */
export interface PricingParams {
  side: Side;
  baseDecimals: number;
  quoteDecimals: number;
  /** PIPS: a fixed commission per unit (`commissionPerUnit`). BPS: a share of the book price (`commissionRate`). */
  feeMode: FeeMode;
  /** PIPS mode: commission per unit of base, in PRICE_SCALE units. */
  commissionPerUnit: bigint;
  /** BPS mode: commission as a fraction of the book price, in PRICE_SCALE units (5 bps = 0.0005). */
  commissionRate: bigint;
  /** Tax rate as a fraction, in PRICE_SCALE units. */
  taxRate: bigint;
  taxBase: 'effective' | 'book';
  rounding: RoundingMode;
}

export interface PricingSnapshot {
  side: Side;
  baseDecimals: number;
  quoteDecimals: number;
  /** Absent on orders entered before fee modes existed (PIPS). */
  feeMode?: FeeMode;
  commissionPerUnit: string;
  commissionRate?: string;
  taxRate: string;
  taxBase: 'effective' | 'book';
  rounding: RoundingMode;
}

/** Basis points to a PRICE_SCALE fraction: 1 bp = 1/10 000. */
const BPS_DIVISOR = 10_000n;
const PRICE_SCALE_BIG = 10n ** 8n;
/** price × rate, both PRICE_SCALE, rounded half up to PRICE_SCALE. */
const perUnitAt = (price: bigint, rate: bigint) => (price * rate + PRICE_SCALE_BIG / 2n) / PRICE_SCALE_BIG;

/** The commission per unit of base a pair charges one side, at a given book price (PRICE_SCALE units). */
export function commissionPerUnitOf(pair: PairConfig, side: Side, bookPrice: bigint): bigint {
  const value = BigInt(side === 'BUY' ? pair.commission.buy : pair.commission.sell);
  if (pair.commission.mode === 'PIPS') return value * parsePrice(pair.pipSize);
  return perUnitAt(bookPrice, (value * PRICE_SCALE_BIG) / BPS_DIVISOR);
}

export function pricingParams(config: BankConfig, pair: PairConfig, side: Side): PricingParams {
  const value = BigInt(side === 'BUY' ? pair.commission.buy : pair.commission.sell);
  const pips = pair.commission.mode === 'PIPS';
  return {
    side,
    baseDecimals: pair.baseDecimals,
    quoteDecimals: pair.quoteDecimals,
    feeMode: pair.commission.mode,
    commissionPerUnit: pips ? value * parsePrice(pair.pipSize) : 0n,
    commissionRate: pips ? 0n : (value * PRICE_SCALE_BIG) / BPS_DIVISOR,
    taxRate: parsePrice(taxRates(config, pair)[side === 'BUY' ? 'buyRate' : 'sellRate']),
    taxBase: config.tax.base,
    rounding: config.rounding,
  };
}

export function toSnapshot(p: PricingParams): PricingSnapshot {
  return { ...p, commissionPerUnit: p.commissionPerUnit.toString(), commissionRate: p.commissionRate.toString(), taxRate: p.taxRate.toString() };
}

export function fromSnapshot(s: PricingSnapshot): PricingParams {
  return {
    ...s,
    feeMode: s.feeMode ?? 'PIPS',
    commissionPerUnit: BigInt(s.commissionPerUnit),
    commissionRate: BigInt(s.commissionRate ?? '0'),
    taxRate: BigInt(s.taxRate),
  };
}

/** The params with no commission (the bank's own orders, bank deals). */
export const withoutCommission = (p: PricingParams): PricingParams => ({ ...p, feeMode: 'PIPS', commissionPerUnit: 0n, commissionRate: 0n });

/** One side of a trade, all amounts in minor units of the quote currency. */
export interface SidePricing {
  side: Side;
  qty: bigint;
  bookPrice: bigint;
  commissionPerUnit: bigint;
  effectivePrice: bigint;
  notional: bigint;
  commission: bigint;
  gross: bigint;
  tax: bigint;
  /** BUY: what the customer pays. SELL: what the customer receives. */
  total: bigint;
}

/**
 * Prices one side of a trade.
 *
 * notional   = qty × book price
 * commission = qty × commission per unit         (bank revenue for this side; per unit = pips × pip size, or
 *                                                 book price × bps / 10 000)
 * gross      = notional ± commission             (= qty × effective price)
 * tax        = (gross or notional) × tax rate    (kambiyo vergisi, per `taxBase`)
 * total      = BUY: gross + tax  |  SELL: gross − tax
 *
 * Each amount is rounded once, separately, so commission and tax are exact
 * figures that can be shown on the receipt and booked to the bank's accounts.
 */
export function priceSide(qty: bigint, bookPrice: bigint, p: PricingParams): SidePricing {
  const sign = p.side === 'BUY' ? 1n : -1n;
  const perUnit = p.feeMode === 'BPS' ? perUnitAt(bookPrice, p.commissionRate) : p.commissionPerUnit;
  const notional = valueOf(qty, p.baseDecimals, bookPrice, p.quoteDecimals, p.rounding);
  const commission = valueOf(qty, p.baseDecimals, perUnit, p.quoteDecimals, p.rounding);
  const gross = notional + sign * commission;
  const tax = applyRate(p.taxBase === 'effective' ? gross : notional, p.taxRate, p.rounding);
  return {
    side: p.side,
    qty,
    bookPrice,
    commissionPerUnit: perUnit,
    effectivePrice: bookPrice + sign * perUnit,
    notional,
    commission,
    gross,
    tax,
    total: gross + sign * tax,
  };
}

export function toBreakdown(pair: PairConfig, s: SidePricing, p: PricingParams): QuoteBreakdown {
  const money = (v: bigint) => formatDecimal(v, pair.quoteDecimals);
  return {
    pair: pair.symbol,
    side: s.side,
    qty: formatDecimal(s.qty, pair.baseDecimals),
    bookPrice: formatPrice(s.bookPrice),
    commissionPerUnit: formatPrice(s.commissionPerUnit),
    effectivePrice: formatPrice(s.effectivePrice),
    notional: money(s.notional),
    commission: money(s.commission),
    gross: money(s.gross),
    taxRate: formatPrice(p.taxRate, 0),
    tax: money(s.tax),
    total: money(s.total),
    currency: pair.quote,
  };
}

export { parseDecimal };
