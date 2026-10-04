import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { WebBridge, WebMessage } from '@p2p/sdk-bridge';
import { Api, ApiError } from './api';
import { Stream, type StreamMessage } from './stream';
import { createTranslator, hasKey, type Translate } from './i18n';
import type { Account, AppConfig, Book, Branding, Fill, Order, PairStats, Rate, Side, Trade } from './types';
import { addDecimal, compareDecimal, formatDecimal, formatPrice } from './format';

export type Tab = 'trade' | 'board' | 'orders' | 'fills' | 'accounts';

/** A price picked on the board, handed to the order ticket. */
export interface Pick {
  pair: string;
  side: Side;
  price: string;
}

const TAPE_LENGTH = 100;

/** Folds a new trade into the day's statistics. */
export function applyTrade(s: PairStats | undefined, t: Trade, baseDecimals: number): PairStats {
  const cur = s ?? { pair: t.pair, open: null, high: null, low: null, last: null, prevClose: null, volume: '0', turnover: '0', trades: 0 };
  return {
    ...cur,
    open: cur.open ?? t.price,
    high: cur.high == null || compareDecimal(t.price, cur.high) > 0 ? t.price : cur.high,
    low: cur.low == null || compareDecimal(t.price, cur.low) < 0 ? t.price : cur.low,
    last: t.price,
    volume: addDecimal(cur.volume, t.qty, baseDecimals),
    trades: cur.trades + 1,
  };
}

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
  /** Recent trades per pair, newest first. */
  trades: Record<string, Trade[]>;
  stats: Record<string, PairStats>;
  pick: Pick | null;
  /** Opens the order ticket with a side and price chosen on the board. */
  pickPrice: (p: Pick) => void;
  clearPick: () => void;
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
  const [trades, setTrades] = useState<Record<string, Trade[]>>({});
  const [stats, setStats] = useState<Record<string, PairStats>>({});
  const [pick, setPick] = useState<Pick | null>(null);
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

  const seenTrades = useRef(new Set<string>());
  const statsTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const refreshStats = useCallback(
    (pair: string) => {
      clearTimeout(statsTimers.current[pair]);
      statsTimers.current[pair] = setTimeout(() => api.stats(pair).then((s) => setStats((cur) => ({ ...cur, [pair]: s })), () => {}), 1000);
    },
    [api],
  );

  const loadAll = useCallback(async () => {
    const [acc, ord, fil] = await Promise.all([api.accounts(), api.orders(), api.fills()]);
    setAccounts(acc);
    setOrders(ord);
    setFills(fil);
    const [bks, trs, sts] = await Promise.all([
      Promise.all(config.pairs.map((p) => api.book(p.symbol))),
      Promise.all(config.pairs.map((p) => api.trades(p.symbol, TAPE_LENGTH))),
      Promise.all(config.pairs.map((p) => api.stats(p.symbol))),
    ]);
    setBooks(Object.fromEntries(bks.map((b) => [b.pair, b])));
    trs.flat().forEach((tr) => seenTrades.current.add(tr.id));
    setTrades(Object.fromEntries(config.pairs.map((p, i) => [p.symbol, trs[i]])));
    setStats(Object.fromEntries(sts.map((s) => [s.pair, s])));
  }, [api, config.pairs]);

  const loadRates = useCallback(async () => {
    const rs = await Promise.all(config.pairs.map((p) => api.rate(p.symbol).catch(() => undefined)));
    setRates((cur) => ({ ...cur, ...Object.fromEntries(rs.filter((r): r is Rate => !!r).map((r) => [r.pair, r])) }));
  }, [api, config.pairs]);

  // Latest handlers for the stream callbacks, which are created once.
  const handlers = useRef({ toast, refreshAccounts, refreshFills, refreshStats, upsertOrder, t, locale, loadAll });
  handlers.current = { toast, refreshAccounts, refreshFills, refreshStats, upsertOrder, t, locale, loadAll };

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
        } else if (m.channel.startsWith('trades:')) {
          const tr = m.data as Trade;
          const decimals = config.pairs.find((p) => p.symbol === tr.pair)?.baseDecimals ?? 2;
          if (seenTrades.current.has(tr.id)) return;
          seenTrades.current.add(tr.id);
          setTrades((cur) => ({ ...cur, [tr.pair]: [tr, ...(cur[tr.pair] ?? [])].slice(0, TAPE_LENGTH) }));
          // Updated at once from the trade; turnover and the rest are refreshed from the server shortly after.
          setStats((s) => ({ ...s, [tr.pair]: applyTrade(s[tr.pair], tr, decimals) }));
          h.refreshStats(tr.pair);
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
    stream.subscribe('orders', 'fills', ...config.pairs.flatMap((p) => [`book:${p.symbol}`, `trades:${p.symbol}`]));
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
    trades,
    stats,
    pick,
    pickPrice: (p: Pick) => {
      setPick(p);
      setPair(p.pair);
      setTab('trade');
    },
    clearPick: () => setPick(null),
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
