import { useExchange } from '../store';
import { Row } from '../components';
import { formatMoney } from '../format';

export function AccountsScreen() {
  const { accounts, t, locale, bridge, config } = useExchange();
  const fxCurrencies = [...new Set(config.pairs.map((p) => p.base))];
  const missing = fxCurrencies.filter((c) => !accounts.some((a) => a.currency === c));
  return (
    <div className="accounts">
      {accounts.map((a) => (
        <article key={a.id} className="card account">
          <header>
            <span className="ccy">{a.currency}</span>
            <div>
              <strong>{a.name}</strong>
              {a.iban && <small className="muted">{a.iban.replace(/(.{4})/g, '$1 ').trim()}</small>}
            </div>
          </header>
          <Row label={t('accounts.available')} value={formatMoney(a.available, a.currency, locale)} strong />
          <Row label={t('accounts.balance')} value={formatMoney(a.balance, a.currency, locale)} />
          {Number(a.held) > 0 && <Row label={t('accounts.held')} value={formatMoney(a.held, a.currency, locale)} />}
        </article>
      ))}
      {missing.map((c) => (
        <div key={c} className="notice">
          {t('accounts.missing', { currency: c })}{' '}
          <button className="link" onClick={() => bridge.send({ type: 'openBankScreen', screen: 'openFxAccount', params: { currency: c } })}>
            {t('accounts.openFx')}
          </button>
        </div>
      ))}
    </div>
  );
}
