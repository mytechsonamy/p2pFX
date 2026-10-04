import { useEffect, useMemo, useRef, useState } from 'react';
import { useExchange, usePair } from '../store';
import { Breakdown, Row, Segmented, Sheet } from '../components';
import { compareDecimal, currencySymbol, formatDateTime, formatDecimal, formatMoney, formatPrice, sanitizeAmountInput, toApiDecimal, toInputText } from '../format';
import { endOfDay, localDate } from '../time';
import { newIdempotencyKey, type PlaceOrder } from '../api';
import type { BookLevel, PairInfo, QuoteBreakdown, Side, Validity } from '../types';

interface Draft {
  side: Side;
  qty: string;
  price: string;
  /** Whether the customer typed the price; if not, it follows the market. */
  priceTouched: boolean;
  validity: Validity;
  gtdDate: string;
}

export function TradeScreen() {
  const { config, pair: symbol } = useExchange();
  const pair = usePair();
  const [draft, setDraft] = useState<Draft>(() => ({
    side: 'BUY',
    qty: '',
    price: '',
    priceTouched: false,
    validity: config.validity.options.includes('DAY') ? 'DAY' : config.validity.options[0],
    gtdDate: localDate(config.tradingHours.timezone, 1),
  }));

  // A new pair starts with a fresh amount and a market price.
  useEffect(() => setDraft((d) => ({ ...d, qty: '', price: '', priceTouched: false })), [symbol]);

  return (
    <div className="trade">
      <RateStrip pair={pair} />
      <OrderBook
        pair={pair}
        onPick={(level, side) => setDraft((d) => ({ ...d, side, price: level.price, priceTouched: true }))}
      />
      <OrderTicket pair={pair} draft={draft} setDraft={setDraft} />
    </div>
  );
}

function RateStrip({ pair }: { pair: PairInfo }) {
  const { rates, t, locale } = useExchange();
  const r = rates[pair.symbol];
  return (
    <section className="card rates">
      <div>
        <small>{t('rate.reference')}</small>
        <strong>{r ? formatPrice(r.rate, locale) : '—'}</strong>
      </div>
      <div className="buy-text">
        <small>{t('rate.indicativeBuy')}</small>
        <strong>{r ? formatPrice(r.buyPrice, locale) : '—'}</strong>
      </div>
      <div className="sell-text">
        <small>{t('rate.indicativeSell')}</small>
        <strong>{r ? formatPrice(r.sellPrice, locale) : '—'}</strong>
      </div>
    </section>
  );
}

const DEPTH = 6;

function OrderBook({ pair, onPick }: { pair: PairInfo; onPick: (l: BookLevel, side: Side) => void }) {
  const { books, rates, t, locale } = useExchange();
  const book = books[pair.symbol];
  const asks = (book?.asks ?? []).slice(0, DEPTH);
  const bids = (book?.bids ?? []).slice(0, DEPTH);
  const max = Math.max(1, ...[...asks, ...bids].map((l) => Number(l.qty)));
  const rate = rates[pair.symbol];

  const level = (l: BookLevel, kind: 'ask' | 'bid') => (
    <button
      key={`${kind}${l.price}`}
      className={`level ${kind}`}
      // Tapping an offer prefills a buy at that price, tapping a bid prefills a sell.
      onClick={() => onPick(l, kind === 'ask' ? 'BUY' : 'SELL')}
    >
      <span className="bar" style={{ width: `${(Number(l.qty) / max) * 100}%` }} />
      <span className="price">{formatPrice(l.price, locale)}</span>
      <span className="qty">{formatDecimal(l.qty, locale, pair.baseDecimals)}</span>
      <span className="count">{l.count}</span>
    </button>
  );

  return (
    <section className="card book">
      <div className="card-head">
        <h3>{t('book.title')}</h3>
        <small>{t('book.hint')}</small>
      </div>
      <div className="book-cols">
        <span>{t('book.price')} ({currencySymbol(pair.quote)})</span>
        <span>{t('book.qty')} ({pair.base})</span>
        <span>#</span>
      </div>
      <div className="side-label sell-text">{t('book.asks')}</div>
      {asks.length ? [...asks].reverse().map((l) => level(l, 'ask')) : <div className="book-empty">{t('book.empty')}</div>}
      <div className="spread">
        {rate && (
          <>
            {t('rate.reference')}: <strong>{formatPrice(rate.rate, locale)}</strong>
          </>
        )}
      </div>
      <div className="side-label buy-text">{t('book.bids')}</div>
      {bids.length ? bids.map((l) => level(l, 'bid')) : <div className="book-empty">{t('book.empty')}</div>}
    </section>
  );
}

function useQuote(pair: PairInfo, side: Side, qty?: string, price?: string) {
  const { api, errorText } = useExchange();
  const [state, setState] = useState<{ quote?: QuoteBreakdown; error?: string; loading: boolean }>({ loading: false });
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current;
    if (!qty || !price) return setState({ loading: false });
    setState((s) => ({ ...s, loading: true }));
    const timer = setTimeout(() => {
      api.quote({ pair: pair.symbol, side, qty, price }).then(
        (quote) => n === seq.current && setState({ quote, loading: false }),
        (e) => n === seq.current && setState({ error: errorText(e), loading: false }),
      );
    }, 250);
    return () => clearTimeout(timer);
  }, [api, errorText, pair.symbol, side, qty, price]);
  return state;
}

function OrderTicket({ pair, draft, setDraft }: { pair: PairInfo; draft: Draft; setDraft: React.Dispatch<React.SetStateAction<Draft>> }) {
  const { t, locale, config, accounts, books, rates, bridge } = useExchange();
  const [confirming, setConfirming] = useState<{ order: PlaceOrder; quote: QuoteBreakdown } | null>(null);
  const tz = config.tradingHours.timezone;
  const book = books[pair.symbol];
  const rate = rates[pair.symbol];
  const buy = draft.side === 'BUY';

  // Until the customer types a price, it follows the best opposite order, or the bank rate on an empty book.
  const marketPrice = (buy ? book?.asks[0]?.price : book?.bids[0]?.price) ?? rate?.rate;
  useEffect(() => {
    if (!draft.priceTouched && marketPrice) setDraft((d) => (d.priceTouched ? d : { ...d, price: marketPrice }));
  }, [marketPrice, draft.priceTouched, setDraft]);

  const qty = toApiDecimal(draft.qty);
  const price = toApiDecimal(draft.price);
  const { quote, error, loading } = useQuote(pair, draft.side, qty, price);

  const fxAccount = accounts.find((a) => a.currency === pair.base);
  const tryAccount = accounts.find((a) => a.currency === pair.quote);
  const payAccount = buy ? tryAccount : fxAccount;
  const missingAccount = accounts.length > 0 && (!fxAccount || !tryAccount) ? (!fxAccount ? pair.base : pair.quote) : undefined;

  const problems: string[] = [];
  if (qty && compareDecimal(qty, pair.minQty) < 0) problems.push(t('ticket.minQty', { min: formatDecimal(pair.minQty, locale, 0, pair.baseDecimals), base: pair.base }));
  if (price && rate && (compareDecimal(price, rate.bandLow) < 0 || compareDecimal(price, rate.bandHigh) > 0)) problems.push(t('error.PRICE_OUT_OF_BAND'));
  if (quote && payAccount && compareDecimal(buy ? quote.total : quote.qty, payAccount.available) > 0) problems.push(t('ticket.insufficient'));
  if (error) problems.push(error);

  const canContinue = !!quote && !loading && !problems.length && !missingAccount && config.marketOpen;

  const onContinue = () => {
    if (!quote || !qty || !price) return;
    setConfirming({
      order: {
        pair: pair.symbol,
        side: draft.side,
        qty,
        price,
        validity: draft.validity,
        expiresAt: draft.validity === 'GTD' ? endOfDay(draft.gtdDate, tz) : undefined,
      },
      quote,
    });
  };

  const fillAll = () => {
    if (!payAccount) return;
    if (!buy) return setDraft((d) => ({ ...d, qty: toInputText(payAccount.available, locale) }));
    // Largest whole amount whose all-in total fits the TRY balance.
    if (!quote && !price) return;
    const unit = Number(quote?.effectivePrice ?? price) * (1 + Number(config.tax.buyRate));
    const max = Math.floor(Number(payAccount.available) / unit);
    if (max > 0) setDraft((d) => ({ ...d, qty: String(max) }));
  };

  return (
    <section className="card ticket">
      <Segmented<Side>
        value={draft.side}
        onChange={(side) => setDraft((d) => ({ ...d, side, priceTouched: false }))}
        options={[
          { value: 'BUY', label: t('ticket.buyTitle', { base: pair.base }), tone: 'buy' },
          { value: 'SELL', label: t('ticket.sellTitle', { base: pair.base }), tone: 'sell' },
        ]}
      />

      <label className="field">
        <span>{t('ticket.qty', { base: pair.base })}</span>
        <div className="input-wrap">
          <input
            inputMode="decimal"
            placeholder="0"
            value={draft.qty}
            onChange={(e) => setDraft((d) => ({ ...d, qty: sanitizeAmountInput(e.target.value, pair.baseDecimals) }))}
          />
          <span className="suffix">{pair.base}</span>
        </div>
        {payAccount && (
          <small className="hint">
            {t('ticket.available', { amount: formatMoney(payAccount.available, payAccount.currency, locale) })}
            <button type="button" className="link" onClick={fillAll}>
              {t('ticket.all')}
            </button>
          </small>
        )}
      </label>

      <label className="field">
        <span>{t('ticket.price', { quote: currencySymbol(pair.quote) })}</span>
        <div className="input-wrap">
          <input
            inputMode="decimal"
            placeholder={rate ? toInputText(rate.rate, locale) : ''}
            value={toInputText(draft.price, locale)}
            onChange={(e) => setDraft((d) => ({ ...d, price: sanitizeAmountInput(e.target.value, 4).replace(',', '.'), priceTouched: true }))}
          />
          <span className="suffix">{currencySymbol(pair.quote)}</span>
        </div>
        {rate && (
          <small className="hint">
            {t('ticket.band', { low: formatPrice(rate.bandLow, locale), high: formatPrice(rate.bandHigh, locale) })}
          </small>
        )}
      </label>

      <label className="field">
        <span>{t('ticket.validity')}</span>
        <select value={draft.validity} onChange={(e) => setDraft((d) => ({ ...d, validity: e.target.value as Validity }))}>
          {config.validity.options.map((v) => (
            <option key={v} value={v}>
              {t(`validity.${v}`)}
              {v === 'GTC' ? ` (${t('validity.GTC.hint', { days: config.validity.maxValidityDays })})` : ''}
            </option>
          ))}
        </select>
      </label>
      {draft.validity === 'GTD' && (
        <label className="field">
          <span>{t('ticket.until')}</span>
          <input
            type="date"
            value={draft.gtdDate}
            min={localDate(tz)}
            max={localDate(tz, config.validity.maxValidityDays - 1)}
            onChange={(e) => setDraft((d) => ({ ...d, gtdDate: e.target.value }))}
          />
        </label>
      )}

      {quote && qty && price && <Breakdown q={quote} pair={pair} compact />}

      {missingAccount && (
        <div className="notice">
          {t('accounts.missing', { currency: missingAccount })}{' '}
          <button className="link" onClick={() => bridge.send({ type: 'openBankScreen', screen: 'openFxAccount', params: { currency: missingAccount } })}>
            {t('accounts.openFx')}
          </button>
        </div>
      )}
      {problems.map((p) => (
        <div key={p} className="error-text">{p}</div>
      ))}

      <button className={`btn primary block ${buy ? 'buy' : 'sell'}`} disabled={!canContinue} onClick={onContinue}>
        {t('ticket.continue')}
      </button>

      {confirming && (
        <ConfirmSheet
          pair={pair}
          order={confirming.order}
          quote={confirming.quote}
          onClose={() => setConfirming(null)}
          onPlaced={() => {
            setConfirming(null);
            setDraft((d) => ({ ...d, qty: '' }));
          }}
        />
      )}
    </section>
  );
}

function ConfirmSheet({ pair, order, quote, onClose, onPlaced }: { pair: PairInfo; order: PlaceOrder; quote: QuoteBreakdown; onClose: () => void; onPlaced: () => void }) {
  const { api, t, locale, config, accounts, toast, errorText, upsertOrder, refreshAccounts, track } = useExchange();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // One key per confirmation sheet: a retried tap re-sends the same order instead of a second one.
  const idempotencyKey = useMemo(newIdempotencyKey, []);
  const buy = order.side === 'BUY';
  const fx = accounts.find((a) => a.currency === pair.base);
  const tl = accounts.find((a) => a.currency === pair.quote);
  const qtyText = `${formatDecimal(order.qty, locale, pair.baseDecimals)} ${pair.base}`;

  useEffect(() => track('order_review', { pair: order.pair, side: order.side }), [track, order.pair, order.side]);

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const placed = await api.place(order, idempotencyKey);
      upsertOrder(placed);
      refreshAccounts();
      track('order_placed', { pair: order.pair, side: order.side, validity: order.validity });
      toast(t('confirm.placed'), 'success');
      onPlaced();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  const validityText =
    order.validity === 'GTD' && order.expiresAt
      ? `${t('validity.GTD')}: ${formatDateTime(order.expiresAt, locale, config.tradingHours.timezone)}`
      : order.validity === 'GTC'
        ? `${t('validity.GTC')} (${t('validity.GTC.hint', { days: config.validity.maxValidityDays })})`
        : t('validity.DAY');

  return (
    <Sheet title={t('confirm.title')} onClose={busy ? () => {} : onClose}>
      <p className="lead">{buy ? t('confirm.buyLead', { qty: qtyText }) : t('confirm.sellLead', { qty: qtyText })}</p>
      <Breakdown q={quote} pair={pair} />
      <div className="divider" />
      <Row label={t('ticket.validity')} value={validityText} />
      {(buy ? tl : fx) && <Row label={t('confirm.fromAccount')} value={(buy ? tl : fx)!.name} />}
      {(buy ? fx : tl) && <Row label={t('confirm.toAccount')} value={(buy ? fx : tl)!.name} />}
      <ul className="fineprint">
        <li>{t('confirm.counterparty', { bank: config.bank.name })}</li>
        <li>{config.balanceMode === 'block' ? t('confirm.block') : t('confirm.noBlock')}</li>
        <li>{t('confirm.partial')}</li>
      </ul>
      {error && <div className="error-text">{error}</div>}
      <div className="actions">
        <button className="btn ghost" disabled={busy} onClick={onClose}>
          {t('confirm.cancel')}
        </button>
        <button className={`btn primary ${buy ? 'buy' : 'sell'}`} disabled={busy} onClick={submit}>
          {busy ? <span className="spinner small" /> : `${t('confirm.submit')} · ${formatMoney(quote.total, quote.currency, locale)}`}
        </button>
      </div>
    </Sheet>
  );
}
