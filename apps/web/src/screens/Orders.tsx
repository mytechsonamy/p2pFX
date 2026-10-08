import { useState } from 'react';
import { useExchange } from '../store';
import { Breakdown, Empty, Row, Segmented, Sheet, SideBadge } from '../components';
import { compareDecimal, currencySymbol, formatDateTime, formatDecimal, formatMoney, formatPrice, sanitizeAmountInput, toApiDecimal, toInputText } from '../format';
import { hasKey, type StringKey } from '../i18n';
import type { Order, PairInfo } from '../types';
import { OrderBook, useQuote } from './Trade';

const OPEN = ['OPEN', 'PARTIAL', 'QUEUED'];

export function OrdersScreen() {
  const { orders, t, pair } = useExchange();
  const [view, setView] = useState<'open' | 'history'>('open');
  const [onlyPair, setOnlyPair] = useState(false);
  const list = orders
    .filter((o) => (view === 'open' ? OPEN.includes(o.status) : !OPEN.includes(o.status)))
    .filter((o) => !onlyPair || o.pair === pair);
  const openCount = orders.filter((o) => OPEN.includes(o.status)).length;

  return (
    <div className="orders">
      <Segmented
        value={view}
        onChange={setView}
        options={[
          { value: 'open', label: `${t('orders.open')}${openCount ? ` (${openCount})` : ''}` },
          { value: 'history', label: t('orders.history') },
        ]}
      />
      <label className="check">
        <input type="checkbox" checked={onlyPair} onChange={(e) => setOnlyPair(e.target.checked)} />
        {t('orders.onlyPair', { pair: `${pair.slice(0, 3)}/${pair.slice(3)}` })}
      </label>
      {list.length ? list.map((o) => <OrderCard key={o.id} order={o} />) : <Empty>{t('orders.empty')}</Empty>}
    </div>
  );
}

function OrderCard({ order: o }: { order: Order }) {
  const { t, locale, config, api, toast, errorText, upsertOrder, refreshAccounts, track } = useExchange();
  const [details, setDetails] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [amending, setAmending] = useState(false);
  const [busy, setBusy] = useState(false);
  const pair = config.pairs.find((p) => p.symbol === o.pair);
  const base = o.pair.slice(0, 3);
  const quote = o.pair.slice(3);
  const decimals = pair?.baseDecimals ?? 2;
  const open = OPEN.includes(o.status);
  const filledPct = (Number(o.filledQty) / Number(o.qty)) * 100;

  const cancel = async () => {
    setBusy(true);
    try {
      upsertOrder(await api.cancel(o.id));
      refreshAccounts();
      track('order_cancelled', { pair: o.pair, side: o.side });
      toast(t('orders.cancelled'));
      setConfirmCancel(false);
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="card order">
      <header>
        <SideBadge side={o.side} />
        <strong>
          {formatDecimal(o.qty, locale, decimals)} {currencySymbol(base)}
        </strong>
        <span className="muted">@ {formatPrice(o.price, locale)} {currencySymbol(quote)}</span>
        <span className={`status s-${o.status.toLowerCase()}`}>{t(`status.${o.status}`)}</span>
      </header>
      {o.amendedAt && <span className="pill">{t('orders.amended')}</span>}
      {(o.status === 'PARTIAL' || Number(o.filledQty) > 0) && (
        <div className="progress" aria-label={t('orders.filled', { filled: o.filledQty, qty: o.qty })}>
          <span style={{ width: `${filledPct}%` }} />
        </div>
      )}
      <div className="meta">
        {Number(o.filledQty) > 0 && (
          <span>{t('orders.filled', { filled: formatDecimal(o.filledQty, locale, decimals), qty: formatDecimal(o.qty, locale, decimals) })}</span>
        )}
        {open ? (
          <span>
            {t(`validity.${o.validity}`)} · {t('orders.validUntil', { date: formatDateTime(o.expiresAt, locale, config.tradingHours.timezone) })}
          </span>
        ) : (
          <span>{formatDateTime(o.updatedAt, locale, config.tradingHours.timezone)}</span>
        )}
        {o.cancelReason && hasKey(`reason.${o.cancelReason}`) && (o.status === 'CANCELLED' || o.status === 'REJECTED') && (
          <span>{t(`reason.${o.cancelReason}` as StringKey)}</span>
        )}
      </div>
      <div className="order-actions">
        <button className="link" onClick={() => setDetails(true)}>
          {t('orders.details')}
        </button>
        {open && o.type !== 'MARKET' && pair && (
          <button className="btn small ghost" onClick={() => setAmending(true)}>
            {t('orders.amend')}
          </button>
        )}
        {open && (
          <button className="btn small danger" onClick={() => setConfirmCancel(true)}>
            {t('orders.cancel')}
          </button>
        )}
      </div>

      {details && pair && (
        <Sheet title={t('orders.details')} onClose={() => setDetails(false)}>
          <Row label={t(`status.${o.status}`)} value={formatDateTime(o.createdAt, locale, config.tradingHours.timezone)} />
          <Breakdown q={o.quote} pair={pair} />
          <Row label={t('ticket.validity')} value={`${t(`validity.${o.validity}`)} · ${formatDateTime(o.expiresAt, locale, config.tradingHours.timezone)}`} />
        </Sheet>
      )}
      {amending && pair && <AmendSheet order={o} pair={pair} onClose={() => setAmending(false)} />}
      {confirmCancel && (
        <Sheet title={t('orders.cancel')} onClose={() => !busy && setConfirmCancel(false)}>
          <p className="lead">{t('orders.cancelConfirm')}</p>
          <div className="actions">
            <button className="btn ghost" disabled={busy} onClick={() => setConfirmCancel(false)}>
              {t('confirm.cancel')}
            </button>
            <button className="btn primary danger" disabled={busy} onClick={cancel}>
              {busy ? <span className="spinner small" /> : t('orders.cancel')}
            </button>
          </div>
        </Sheet>
      )}
    </article>
  );
}

/**
 * Changing an open order: the market around it (reference rate, best prices, the bank's rate and the book with the
 * order's own level marked), the new price and quantity, what the change means (closer to or further from the market,
 * keeps or loses its place in the queue, trades at once) and the new breakdown for what is left, priced with the
 * bank's current fees.
 */
function AmendSheet({ order: o, pair, onClose }: { order: Order; pair: PairInfo; onClose: () => void }) {
  const { api, t, locale, rates, books, bankRates, config, toast, errorText, upsertOrder, refreshAccounts, track } = useExchange();
  const [price, setPrice] = useState(o.price);
  const [qty, setQty] = useState(toInputText(o.qty, locale));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const buy = o.side === 'BUY';
  const rate = rates[o.pair];
  const book = books[o.pair];
  const bank = bankRates[o.pair];
  const bestBid = book?.bids[0]?.price;
  const bestAsk = book?.asks[0]?.price;

  const newQty = toApiDecimal(qty);
  const newPrice = toApiDecimal(price);
  const remaining = newQty ? Number(newQty) - Number(o.filledQty) : 0;
  const remainingText = remaining > 0 ? formatDecimal(remaining.toFixed(pair.baseDecimals), locale, pair.baseDecimals) : '0';
  const { quote, error: quoteError, loading } = useQuote(pair, o.side, 'LIMIT', remaining > 0 ? remaining.toFixed(pair.baseDecimals) : undefined, newPrice);

  const priceMove = newPrice ? compareDecimal(newPrice, o.price) : 0;
  const unchanged = !!newPrice && !!newQty && priceMove === 0 && compareDecimal(newQty, o.qty) === 0;
  // Closer to the market: a higher bid or a lower offer.
  const towardMarket = buy ? priceMove > 0 : priceMove < 0;
  const keepsPlace = priceMove === 0 && !!newQty && compareDecimal(newQty, o.qty) <= 0;
  const opposite = buy ? bestAsk : bestBid;
  const tradesNow = !!newPrice && !!opposite && (buy ? compareDecimal(newPrice, opposite) >= 0 : compareDecimal(newPrice, opposite) <= 0);

  const problems: string[] = [];
  if (newQty && compareDecimal(newQty, o.filledQty) <= 0) problems.push(t('amend.qtyAboveFilled', { filled: formatDecimal(o.filledQty, locale, pair.baseDecimals) }));
  if (newPrice && rate && (compareDecimal(newPrice, rate.bandLow) < 0 || compareDecimal(newPrice, rate.bandHigh) > 0)) problems.push(t('error.PRICE_OUT_OF_BAND'));
  if (quoteError) problems.push(quoteError);
  const canSubmit = !!quote && !loading && !unchanged && !problems.length;

  const submit = async () => {
    if (!newPrice || !newQty) return;
    setBusy(true);
    setError(undefined);
    try {
      const updated = await api.amend(o.id, { price: newPrice, qty: newQty });
      upsertOrder(updated);
      refreshAccounts();
      track('order_amended', { pair: o.pair, side: o.side });
      toast(updated.status === 'FILLED' ? t('amend.filled') : t('amend.done'), 'success');
      onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  const money = (v: string) => formatMoney(v, pair.quote, locale);
  return (
    <Sheet title={t('amend.title')} onClose={busy ? () => {} : onClose}>
      <p className="lead">
        {t(buy ? 'amend.leadBuy' : 'amend.leadSell', {
          qty: `${formatDecimal(o.qty, locale, pair.baseDecimals)} ${currencySymbol(pair.base)}`,
          price: formatPrice(o.price, locale),
        })}
        {Number(o.filledQty) > 0 && ` ${t('orders.filled', { filled: formatDecimal(o.filledQty, locale, pair.baseDecimals), qty: formatDecimal(o.qty, locale, pair.baseDecimals) })}.`}
      </p>

      <div className="amend-market">
        <div>
          <small>{t('rate.reference')}</small>
          <strong>{rate ? formatPrice(rate.rate, locale) : '—'}</strong>
        </div>
        <div className="buy-text">
          <small>{t('rate.bestBid')}</small>
          <strong>{bestBid ? formatPrice(bestBid, locale) : '—'}</strong>
        </div>
        <div className="sell-text">
          <small>{t('rate.bestAsk')}</small>
          <strong>{bestAsk ? formatPrice(bestAsk, locale) : '—'}</strong>
        </div>
        {bank && (
          <div>
            <small>{t(buy ? 'amend.bankBuy' : 'amend.bankSell', { bank: config.bank.name })}</small>
            <strong>{formatPrice(buy ? bank.buy : bank.sell, locale)}</strong>
          </div>
        )}
      </div>

      <OrderBook pair={pair} depth={4} mine={{ side: o.side, price: o.price }} onPick={(l) => setPrice(l.price)} />

      <label className="field">
        <span>{t('ticket.price', { quote: currencySymbol(pair.quote) })}</span>
        <div className="input-wrap">
          <input inputMode="decimal" value={toInputText(price, locale)} onChange={(e) => setPrice(sanitizeAmountInput(e.target.value, 4).replace(',', '.'))} />
          <span className="suffix">{currencySymbol(pair.quote)}</span>
        </div>
        {rate && <small className="hint">{t('ticket.band', { low: formatPrice(rate.bandLow, locale), high: formatPrice(rate.bandHigh, locale) })}</small>}
      </label>
      <label className="field">
        <span>{t('ticket.qty', { base: currencySymbol(pair.base) })}</span>
        <div className="input-wrap">
          <input inputMode="decimal" value={qty} onChange={(e) => setQty(sanitizeAmountInput(e.target.value, pair.baseDecimals))} />
          <span className="suffix">{currencySymbol(pair.base)}</span>
        </div>
        {Number(o.filledQty) > 0 && (
          <small className="hint">{t('amend.remaining', { filled: formatDecimal(o.filledQty, locale, pair.baseDecimals), remaining: remainingText })}</small>
        )}
      </label>

      {!unchanged && newPrice && newQty && (
        <ul className="amend-effects">
          {priceMove !== 0 && <li className={towardMarket ? 'better' : 'worse'}>{t(towardMarket ? 'amend.toward' : 'amend.away')}</li>}
          <li>{t(keepsPlace ? 'amend.keepsPlace' : 'amend.losesPlace')}</li>
          {tradesNow && <li className="better">{t('amend.tradesNow')}</li>}
        </ul>
      )}

      {quote && !unchanged && (
        <>
          <Row label={t('amend.effectiveChange')} value={`${formatPrice(o.quote.effectivePrice, locale)} → ${formatPrice(quote.effectivePrice, locale)}`} strong />
          <Breakdown q={quote} pair={pair} compact />
          <small className="hint">{t('amend.feesNow')}</small>
        </>
      )}
      {problems.map((p) => (
        <div key={p} className="error-text">{p}</div>
      ))}
      {error && <div className="error-text">{error}</div>}

      <div className="actions">
        <button className="btn ghost" disabled={busy} onClick={onClose}>
          {t('confirm.cancel')}
        </button>
        <button className={`btn primary ${buy ? 'buy' : 'sell'}`} disabled={busy || !canSubmit} onClick={submit}>
          {busy ? <span className="spinner small" /> : quote && !unchanged ? `${t('amend.submit')} · ${money(quote.total)}` : t('amend.submit')}
        </button>
      </div>
    </Sheet>
  );
}
