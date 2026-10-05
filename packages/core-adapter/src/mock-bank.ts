import { INSTRUMENTS, formatDecimal } from '@p2p/shared';
import {
  CoreBankingError,
  type CoreAccount,
  type CoreBankingAdapter,
  type FxTransactionRequest,
  type FxTransactionResult,
  type Receipt,
  type ReferenceRate,
} from './types.js';

interface Account {
  id: string;
  customerRef: string;
  currency: string;
  decimals: number;
  name: string;
  iban?: string;
  balance: bigint;
  /** Bank-internal accounts may go negative (FX position, clearing). */
  allowNegative: boolean;
}

interface Hold {
  id: string;
  accountId: string;
  amount: bigint;
  ref: string;
  active: boolean;
}

export interface StatementEntry {
  at: string;
  accountId: string;
  amount: bigint;
  description: string;
  txnRef: string;
}

interface Txn {
  txnRef: string;
  receiptRef: string;
  postedAt: string;
  entries: StatementEntry[];
  reversed: boolean;
  request: FxTransactionRequest;
}

export const BANK_REF = 'BANK';

/** Account decimals: grams to 0.01 for metals, none for JPY, 2 otherwise. */
export const decimalsOf = (ccy: string) => INSTRUMENTS[ccy]?.decimals ?? 2;
const accountName = (ccy: string) => {
  const i = INSTRUMENTS[ccy];
  return i?.kind === 'metal' ? `${i.name.replace(/ \(gram\)$/, '')} Hesabı (gr)` : `${ccy} Vadesiz`;
};

/**
 * In-memory core banking system for the prototype and tests: customer accounts,
 * holds (bloke), FX buy/sell postings with receipts (dekont), reversals and
 * reference rates. The `mock-core` app serves it over HTTP.
 */
export class MockCoreBank implements CoreBankingAdapter {
  private accounts = new Map<string, Account>();
  private holds = new Map<string, Hold>();
  private txnsByKey = new Map<string, Txn>();
  private txnsByRef = new Map<string, Txn>();
  private reversalsByKey = new Map<string, string>();
  private statement: StatementEntry[] = [];
  private rates = new Map<string, ReferenceRate>();
  readonly notifications: { customerRef: string; event: { type: string; title: string; body: string; data?: unknown } }[] = [];
  private seq = 0;
  /** Fault injection for tests and demos: the next N postings fail with UNAVAILABLE. */
  failNextPostings = 0;
  /** When set, the injected faults only hit postings for these customers (others keep settling). */
  faultCustomers: Set<string> | undefined;

  private nextId(prefix: string) {
    return `${prefix}-${String(++this.seq).padStart(6, '0')}`;
  }

  // ---- setup (not part of the adapter interface) ----

  createAccount(customerRef: string, currency: string, balance: bigint, name?: string): CoreAccount {
    const id = this.nextId(`ACC-${currency}`);
    const acc: Account = {
      id,
      customerRef,
      currency,
      decimals: decimalsOf(currency),
      name: name ?? accountName(currency),
      iban: currency === 'TRY' ? `TR${String(this.seq).padStart(24, '0')}` : undefined,
      balance,
      allowNegative: customerRef === BANK_REF,
    };
    this.accounts.set(id, acc);
    return this.view(acc);
  }

  setReferenceRate(pair: string, rate: string) {
    const r = { pair, rate, asOf: new Date().toISOString() };
    this.rates.set(pair, r);
    return r;
  }

  /** Current reference rate as a number, for the simulated LPs. */
  referenceRate(pair: string): number | undefined {
    const r = this.rates.get(pair);
    return r ? Number(r.rate) : undefined;
  }

  /** Pairs with a reference rate: what the simulated LPs quote. */
  referencePairs(): string[] {
    return [...this.rates.keys()];
  }

  bankAccounts(): CoreAccount[] {
    return [...this.accounts.values()].filter((a) => a.customerRef === BANK_REF).map((a) => this.view(a));
  }

  getStatement(accountId: string): StatementEntry[] {
    return this.statement.filter((e) => e.accountId === accountId);
  }

  getAccount(accountId: string): CoreAccount {
    return this.view(this.account(accountId));
  }

  /** Bank's own accounts, created on first use. */
  private bankAccount(purpose: 'POSITION' | 'CLEARING' | 'COMMISSION' | 'TAX', currency: string): Account {
    const id = `BANK-${purpose}-${currency}`;
    let acc = this.accounts.get(id);
    if (!acc) {
      const names = { POSITION: 'FX pozisyon', CLEARING: 'P2P takas', COMMISSION: 'Komisyon geliri', TAX: 'Kambiyo vergisi tahakkuk' };
      acc = { id, customerRef: BANK_REF, currency, decimals: decimalsOf(currency), name: names[purpose], balance: 0n, allowNegative: true };
      this.accounts.set(id, acc);
    }
    return acc;
  }

  // ---- adapter ----

  async getAccounts(customerRef: string): Promise<CoreAccount[]> {
    return [...this.accounts.values()].filter((a) => a.customerRef === customerRef).map((a) => this.view(a));
  }

  async placeHold(accountId: string, amount: bigint, ref: string) {
    if (amount <= 0n) throw new CoreBankingError('INVALID_REQUEST', 'hold amount must be positive');
    const acc = this.account(accountId);
    if (this.available(acc) < amount) {
      throw new CoreBankingError('INSUFFICIENT_FUNDS', `insufficient available balance on ${accountId}`);
    }
    const hold: Hold = { id: this.nextId('HOLD'), accountId, amount, ref, active: true };
    this.holds.set(hold.id, hold);
    return { holdId: hold.id };
  }

  async findHolds(ref: string) {
    return [...this.holds.values()].filter((h) => h.ref === ref && h.active).map((h) => h.id);
  }

  async adjustHold(holdId: string, newAmount: bigint) {
    const hold = this.hold(holdId);
    if (newAmount <= 0n) {
      hold.active = false;
      hold.amount = 0n;
      return;
    }
    const acc = this.account(hold.accountId);
    const current = hold.active ? hold.amount : 0n;
    if (newAmount > current && this.available(acc) < newAmount - current) {
      throw new CoreBankingError('INSUFFICIENT_FUNDS', `cannot increase hold ${holdId}`);
    }
    hold.amount = newAmount;
    hold.active = true;
  }

  async releaseHold(holdId: string) {
    const hold = this.hold(holdId);
    hold.active = false;
    hold.amount = 0n;
  }

  async postFxTransaction(req: FxTransactionRequest): Promise<FxTransactionResult> {
    const existing = this.txnsByKey.get(req.idempotencyKey);
    if (existing) return this.result(existing);
    if (this.failNextPostings > 0 && (!this.faultCustomers || this.faultCustomers.has(req.customerRef))) {
      this.failNextPostings--;
      throw new CoreBankingError('UNAVAILABLE', 'core banking temporarily unavailable (injected fault)');
    }

    const fx = this.account(req.fxAccountId);
    const tl = this.account(req.tryAccountId);
    if (fx.customerRef !== req.customerRef || tl.customerRef !== req.customerRef) {
      throw new CoreBankingError('INVALID_REQUEST', 'accounts do not belong to the customer');
    }
    if (fx.currency !== req.currency || tl.currency !== req.quoteCurrency) {
      throw new CoreBankingError('INVALID_REQUEST', 'account currencies do not match the transaction');
    }
    const expected =
      req.leg === 'BANK_BUY' ? req.notional - req.commission - req.tax : req.notional + req.commission + req.tax;
    if (expected !== req.customerAmount) {
      throw new CoreBankingError('INVALID_REQUEST', `customer amount ${req.customerAmount} does not add up (expected ${expected})`);
    }

    const position = this.bankAccount('POSITION', req.currency);
    const clearing = this.bankAccount('CLEARING', req.quoteCurrency);
    const commission = this.bankAccount('COMMISSION', req.quoteCurrency);
    const tax = this.bankAccount('TAX', req.quoteCurrency);

    // Debit side first: the customer's FX (bank buys) or TRY (bank sells), captured from holds.
    const debitAccount = req.leg === 'BANK_BUY' ? fx : tl;
    const debitAmount = req.leg === 'BANK_BUY' ? req.qty : req.customerAmount;
    this.capture(debitAccount, debitAmount, req.holdIds);

    const txnRef = this.nextId('FXT');
    const at = new Date().toISOString();
    const what = req.leg === 'BANK_BUY' ? 'Döviz satış' : 'Döviz alış';
    const desc = `P2P ${what} ${req.currency} ${req.reference}`;
    const moves: [Account, bigint][] =
      req.leg === 'BANK_BUY'
        ? [
            [fx, -req.qty],
            [position, req.qty],
            [tl, req.customerAmount],
            [clearing, -req.notional],
            [commission, req.commission],
            [tax, req.tax],
          ]
        : [
            [tl, -req.customerAmount],
            [fx, req.qty],
            [position, -req.qty],
            [clearing, req.notional],
            [commission, req.commission],
            [tax, req.tax],
          ];
    // The debit was already applied by capture(); apply the rest.
    const entries: StatementEntry[] = moves.map(([acc, amount]) => {
      if (acc !== debitAccount) acc.balance += amount;
      return { at, accountId: acc.id, amount, description: desc, txnRef };
    });
    this.statement.push(...entries.filter((e) => e.amount !== 0n));

    const txn: Txn = { txnRef, receiptRef: this.nextId('DKT'), postedAt: at, entries, reversed: false, request: req };
    this.txnsByKey.set(req.idempotencyKey, txn);
    this.txnsByRef.set(txnRef, txn);
    return this.result(txn);
  }

  async findFxTransaction(idempotencyKey: string): Promise<FxTransactionResult | undefined> {
    const txn = this.txnsByKey.get(idempotencyKey);
    return txn && this.result(txn);
  }

  async reverseFxTransaction(txnRef: string, idempotencyKey: string) {
    const done = this.reversalsByKey.get(idempotencyKey);
    if (done) return { reversalRef: done };
    const txn = this.txnsByRef.get(txnRef);
    if (!txn) throw new CoreBankingError('NOT_FOUND', `transaction ${txnRef} not found`);
    if (txn.reversed) throw new CoreBankingError('INVALID_REQUEST', `transaction ${txnRef} already reversed`);
    const reversalRef = this.nextId('REV');
    const at = new Date().toISOString();
    for (const e of txn.entries) {
      this.account(e.accountId).balance -= e.amount;
      if (e.amount !== 0n) this.statement.push({ at, accountId: e.accountId, amount: -e.amount, description: `İptal ${e.description}`, txnRef: reversalRef });
    }
    txn.reversed = true;
    this.reversalsByKey.set(idempotencyKey, reversalRef);
    return { reversalRef };
  }

  async getReceipt(receiptRef: string): Promise<Receipt> {
    const txn = [...this.txnsByRef.values()].find((t) => t.receiptRef === receiptRef);
    if (!txn) throw new CoreBankingError('NOT_FOUND', `receipt ${receiptRef} not found`);
    const r = txn.request;
    const q = (v: bigint) => `${formatDecimal(v, decimalsOf(r.quoteCurrency))} ${r.quoteCurrency}`;
    const isBuy = r.leg === 'BANK_SELL';
    return {
      receiptRef: txn.receiptRef,
      txnRef: txn.txnRef,
      title: isBuy ? 'Döviz Alış Dekontu' : 'Döviz Satış Dekontu',
      customerRef: r.customerRef,
      postedAt: txn.postedAt,
      reversed: txn.reversed,
      lines: [
        { label: 'İşlem', value: isBuy ? `${r.currency} alış` : `${r.currency} satış` },
        { label: 'Tutar', value: `${formatDecimal(r.qty, decimalsOf(r.currency))} ${r.currency}` },
        { label: 'Eşleşme kuru', value: rate4(r.bookPrice) },
        { label: 'İşlem kuru', value: rate4(r.effectivePrice) },
        { label: 'İşlem tutarı', value: q(r.notional) },
        { label: 'Banka komisyonu', value: q(r.commission) },
        { label: 'Kambiyo vergisi', value: q(r.tax) },
        { label: isBuy ? 'Hesabınızdan çekilen' : 'Hesabınıza yatan', value: q(r.customerAmount) },
        { label: 'Referans', value: r.reference },
      ],
    };
  }

  async getReferenceRate(pair: string): Promise<ReferenceRate> {
    const r = this.rates.get(pair);
    if (!r) throw new CoreBankingError('NOT_FOUND', `no reference rate for ${pair}`);
    return r;
  }

  async notify(customerRef: string, event: { type: string; title: string; body: string; data?: unknown }) {
    this.notifications.push({ customerRef, event });
  }

  // ---- internals ----

  private account(id: string): Account {
    const acc = this.accounts.get(id);
    if (!acc) throw new CoreBankingError('NOT_FOUND', `account ${id} not found`);
    return acc;
  }

  private hold(id: string): Hold {
    const h = this.holds.get(id);
    if (!h) throw new CoreBankingError('NOT_FOUND', `hold ${id} not found`);
    return h;
  }

  private held(acc: Account) {
    let sum = 0n;
    for (const h of this.holds.values()) if (h.active && h.accountId === acc.id) sum += h.amount;
    return sum;
  }

  private available(acc: Account) {
    return acc.balance - this.held(acc);
  }

  /** Debits `amount`, consuming the given holds first; the rest must be available. */
  private capture(acc: Account, amount: bigint, holdIds: string[]) {
    let fromHolds = 0n;
    const holds = holdIds.map((id) => this.hold(id)).filter((h) => h.active && h.accountId === acc.id);
    for (const h of holds) fromHolds += h.amount;
    const consumed = fromHolds < amount ? fromHolds : amount;
    if (!acc.allowNegative && this.available(acc) + consumed < amount) {
      throw new CoreBankingError('INSUFFICIENT_FUNDS', `insufficient funds on ${acc.id}`);
    }
    let left = consumed;
    for (const h of holds) {
      const take = h.amount < left ? h.amount : left;
      h.amount -= take;
      left -= take;
      if (h.amount === 0n) h.active = false;
    }
    acc.balance -= amount;
  }

  private view(acc: Account): CoreAccount {
    const held = this.held(acc);
    return {
      id: acc.id,
      customerRef: acc.customerRef,
      currency: acc.currency,
      decimals: acc.decimals,
      name: acc.name,
      iban: acc.iban,
      balance: acc.balance,
      held,
      available: acc.balance - held,
    };
  }

  private result(t: Txn): FxTransactionResult {
    return { txnRef: t.txnRef, receiptRef: t.receiptRef, postedAt: t.postedAt };
  }
}

/** Rates on a dekont carry four decimals, as banks publish them: 49.2 → 49.2000. */
function rate4(rate: string): string {
  const [int, frac = ''] = rate.split('.');
  return `${int}.${frac.padEnd(4, '0')}`;
}
