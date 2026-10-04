import { useState } from 'react';
import { useExchange } from '../store';
import { Breakdown, Empty, Row, Segmented, Sheet, SideBadge } from '../components';
import { currencySymbol, formatDateTime, formatDecimal, formatPrice } from '../format';
import { hasKey, type StringKey } from '../i18n';
import type { Order } from '../types';

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
