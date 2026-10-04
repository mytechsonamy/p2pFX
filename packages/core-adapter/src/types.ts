/** The interface each bank implements to connect its core banking system. */

export interface CoreAccount {
  id: string;
  customerRef: string;
  currency: string;
  /** Decimal places of the currency (2 for TRY, USD, EUR, GBP). */
  decimals: number;
  name: string;
  iban?: string;
  /** Ledger balance in minor units. */
  balance: bigint;
  /** Sum of active holds in minor units. */
  held: bigint;
  /** balance − held */
  available: bigint;
}

export type CoreErrorCode = 'INSUFFICIENT_FUNDS' | 'NOT_FOUND' | 'INVALID_REQUEST' | 'UNAVAILABLE';

export class CoreBankingError extends Error {
  constructor(
    public readonly code: CoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CoreBankingError';
  }
}

/** Leg of a fill: the bank buys FX from the seller, or sells FX to the buyer. */
export type FxLeg = 'BANK_BUY' | 'BANK_SELL';

export interface FxTransactionRequest {
  leg: FxLeg;
  customerRef: string;
  fxAccountId: string;
  tryAccountId: string;
  /** Base (FX) currency, e.g. USD. */
  currency: string;
  /** Quote currency, e.g. TRY. */
  quoteCurrency: string;
  /** FX quantity in minor units. */
  qty: bigint;
  /** Book price and the customer's effective price, decimal strings. */
  bookPrice: string;
  effectivePrice: string;
  /** Quote-currency amounts in minor units. */
  notional: bigint;
  commission: bigint;
  tax: bigint;
  /** BANK_BUY: credited to the customer (notional − commission − tax). BANK_SELL: debited (notional + commission + tax). */
  customerAmount: bigint;
  /** Holds to capture the debit from (FX hold for BANK_BUY, TRY hold for BANK_SELL). */
  holdIds: string[];
  /** Same key → same transaction; retries are safe. */
  idempotencyKey: string;
  /** Platform reference shown on the receipt (fill id). */
  reference: string;
}

export interface FxTransactionResult {
  txnRef: string;
  receiptRef: string;
  postedAt: string;
}

export interface Receipt {
  receiptRef: string;
  txnRef: string;
  title: string;
  customerRef: string;
  lines: { label: string; value: string }[];
  postedAt: string;
  reversed: boolean;
}

export interface ReferenceRate {
  pair: string;
  rate: string;
  asOf: string;
}

export interface CoreBankingAdapter {
  getAccounts(customerRef: string): Promise<CoreAccount[]>;
  placeHold(accountId: string, amount: bigint, ref: string): Promise<{ holdId: string }>;
  /** Sets the hold to a new amount (used to release excess after a fill). */
  adjustHold(holdId: string, newAmount: bigint): Promise<void>;
  releaseHold(holdId: string): Promise<void>;
  postFxTransaction(req: FxTransactionRequest): Promise<FxTransactionResult>;
  reverseFxTransaction(txnRef: string, idempotencyKey: string): Promise<{ reversalRef: string }>;
  getReceipt(receiptRef: string): Promise<Receipt>;
  getReferenceRate(pair: string): Promise<ReferenceRate>;
  notify(customerRef: string, event: { type: string; title: string; body: string; data?: unknown }): Promise<void>;
}
