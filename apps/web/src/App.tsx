import { useEffect, useMemo, useState } from 'react';
import { createWebBridge, PROTOCOL_VERSION, type HostMessage } from '@p2p/sdk-bridge';
import { Api } from './api';
import { createTranslator } from './i18n';
import { pairLabel } from './format';
import { ExchangeProvider, useExchange, type Tab } from './store';
import { applyTheme, mergeBranding } from './theme';
import type { AppConfig, Branding } from './types';
import { TradeScreen } from './screens/Trade';
import { OrdersScreen } from './screens/Orders';
import { BoardScreen } from './screens/Board';
import { FillsScreen } from './screens/Fills';
import { AccountsScreen } from './screens/Accounts';
import { closeTopSheet } from './components';
import { BankDealSheet } from './bank';
import { checkEmbedding, parentOrigin } from './guard';

const allowedOrigins = (import.meta.env.VITE_HOST_ORIGINS ?? '').split(',').filter(Boolean);
const brandingPreviewAllowed = import.meta.env.DEV || import.meta.env.VITE_BRANDING_PREVIEW === '1';
/** Development only: accept a launch token in the URL fragment to run the app standalone in a browser. */
const urlTokenAllowed = import.meta.env.VITE_ALLOW_URL_TOKEN === '1';

type Boot =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; api: Api; config: AppConfig; branding: Branding; locale: string };

export function App() {
  const bridge = useMemo(() => createWebBridge(window, allowedOrigins), []);
  const [boot, setBoot] = useState<Boot>({ state: 'loading' });
  const [safeArea, setSafeArea] = useState<{ top?: number; bottom?: number }>({});

  useEffect(() => {
    // Launch tokens arrive only from the host bank app (`init`, then `refreshToken` after `tokenExpired`).
    const fromUrl = urlTokenAllowed ? new URLSearchParams(location.hash.slice(1)).get('token') : null;
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    const embed = checkEmbedding({ transport: bridge.transport, allowedOrigins, parentOrigin: parentOrigin(), dev: import.meta.env.DEV });
    if (!embed.ok && !fromUrl) {
      const t = createTranslator(navigator.language.startsWith('en') ? 'en' : 'tr-TR');
      setBoot({ state: 'error', message: t(embed.reason === 'notEmbedded' ? 'error.noToken' : 'error.untrustedHost') });
      return;
    }

    const waiters: ((token: string) => void)[] = [];
    let initial: HostMessage & { type: 'init' } | undefined;
    const off = bridge.onMessage((m) => {
      if (m.type === 'init') initial ??= m;
      if (m.type === 'init' || m.type === 'refreshToken') waiters.splice(0).forEach((w) => w(m.launchToken));
    });
    const nextToken = (timeoutMs: number) =>
      new Promise<string>((resolve, reject) => {
        waiters.push(resolve);
        setTimeout(() => reject(new Error('no launch token')), timeoutMs);
      });

    const api = new Api(import.meta.env.VITE_API_BASE ?? '', () => {
      bridge.send({ type: 'tokenExpired' });
      return nextToken(15_000);
    });

    (async () => {
      const launchToken = fromUrl ?? (await (bridge.send({ type: 'ready', version: PROTOCOL_VERSION }), nextToken(10_000)));
      const session = await api.startSession(launchToken);
      const config = await api.config();
      const preview = brandingPreviewAllowed ? initial?.preview?.branding : undefined;
      const branding = mergeBranding(config.branding, preview);
      if (preview?.bankName) config.bank = { ...config.bank, name: preview.bankName };
      applyTheme(branding);
      if (initial?.safeArea) setSafeArea(initial.safeArea);
      setBoot({ state: 'ready', api, config, branding, locale: initial?.locale ?? session.customer.locale ?? branding.locale });
    })().catch((e: Error) => {
      const t = createTranslator(navigator.language.startsWith('en') ? 'en' : 'tr-TR');
      setBoot({ state: 'error', message: e.message === 'no launch token' ? t('error.noToken') : t('error.generic') });
    });
    return off;
  }, [bridge]);

  const style = {
    '--safe-top': `${safeArea.top ?? 0}px`,
    '--safe-bottom': `${safeArea.bottom ?? 0}px`,
  } as React.CSSProperties;

  if (boot.state === 'loading') return <div className="boot" style={style}><div className="spinner" /></div>;
  if (boot.state === 'error') {
    return (
      <div className="boot" style={style}>
        <p>{boot.message}</p>
        {bridge.transport !== 'none' && <button className="btn ghost" onClick={() => bridge.send({ type: 'close' })}>Kapat</button>}
      </div>
    );
  }
  return (
    <ExchangeProvider api={boot.api} bridge={bridge} config={boot.config} branding={boot.branding} locale={boot.locale}>
      <div className="app" style={style}>
        <Shell />
      </div>
    </ExchangeProvider>
  );
}

const TABS: { id: Tab; icon: string }[] = [
  { id: 'trade', icon: 'M4 7h13l-3-3M20 17H7l3 3' },
  { id: 'board', icon: 'M4 20V10M10 20V4M16 20v-7M22 20H2' },
  { id: 'orders', icon: 'M6 4h12v16H6zM9 8h6M9 12h6M9 16h4' },
  { id: 'fills', icon: 'M5 12l4 4L19 6' },
  { id: 'accounts', icon: 'M3 7h18v12H3zM3 11h18' },
];

function Shell() {
  const { branding, config, t, tab, setTab, pair, setPair, bridge, connected, toasts, track, bankDeal, locale } = useExchange();

  useEffect(() => track('screen_view', { screen: tab }), [tab, track]);

  // Host back button: close a sheet, then go back to the trade tab, then leave the marketplace.
  useEffect(
    () =>
      bridge.onMessage((m) => {
        if (m.type !== 'back') return;
        if (closeTopSheet()) return;
        if (tab !== 'trade') setTab('trade');
        else bridge.send({ type: 'close' });
      }),
    [bridge, tab, setTab],
  );

  return (
    <>
      <header className="topbar">
        {branding.logoUrl ? <img className="logo" src={branding.logoUrl} alt="" /> : <span className="logo-mark">{branding.productName.slice(0, 1)}</span>}
        <strong className="title">{branding.productName}</strong>
        <span className={`live ${connected ? 'on' : ''}`} aria-hidden />
        {bridge.transport !== 'none' && (
          <button className="icon-btn" aria-label={t('close')} onClick={() => bridge.send({ type: 'close' })}>
            <svg viewBox="0 0 24 24" width="22" height="22"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          </button>
        )}
      </header>

      {(tab === 'trade' || tab === 'board' || tab === 'orders') && config.pairs.length > 1 && (
        <nav className="pairs" role="tablist">
          {config.pairs.map((p) => (
            <button key={p.symbol} role="tab" aria-selected={p.symbol === pair} className={p.symbol === pair ? 'active' : ''} onClick={() => setPair(p.symbol)}>
              {pairLabel(p, locale)}
            </button>
          ))}
        </nav>
      )}

      {!config.marketOpen && (
        <div className="banner">{t('market.closed', { open: config.tradingHours.open, close: config.tradingHours.close })}</div>
      )}

      <main className="content">
        {tab === 'trade' && <TradeScreen />}
        {tab === 'board' && <BoardScreen />}
        {tab === 'orders' && <OrdersScreen />}
        {tab === 'fills' && <FillsScreen />}
        {tab === 'accounts' && <AccountsScreen />}
      </main>

      <nav className="tabbar">
        {TABS.map((x) => (
          <button key={x.id} className={tab === x.id ? 'active' : ''} onClick={() => setTab(x.id)}>
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d={x.icon} />
            </svg>
            <span>{t(`tab.${x.id}`)}</span>
          </button>
        ))}
      </nav>

      {bankDeal && <BankDealSheet key={`${bankDeal.side}:${bankDeal.qty ?? ''}`} />}
      <div className="toasts" aria-live="polite">
        {toasts.map((x) => (
          <div key={x.id} className={`toast ${x.tone}`}>{x.text}</div>
        ))}
      </div>
    </>
  );
}
