import { useState } from 'react';
import { useExchange } from '../store';
import { Empty, Row, Sheet, SideBadge } from '../components';
import { currencySymbol, formatDateTime, formatDecimal, formatMoney, formatPrice } from '../format';
import type { StringKey } from '../i18n';
import type { Fill, Receipt } from '../types';

export function FillsScreen() {
  const { fills, t } = useExchange();
  return <div className="fills">{fills.length ? fills.map((f) => <FillCard key={f.id} fill={f} />) : <Empty>{t('fills.empty')}</Empty>}</div>;
}

function FillCard({ fill: f }: { fill: Fill }) {
  const { t, locale, config, api, errorText } = useExchange();
  const [receipt, setReceipt] = useState<Receipt | { error: string } | null>(null);
  const pair = config.pairs.find((p) => p.symbol === f.pair);
  const base = f.pair.slice(0, 3);
  const buy = f.side === 'BUY';
  const qty = `${formatDecimal(f.qty, locale, pair?.baseDecimals ?? 2)} ${currencySymbol(base)}`;
  const money = (v: string) => formatMoney(v, f.currency, locale);
  const tz = config.tradingHours.timezone;
  const settlement = f.settlementStatus ? t(`fills.settlement.${f.settlementStatus}` as StringKey) : undefined;

  const openReceipt = () =>
    api.receipt(f.id).then(setReceipt, (e) => setReceipt({ error: errorText(e) }));

  return (
    <article className="card fill">
      <header>
        <SideBadge side={f.side} />
        <strong>{buy ? t('fills.bought', { qty }) : t('fills.sold', { qty })}</strong>
        {f.liquidity === 'BANK' && <span className="pill">{t('fills.bank')}</span>}
        {settlement && <span className={`status s-${(f.settlementStatus ?? '').toLowerCase()}`}>{settlement}</span>}
      </header>
      <div className="breakdown">
        {f.liquidity !== 'BANK' && <Row label={t('quote.bookPrice')} value={formatPrice(f.bookPrice, locale)} />}
        <Row label={t('quote.effectivePrice')} value={formatPrice(f.effectivePrice, locale)} strong />
        {f.liquidity !== 'BANK' && <Row label={t('quote.commissionTotal')} value={money(f.commission)} />}
        {Number(f.tax) > 0 && <Row label={t('fills.tax')} value={money(f.tax)} />}
        <Row label={buy ? t('quote.totalBuy') : t('quote.totalSell')} value={money(f.total)} strong />
      </div>
      <div className="order-actions">
        <span className="muted">{formatDateTime(f.createdAt, locale, tz)}</span>
        {f.receiptRef && (
          <button className="link" onClick={openReceipt}>
            {t('fills.receipt')}
          </button>
        )}
      </div>
      {receipt && (
        <Sheet title={t('receipt.title')} onClose={() => setReceipt(null)}>
          {'error' in receipt ? (
            <div className="error-text">{receipt.error}</div>
          ) : (
            <div className="receipt">
              <h3>{receipt.title}</h3>
              {receipt.lines.map((l) => (
                <Row key={l.label} label={l.label} value={l.value} />
              ))}
              <div className="divider" />
              <Row label={t('receipt.ref')} value={receipt.receiptRef} />
              <Row label={t('receipt.posted')} value={formatDateTime(receipt.postedAt, locale, tz)} />
              {receipt.reversed && <div className="error-text">{t('receipt.reversed')}</div>}
            </div>
          )}
        </Sheet>
      )}
    </article>
  );
}
