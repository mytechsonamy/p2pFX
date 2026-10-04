import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useExchange } from './store';
import { currencySymbol, formatDecimal, formatMoney, formatPrice, formatRate } from './format';
import type { PairInfo, QuoteBreakdown, Side } from './types';

// Open sheets, newest last, so the host's back button can close the top one.
const sheetStack: (() => void)[] = [];
export function closeTopSheet() {
  const close = sheetStack.at(-1);
  close?.();
  return !!close;
}

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const close = () => onCloseRef.current();
    sheetStack.push(close);
    return () => {
      sheetStack.splice(sheetStack.indexOf(close), 1);
    };
  }, []);
  // Rendered at the end of .app so it stacks above the tab bar and keeps the theme variables.
  return createPortal(
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <h2>{title}</h2>
        {children}
      </div>
    </div>,
    document.querySelector('.app') ?? document.body,
  );
}

export function SideBadge({ side }: { side: Side }) {
  const { t } = useExchange();
  return <span className={`badge ${side === 'BUY' ? 'buy' : 'sell'}`}>{t(`side.${side}`)}</span>;
}

export function Row({ label, value, strong, hint }: { label: ReactNode; value: ReactNode; strong?: boolean; hint?: ReactNode }) {
  return (
    <div className={`row ${strong ? 'strong' : ''}`}>
      <span className="label">
        {label}
        {hint && <small>{hint}</small>}
      </span>
      <span className="value">{value}</span>
    </div>
  );
}

/** The price breakdown shown on the order ticket, the confirmation sheet and order details. */
export function Breakdown({ q, pair, compact }: { q: QuoteBreakdown; pair: PairInfo; compact?: boolean }) {
  const { t, locale } = useExchange();
  const money = (v: string) => formatMoney(v, q.currency, locale, pair.quoteDecimals);
  const price = (v: string) => `${formatPrice(v, locale)} ${currencySymbol(q.currency)}`;
  const buy = q.side === 'BUY';
  const bips = Math.round(Number(q.commissionPerUnit) / Number(pair.bipSize));
  const qty = `${formatDecimal(q.qty, locale, pair.baseDecimals)} ${pair.base}`;
  return (
    <div className="breakdown">
      <Row label={t('quote.bookPrice')} value={price(q.bookPrice)} />
      <Row
        label={t('quote.commission')}
        value={`${buy ? '+' : '−'} ${formatPrice(q.commissionPerUnit, locale)}`}
        hint={t('quote.commissionPerUnit', { amount: price(q.commissionPerUnit), base: pair.base, bips })}
      />
      <Row label={t('quote.effectivePrice')} value={price(q.effectivePrice)} strong />
      <div className="divider" />
      {!compact && (
        <>
          <Row label={t('quote.notional', { qty, price: formatPrice(q.bookPrice, locale) })} value={money(q.notional)} />
          <Row label={t('quote.commissionTotal')} value={`${buy ? '+' : '−'} ${money(q.commission)}`} />
        </>
      )}
      <Row label={t('quote.gross')} value={money(q.gross)} />
      <Row label={t('quote.tax', { rate: formatRate(q.taxRate, locale) })} value={`${buy ? '+' : '−'} ${money(q.tax)}`} />
      <div className="divider" />
      <Row label={buy ? t('quote.receive') : t('quote.deliver')} value={qty} />
      <Row label={buy ? t('quote.totalBuy') : t('quote.totalSell')} value={money(q.total)} strong />
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string; tone?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="tablist">
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={o.value === value} className={`${o.value === value ? 'active' : ''} ${o.tone ?? ''}`} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
