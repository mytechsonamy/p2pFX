import {
  applyRate,
  formatDecimal,
  formatPrice,
  parseDecimal,
  parsePrice,
  valueOf,
  type BankConfig,
  type PairConfig,
  type QuoteBreakdown,
  type RoundingMode,
  type Side,
} from '@p2p/shared';

/**
 * Everything needed to price one side of a trade. Stored on each order at entry
 * (as `PricingSnapshot`) so a customer's fills use the commission and tax they confirmed.
 */
export interface PricingParams {
  side: Side;
  baseDecimals: number;
  quoteDecimals: number;
  /** Commission per unit of base, in PRICE_SCALE units. */
  commissionPerUnit: bigint;
  /** Tax rate as a fraction, in PRICE_SCALE units. */
  taxRate: bigint;
  taxBase: 'effective' | 'book';
  rounding: RoundingMode;
}

export interface PricingSnapshot {
  side: Side;
  baseDecimals: number;
  quoteDecimals: number;
  commissionPerUnit: string;
  taxRate: string;
  taxBase: 'effective' | 'book';
  rounding: RoundingMode;
}

export function pricingParams(config: BankConfig, pair: PairConfig, side: Side): PricingParams {
  const bips = side === 'BUY' ? pair.commission.buyBips : pair.commission.sellBips;
  return {
    side,
    baseDecimals: pair.baseDecimals,
    quoteDecimals: pair.quoteDecimals,
    commissionPerUnit: BigInt(bips) * parsePrice(pair.bipSize),
    taxRate: parsePrice(side === 'BUY' ? config.tax.buyRate : config.tax.sellRate),
    taxBase: config.tax.base,
    rounding: config.rounding,
  };
}

export function toSnapshot(p: PricingParams): PricingSnapshot {
  return { ...p, commissionPerUnit: p.commissionPerUnit.toString(), taxRate: p.taxRate.toString() };
}

export function fromSnapshot(s: PricingSnapshot): PricingParams {
  return { ...s, commissionPerUnit: BigInt(s.commissionPerUnit), taxRate: BigInt(s.taxRate) };
}

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
 * commission = qty × commission per unit         (bank revenue for this side)
 * gross      = notional ± commission             (= qty × effective price)
 * tax        = (gross or notional) × tax rate    (kambiyo vergisi, per `taxBase`)
 * total      = BUY: gross + tax  |  SELL: gross − tax
 *
 * Each amount is rounded once, separately, so commission and tax are exact
 * figures that can be shown on the receipt and booked to the bank's accounts.
 */
export function priceSide(qty: bigint, bookPrice: bigint, p: PricingParams): SidePricing {
  const sign = p.side === 'BUY' ? 1n : -1n;
  const notional = valueOf(qty, p.baseDecimals, bookPrice, p.quoteDecimals, p.rounding);
  const commission = valueOf(qty, p.baseDecimals, p.commissionPerUnit, p.quoteDecimals, p.rounding);
  const gross = notional + sign * commission;
  const tax = applyRate(p.taxBase === 'effective' ? gross : notional, p.taxRate, p.rounding);
  return {
    side: p.side,
    qty,
    bookPrice,
    commissionPerUnit: p.commissionPerUnit,
    effectivePrice: bookPrice + sign * p.commissionPerUnit,
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
