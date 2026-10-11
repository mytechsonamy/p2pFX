import { useEffect, useRef, useState } from 'react';
import { useExchange, usePair } from './store';
import { Row, Segmented, Sheet } from './components';
import { compareDecimal, currencySymbol, formatDecimal, formatMoney, formatPrice, formatRate, sanitizeAmountInput, toApiDecimal } from './format';
import type { BankPriceOff, BankQuote, BankRates, PairInfo, Side } from './types';

/**
 * The bank's price is streamed about every second while it is dealable. One not refreshed for this long is shown as
 * out of date (the stream or the LPs stalled) and cannot be tapped; the client's own clock measures it.
 */
const STALE_AFTER_MS = 5000;

type BankPrice = { state: 'live'; rates: BankRates } | { state: 'stale'; rates: BankRates } | { state: 'off'; reason: BankPriceOff };

/** The pair's bank price and whether it can be dealt on now; re-renders every second so a stalled price greys out. */
export function useBankPrice(symbol: string): BankPrice {
  const { bankRates } = useExchange();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const r = bankRates[symbol];
  if (!r) return { state: 'off', reason: 'NO_PRICE' };
  if (r.unavailable) return { state: 'off', reason: r.reason };
  return { state: now - r.receivedAt <= STALE_AFTER_MS ? 'live' : 'stale', rates: r };
}

/** The bank's live rates for this customer, on top of the order book: tap to deal instantly. */
export function BankRow({ pair }: { pair: PairInfo }) {
  const { config, t, locale, openBankDeal } = useExchange();
  const price = useBankPrice(pair.symbol);
  if (!config.dealing?.enabled) return null;
  // Prices are shown only while they can be dealt on; an out-of-date one stays visible, greyed and not tappable.
  const r = price.state === 'off' ? undefined : price.rates;
  const live = price.state === 'live';
  const pill = live ? t('bank.live') : price.state === 'stale' ? t('bank.stale') : t('bank.off');
  return (
    <section className={`card bank-row${live ? '' : ' bank-row-off'}`}>
      <div className="card-head">
        <h3>
          {t('bank.title', { bank: config.bank.name })} <span className={`pill${live ? '' : ' pill-muted'}`}>{pill}</span>
        </h3>
        <small>{live ? t('bank.hint') : price.state === 'off' && price.reason === 'WIDE_MARKET' ? t('bank.wideMarket') : t('bank.noPrice')}</small>
      </div>
      <div className="bank-prices">
        <button className="bank-price buy" disabled={!live} onClick={() => openBankDeal({ side: 'BUY' })}>
          <small>{t('bank.buy')}</small>
          <strong>{r ? formatPrice(r.buy, locale) : '—'}</strong>
        </button>
        <button className="bank-price sell" disabled={!live} onClick={() => openBankDeal({ side: 'SELL' })}>
          <small>{t('bank.sell')}</small>
          <strong>{r ? formatPrice(r.sell, locale) : '—'}</strong>
        </button>
      </div>
    </section>
  );
}

/** UNIFIED presentation: the bank's Direct rates as a quick path on the ticket instead of their own area. */
export function BankQuick({ pair, side, qty }: { pair: PairInfo; side: Side; qty?: string }) {
  const { config, t, locale, openBankDeal } = useExchange();
  const price = useBankPrice(pair.symbol);
  if (!config.dealing?.enabled || price.state !== 'live') return null;
  const r = price.rates;
  return (
    <button type="button" className="link bank-quick" onClick={() => openBankDeal({ side, qty })}>
      {t('bank.quick', { buy: formatPrice(r.buy, locale), sell: formatPrice(r.sell, locale) })}
    </button>
  );
}

/**
 * Shown on the order ticket when dealing with the bank right now beats the customer's all-in P2P price:
 * buying, the bank's rate is lower; selling, it is higher.
 */
export function BetterAtBank({ side, effectivePrice, qty }: { side: Side; effectivePrice?: string; qty?: string }) {
  const { config, t, locale, openBankDeal, pair } = useExchange();
  const price = useBankPrice(pair);
  if (!config.dealing?.enabled || price.state !== 'live' || !effectivePrice) return null;
  const r = price.rates;
  const bank = side === 'BUY' ? r.buy : r.sell;
  const better = side === 'BUY' ? compareDecimal(bank, effectivePrice) < 0 : compareDecimal(bank, effectivePrice) > 0;
  if (!better) return null;
  return (
    <div className="notice bank-better">
      {t('bank.better', { bank: config.bank.name, rate: formatPrice(bank, locale) })}{' '}
      <button className="link" onClick={() => openBankDeal({ side, qty })}>
        {t('bank.betterAction')}
      </button>
    </div>
  );
}

/** Deal with the bank: amount → firm quote with a countdown → confirm. */
export function BankDealSheet() {
  const { api, bankDeal, openBankDeal, config, accounts, t, locale, errorText, addFill, track } = useExchange();
  const pair = usePair();
  const price = useBankPrice(pair.symbol);
  const [side, setSide] = useState<Side>(bankDeal?.side ?? 'BUY');
  const [qty, setQty] = useState(bankDeal?.qty ?? '');
  const [quote, setQuote] = useState<BankQuote>();
  const [left, setLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const timer = useRef<ReturnType<typeof setInterval>>(undefined);

  useEffect(() => () => clearInterval(timer.current), []);
  if (!bankDeal) return null;

  const buy = side === 'BUY';
  const live = price.state === 'live' ? price.rates : undefined;
  const amount = toApiDecimal(qty);
  const pay = accounts.find((a) => a.currency === (buy ? pair.quote : pair.base));
  const close = () => {
    clearInterval(timer.current);
    openBankDeal(null);
  };

  const getQuote = async () => {
    if (!amount) return;
    setBusy(true);
    setError(undefined);
    try {
      const q = await api.bankQuote({ pair: pair.symbol, side, qty: amount });
      setQuote(q);
      const tick = () => setLeft(Math.max(0, Math.ceil((new Date(q.expiresAt).getTime() - Date.now()) / 1000)));
      tick();
      clearInterval(timer.current);
      timer.current = setInterval(tick, 250);
      track('bank_quote', { pair: pair.symbol, side });
    } catch (e) {
      setError(errorText(e));
    }
    setBusy(false);
  };

  const confirm = async () => {
    if (!quote) return;
    setBusy(true);
    setError(undefined);
    try {
      const deal = await api.bankDeal(quote.id);
      addFill(deal);
      track('bank_deal', { pair: pair.symbol, side });
      close();
    } catch (e) {
      setError(errorText(e));
      setQuote(undefined);
      setBusy(false);
    }
  };

  const money = (v: string) => formatMoney(v, pair.quote, locale, pair.quoteDecimals);
  const insufficient = quote && pay && compareDecimal(buy ? quote.total : quote.qty, pay.available) > 0;

  return (
    <Sheet title={t('bank.sheetTitle')} onClose={busy ? () => {} : close}>
      <Segmented<Side>
        value={side}
        onChange={(s) => {
          setSide(s);
          setQuote(undefined);
        }}
        options={[
          { value: 'BUY', label: `${t('bank.buy')} · ${live ? formatPrice(live.buy, locale) : '—'}`, tone: 'buy' },
          { value: 'SELL', label: `${t('bank.sell')} · ${live ? formatPrice(live.sell, locale) : '—'}`, tone: 'sell' },
        ]}
      />
      <label className="field">
        <span>{t('ticket.qty', { base: currencySymbol(pair.base) })}</span>
        <div className="input-wrap">
          <input
            inputMode="decimal"
            placeholder="0"
            value={qty}
            onChange={(e) => {
              setQty(sanitizeAmountInput(e.target.value, pair.baseDecimals));
              setQuote(undefined);
            }}
          />
          <span className="suffix">{currencySymbol(pair.base)}</span>
        </div>
        {pay && <small className="hint">{t('ticket.available', { amount: formatMoney(pay.available, pay.currency, locale) })}</small>}
      </label>

      {quote && (
        <div className="breakdown">
          <Row label={t('bank.rate')} value={`${formatPrice(quote.rate, locale)} ${currencySymbol(pair.quote)}`} strong />
          <Row label={t('bank.notional', { qty: `${formatDecimal(quote.qty, locale, pair.baseDecimals)} ${currencySymbol(pair.base)}`, rate: formatPrice(quote.rate, locale) })} value={money(quote.notional)} />
          <Row label={t('quote.tax', { rate: formatRate(quote.taxRate, locale) })} value={`${buy ? '+' : '−'} ${money(quote.tax)}`} />
          <div className="divider" />
          <Row label={buy ? t('quote.totalBuy') : t('quote.totalSell')} value={money(quote.total)} strong />
          <div className={`countdown ${left <= 3 ? 'urgent' : ''}`}>{left > 0 ? t('bank.validFor', { seconds: left }) : t('bank.expired')}</div>
        </div>
      )}
      <ul className="fineprint">
        <li>{t('bank.counterparty', { bank: config.bank.name })}</li>
        <li>{t('bank.noCommission')}</li>
      </ul>
      {insufficient && <div className="error-text">{t('ticket.insufficient')}</div>}
      {error && <div className="error-text">{error}</div>}
      <div className="actions">
        <button className="btn ghost" disabled={busy} onClick={close}>
          {t('confirm.cancel')}
        </button>
        {quote && left > 0 ? (
          <button className={`btn primary ${buy ? 'buy' : 'sell'}`} disabled={busy || !!insufficient} onClick={confirm}>
            {busy ? <span className="spinner small" /> : `${t('bank.confirm')} · ${money(quote.total)}`}
          </button>
        ) : (
          <button className="btn primary" disabled={busy || !amount} onClick={getQuote}>
            {busy ? <span className="spinner small" /> : quote ? t('bank.requote') : t('bank.getQuote')}
          </button>
        )}
      </div>
    </Sheet>
  );
}
