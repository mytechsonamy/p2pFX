import type { MockCoreBank } from '@p2p/core-adapter';
import { parseDecimal } from '@p2p/shared';

/** Demo customers and reference rates for the prototype. */
export const DEMO_CUSTOMERS: Record<string, Record<string, string>> = {
  'demo-ayse': { TRY: '100000', USD: '10000', EUR: '5000' },
  'demo-mehmet': { TRY: '1000000', USD: '0', EUR: '0' },
  'demo-zeynep': { TRY: '50000', USD: '2000', EUR: '2000', GBP: '1000' },
  'demo-ali': { TRY: '20000', USD: '100' },
};

/** Liquidity providers the market seeder trades with, so the board has depth and a trade history. */
export const MARKET_MAKERS = ['demo-mm-1', 'demo-mm-2', 'demo-mm-3', 'demo-mm-4', 'demo-mm-5', 'demo-mm-6'];
const MARKET_MAKER_BALANCES = { TRY: '50000000', USD: '500000', EUR: '500000', GBP: '500000' };

/** The bank's own trading account: its ladder in the P2P book is entered for it (config `bankBook.customerRef`). */
export const BANK_DESK = 'bank-desk';
const BANK_DESK_BALANCES = { TRY: '500000000', USD: '5000000', EUR: '5000000', GBP: '5000000' };

export const DEMO_RATES: Record<string, string> = { USDTRY: '49.15', EURTRY: '53.40', GBPTRY: '62.10' };

export function seedDemo(bank: MockCoreBank) {
  const customers = {
    ...DEMO_CUSTOMERS,
    ...Object.fromEntries(MARKET_MAKERS.map((ref) => [ref, MARKET_MAKER_BALANCES])),
    [BANK_DESK]: BANK_DESK_BALANCES,
  };
  for (const [ref, balances] of Object.entries(customers)) {
    for (const [ccy, amount] of Object.entries(balances)) bank.createAccount(ref, ccy, parseDecimal(amount, 2));
  }
  for (const [pair, rate] of Object.entries(DEMO_RATES)) bank.setReferenceRate(pair, rate);
}
