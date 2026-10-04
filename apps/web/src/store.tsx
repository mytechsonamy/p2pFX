import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { WebBridge, WebMessage } from '@p2p/sdk-bridge';
import { Api, ApiError } from './api';
import { Stream, type StreamMessage } from './stream';
import { createTranslator, hasKey, type Translate } from './i18n';
import type { Account, AppConfig, Book, Branding, Fill, Order, Rate } from './types';
import { formatDecimal, formatPrice } from './format';

export type Tab = 'trade' | 'orders' | 'fills' | 'accounts';

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'success' | 'error';
}

export interface Exchange {
  api: Api;
  config: AppConfig;
  branding: Branding;
  locale: string;
  t: Translate;
  /** Turkish message for an API error. */
  errorText: (e: unknown) => string;
  accounts: Account[];
  orders: Order[];
  fills: Fill[];
  books: Record<string, Book>;
  rates: Record<string, Rate>;
  pair: string;
  setPair: (p: string) => void;
  tab: Tab;
  setTab: (t: Tab) => void;
  connected: boolean;
  toasts: Toast[];
  toast: (text: string, tone?: Toast['tone']) => void;
  refreshAccounts: () => void;
  upsertOrder: (o: Order) => void;
  bridge: WebBridge;
  track: (name: string, props?: Extract<WebMessage, { type: 'analyticsEvent' }>['props']) => void;
}

const Ctx = createContext<Exchange | null>(null);

export function useExchange() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useExchange outside ExchangeProvider');
  return v;
}

interface Props {
  api: Api;
  bridge: WebBridge;
  config: AppConfig;
  branding: Branding;
  locale: string;
  children: ReactNode;
}

export function ExchangeProvider({ api, bridge, config, branding, locale, children }: Props) {
  const t = useMemo(() => createTranslator(locale, branding.strings), [locale, branding.strings]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [fills, setFills] = useState<Fill[]>([]);
  const [books, setBooks] = useState<Record<string, Book>>({});
  const [rates, setRates] = useState<Record<string, Rate>>({});
  const [pair, setPair] = useState(config.pairs[0]?.symbol ?? '');
  const [tab, setTab] = useState<Tab>('trade');
  const [connected, setConnected] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);

  const toast = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    const id = ++toastId.current;
    setToasts((ts) => [...ts, { id, text, tone }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), 4000);
  }, []);

  const errorText = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError) {
        if (e.code === 'NETWORK') return t('error.network');
        const key = `error.${e.code}`;
        if (hasKey(key)) return t(key);
      }
      return t('error.generic');
    },
    [t],
  );

  // Coalesces bursts of order/fill events into one balance refresh.
  const accountsTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const refreshAccounts = useCallback(() => {
    clearTimeout(accountsTimer.current);
    accountsTimer.current = setTimeout(() => api.accounts().then(setAccounts).catch(() => {}), 150);
  }, [api]);

  // Stream fill events carry no settlement status or receipt; the list endpoint does.
  const fillsTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const refreshFills = useCallback(
    (delay = 800) => {
      clearTimeout(fillsTimer.current);
      fillsTimer.current = setTimeout(() => api.fills().then(setFills).catch(() => {}), delay);
    },
    [api],
  );
  const pendingSettlement = fills.some((f) => !f.settlementStatus || f.settlementStatus === 'PENDING');
  useEffect(() => {
    if (!pendingSettlement) return;
    const timer = setInterval(() => refreshFills(0), 5000);
    return () => clearInterval(timer);
  }, [pendingSettlement, refreshFills]);

  const upsertOrder = useCallback((o: Order) => {
    setOrders((os) => {
      const i = os.findIndex((x) => x.id === o.id);
      if (i < 0) return [o, ...os];
      // Events can arrive out of order; keep the newest version.
      if (os[i].updatedAt > o.updatedAt) return os;
      const next = os.slice();
      next[i] = o;
      return next;
    });
  }, []);

  const track = useCallback<Exchange['track']>((name, props) => bridge.send({ type: 'analyticsEvent', name, props }), [bridge]);

  const loadAll = useCallback(async () => {
    const [acc, ord, fil] = await Promise.all([api.accounts(), api.orders(), api.fills()]);
    setAccounts(acc);
    setOrders(ord);
    setFills(fil);
    const bks = await Promise.all(config.pairs.map((p) => api.book(p.symbol)));
    setBooks(Object.fromEntries(bks.map((b) => [b.pair, b])));
  }, [api, config.pairs]);

  const loadRates = useCallback(async () => {
    const rs = await Promise.all(config.pairs.map((p) => api.rate(p.symbol).catch(() => undefined)));
    setRates((cur) => ({ ...cur, ...Object.fromEntries(rs.filter((r): r is Rate => !!r).map((r) => [r.pair, r])) }));
  }, [api, config.pairs]);

  // Latest handlers for the stream callbacks, which are created once.
  const handlers = useRef({ toast, refreshAccounts, refreshFills, upsertOrder, t, locale, loadAll });
  handlers.current = { toast, refreshAccounts, refreshFills, upsertOrder, t, locale, loadAll };

  useEffect(() => {
    loadAll().catch((e) => toast(errorText(e), 'error'));
    loadRates();
    const rateTimer = setInterval(loadRates, 30_000);

    const wsBase = new URL(import.meta.env.VITE_API_BASE || window.location.origin, window.location.href);
    wsBase.protocol = wsBase.protocol === 'https:' ? 'wss:' : 'ws:';
    const stream = new Stream(
      (token) => `${wsBase.origin}/v1/stream?token=${encodeURIComponent(token)}`,
      () => api.sessionToken,
      (m: StreamMessage) => {
        const h = handlers.current;
        if (m.channel.startsWith('book:')) {
          const b = m.data as Book;
          setBooks((cur) => ({ ...cur, [b.pair]: b }));
        } else if (m.channel === 'orders') {
          h.upsertOrder(m.data as Order);
          h.refreshAccounts();
        } else if (m.channel === 'fills') {
          const f = m.data as Fill;
          setFills((cur) => (cur.some((x) => x.id === f.id) ? cur : [f, ...cur]));
          h.refreshAccounts();
          h.refreshFills();
          h.toast(
            h.t('fills.toast', {
              side: h.t(`side.${f.side}`),
              qty: `${formatDecimal(f.qty, h.locale)} ${f.pair.slice(0, 3)}`,
              price: formatPrice(f.effectivePrice, h.locale),
            }),
            'success',
          );
        }
      },
      (up, reconnected) => {
        setConnected(up);
        // Anything that happened while the socket was down is fetched again.
        if (up && reconnected) handlers.current.loadAll().catch(() => {});
      },
      // Any authenticated call renews the session through the host, then the socket reconnects.
      () => api.config().then(() => stream.restart(), () => {}),
    );
    stream.subscribe('orders', 'fills', ...config.pairs.map((p) => `book:${p.symbol}`));
    stream.connect();
    return () => {
      clearInterval(rateTimer);
      stream.close();
    };
  }, [api, config.pairs, loadAll, loadRates, toast, errorText]);

  const value: Exchange = {
    api,
    config,
    branding,
    locale,
    t,
    errorText,
    accounts,
    orders,
    fills,
    books,
    rates,
    pair,
    setPair,
    tab,
    setTab,
    connected,
    toasts,
    toast,
    refreshAccounts,
    upsertOrder,
    bridge,
    track,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePair() {
  const { config, pair } = useExchange();
  return config.pairs.find((p) => p.symbol === pair) ?? config.pairs[0];
}
