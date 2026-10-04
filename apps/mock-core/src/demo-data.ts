import { decimalsOf, type MockCoreBank } from '@p2p/core-adapter';
import { parseDecimal } from '@p2p/shared';

/** Demo customers and reference rates for the prototype. */
export const DEMO_CUSTOMERS: Record<string, Record<string, string>> = {
  'demo-ayse': { TRY: '100000', USD: '10000', EUR: '5000', XAU: '25', CHF: '1500' },
  'demo-mehmet': { TRY: '1000000', USD: '0', EUR: '0', GBP: '0', CHF: '0', JPY: '0', XAU: '0', XAG: '0', XPT: '0' },
  'demo-zeynep': { TRY: '50000', USD: '2000', EUR: '2000', GBP: '1000', JPY: '150000', XAG: '500' },
  'demo-ali': { TRY: '20000', USD: '100', SAR: '3000', XAU: '5' },
};

/**
 * Reference rates, which are also what the simulated LPs quote: the currencies and metals (TRY per gram) the
 * bank can open for trading. The demo configuration opens most of them; the rest can be added in the back office.
 */
export const DEMO_RATES: Record<string, string> = {
  USDTRY: '49.15',
  EURTRY: '53.40',
  GBPTRY: '62.10',
  CHFTRY: '57.20',
  JPYTRY: '0.3290',
  CADTRY: '35.40',
  AUDTRY: '32.30',
  SARTRY: '13.10',
  AEDTRY: '13.38',
  QARTRY: '13.50',
  KWDTRY: '160.90',
  DKKTRY: '7.16',
  SEKTRY: '4.90',
  NOKTRY: '4.65',
  CNYTRY: '6.90',
  XAUTRY: '6320.00',
  XAGTRY: '79.50',
  XPTTRY: '2530.00',
};

/** Liquidity providers the market seeder trades with, so the board has depth and a trade history. */
export const MARKET_MAKERS = ['demo-mm-1', 'demo-mm-2', 'demo-mm-3', 'demo-mm-4', 'demo-mm-5', 'demo-mm-6'];
/** An account in every instrument the LPs quote, each worth about `tl` lira. */
const each = (tl: number) => Object.fromEntries(Object.keys(DEMO_RATES).map((pair) => [pair.slice(0, 3), String(Math.round(tl / Number(DEMO_RATES[pair])))]));
const MARKET_MAKER_BALANCES = { TRY: '50000000', ...each(25_000_000) };

/** The bank's own trading account: its ladder in the P2P book is entered for it (config `bankBook.customerRef`). */
export const BANK_DESK = 'bank-desk';
const BANK_DESK_BALANCES = { TRY: '500000000', ...each(250_000_000) };

export function seedDemo(bank: MockCoreBank) {
  const customers = {
    ...DEMO_CUSTOMERS,
    ...Object.fromEntries(MARKET_MAKERS.map((ref) => [ref, MARKET_MAKER_BALANCES])),
    [BANK_DESK]: BANK_DESK_BALANCES,
  };
  for (const [ref, balances] of Object.entries(customers)) {
    for (const [ccy, amount] of Object.entries(balances)) bank.createAccount(ref, ccy, parseDecimal(amount, decimalsOf(ccy)));
  }
  for (const [pair, rate] of Object.entries(DEMO_RATES)) bank.setReferenceRate(pair, rate);
}
