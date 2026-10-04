import type { MockCoreBank } from '@p2p/core-adapter';
import { parseDecimal } from '@p2p/shared';

/** Demo customers and reference rates for the prototype. */
export const DEMO_CUSTOMERS: Record<string, Record<string, string>> = {
  'demo-ayse': { TRY: '100000', USD: '10000', EUR: '5000' },
  'demo-mehmet': { TRY: '1000000', USD: '0', EUR: '0' },
  'demo-zeynep': { TRY: '50000', USD: '2000', EUR: '2000', GBP: '1000' },
  'demo-ali': { TRY: '20000', USD: '100' },
};

export const DEMO_RATES: Record<string, string> = { USDTRY: '49.15', EURTRY: '53.40', GBPTRY: '62.10' };

export function seedDemo(bank: MockCoreBank) {
  for (const [ref, balances] of Object.entries(DEMO_CUSTOMERS)) {
    for (const [ccy, amount] of Object.entries(balances)) bank.createAccount(ref, ccy, parseDecimal(amount, 2));
  }
  for (const [pair, rate] of Object.entries(DEMO_RATES)) bank.setReferenceRate(pair, rate);
}
