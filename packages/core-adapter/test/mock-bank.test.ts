import { describe, expect, it } from 'vitest';
import { CoreBankingError, MockCoreBank, type FxTransactionRequest } from '../src/index.js';

function setup() {
  const bank = new MockCoreBank();
  const seller = { usd: bank.createAccount('seller', 'USD', 100_000n), tl: bank.createAccount('seller', 'TRY', 0n) };
  const buyer = { usd: bank.createAccount('buyer', 'USD', 0n), tl: bank.createAccount('buyer', 'TRY', 10_000_000n) };
  return { bank, seller, buyer };
}

const base = { currency: 'USD', quoteCurrency: 'TRY', qty: 100_000n, bookPrice: '49.15', notional: 4_915_000n, commission: 5_000n, tax: 9_840n, reference: 'F1' };

describe('MockCoreBank', () => {
  it('holds reduce available balance and reject over-holding', async () => {
    const { bank, seller } = setup();
    const { holdId } = await bank.placeHold(seller.usd.id, 60_000n, 'o1');
    expect(bank.getAccount(seller.usd.id).available).toBe(40_000n);
    await expect(bank.placeHold(seller.usd.id, 50_000n, 'o2')).rejects.toBeInstanceOf(CoreBankingError);
    await bank.adjustHold(holdId, 10_000n);
    expect(bank.getAccount(seller.usd.id).available).toBe(90_000n);
    await bank.releaseHold(holdId);
    expect(bank.getAccount(seller.usd.id).available).toBe(100_000n);
  });

  it('posts both legs, books commission and tax, and is idempotent', async () => {
    const { bank, seller, buyer } = setup();
    const sellerHold = await bank.placeHold(seller.usd.id, 100_000n, 'o1');
    const bankBuy: FxTransactionRequest = {
      ...base, leg: 'BANK_BUY', customerRef: 'seller', fxAccountId: seller.usd.id, tryAccountId: seller.tl.id,
      effectivePrice: '49.10', tax: 9_820n, customerAmount: 4_915_000n - 5_000n - 9_820n, holdIds: [sellerHold.holdId], idempotencyKey: 'k1',
    };
    const r1 = await bank.postFxTransaction(bankBuy);
    const r2 = await bank.postFxTransaction(bankBuy);
    expect(r2.txnRef).toBe(r1.txnRef);
    await bank.postFxTransaction({
      ...base, leg: 'BANK_SELL', customerRef: 'buyer', fxAccountId: buyer.usd.id, tryAccountId: buyer.tl.id,
      effectivePrice: '49.20', customerAmount: 4_915_000n + 5_000n + 9_840n, holdIds: [], idempotencyKey: 'k2',
    });
    expect(bank.getAccount(seller.usd.id).balance).toBe(0n);
    expect(bank.getAccount(seller.tl.id).balance).toBe(4_900_180n);
    expect(bank.getAccount(buyer.usd.id).balance).toBe(100_000n);
    expect(bank.getAccount(buyer.tl.id).balance).toBe(10_000_000n - 4_929_840n);
    const bal = Object.fromEntries(bank.bankAccounts().map((a) => [a.id, a.balance]));
    expect(bal).toEqual({ 'BANK-POSITION-USD': 0n, 'BANK-CLEARING-TRY': 0n, 'BANK-COMMISSION-TRY': 10_000n, 'BANK-TAX-TRY': 19_660n });
    const receipt = await bank.getReceipt(r1.receiptRef);
    expect(receipt.lines.find((l) => l.label === 'Hesabınıza yatan')?.value).toBe('49001.80 TRY');
  });

  it('rejects amounts that do not add up and reverses postings', async () => {
    const { bank, seller } = setup();
    const req: FxTransactionRequest = {
      ...base, leg: 'BANK_BUY', customerRef: 'seller', fxAccountId: seller.usd.id, tryAccountId: seller.tl.id,
      effectivePrice: '49.10', customerAmount: 1n, holdIds: [], idempotencyKey: 'bad',
    };
    await expect(bank.postFxTransaction(req)).rejects.toThrow(/does not add up/);
    const ok = await bank.postFxTransaction({ ...req, customerAmount: base.notional - base.commission - base.tax, idempotencyKey: 'good' });
    await bank.reverseFxTransaction(ok.txnRef, 'rev1');
    expect(bank.getAccount(seller.usd.id).balance).toBe(100_000n);
    expect(bank.getAccount(seller.tl.id).balance).toBe(0n);
  });
});
