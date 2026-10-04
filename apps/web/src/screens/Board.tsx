import { useMemo, useRef, useState } from 'react';
import { useExchange, usePair } from '../store';
import { Empty } from '../components';
import { addDecimal, compareDecimal, currencySymbol, formatDecimal, formatPrice, pairLabel } from '../format';
import type { Book, BookLevel, PairInfo, Side } from '../types';
import { BankRow } from '../bank';

/** The live market board: the day's numbers, full depth, a depth chart and the trade tape. */
export function BoardScreen() {
  const pair = usePair();
  return (
    <div className="board">
      <Summary pair={pair} />
      <BankRow pair={pair} />
      <DepthLadder pair={pair} />
      <DepthChart pair={pair} />
      <Tape pair={pair} />
    </div>
  );
}

function Summary({ pair }: { pair: PairInfo }) {
  const { stats, trades, rates, t, locale } = useExchange();
  const s = stats[pair.symbol];
  const lastTrade = trades[pair.symbol]?.[0];
  const rate = rates[pair.symbol];
  const base = s?.prevClose ?? s?.open;
  const change = s?.last && base ? addDecimal(s.last, '-' + base, 4) : undefined;
  const pct = change && base ? (Number(change) / Number(base)) * 100 : undefined;
  const dir = change ? compareDecimal(change, '0') : 0;
  const q = currencySymbol(pair.quote);

  return (
    <section className="card summary">
      <div className="last">
        <small>{t('board.last')}</small>
        {s?.last ? (
          <div className="last-price">
            <strong className={lastTrade?.takerSide === 'SELL' ? 'sell-text' : lastTrade ? 'buy-text' : ''}>{formatPrice(s.last, locale)}</strong>
            <span>{q}</span>
            {change && (
              <span className={`change ${dir > 0 ? 'buy-text' : dir < 0 ? 'sell-text' : 'muted'}`}>
                {dir > 0 ? '▲' : dir < 0 ? '▼' : '•'} {formatPrice(change.replace('-', ''), locale)} ({new Intl.NumberFormat(locale, { maximumFractionDigits: 2, signDisplay: 'exceptZero' }).format(pct ?? 0)}%)
                <small>{s.prevClose ? t('board.change') : t('board.changeOpen')}</small>
              </span>
            )}
          </div>
        ) : (
          <div className="last-price muted">{t('board.noTrades')}</div>
        )}
      </div>
      <dl className="stats">
        <Stat label={t('board.open')} value={s?.open ? formatPrice(s.open, locale) : '—'} />
        <Stat label={t('board.high')} value={s?.high ? formatPrice(s.high, locale) : '—'} />
        <Stat label={t('board.low')} value={s?.low ? formatPrice(s.low, locale) : '—'} />
        <Stat label={`${t('board.volume')} (${currencySymbol(pair.base)})`} value={s ? formatDecimal(s.volume, locale, 0, pair.baseDecimals) : '—'} />
        <Stat label={`${t('board.turnover')} (${q})`} value={s ? formatDecimal(s.turnover, locale, 0, 2) : '—'} />
        <Stat label={t('board.trades')} value={s ? String(s.trades) : '—'} />
      </dl>
      {rate && (
        <div className="ref-rate muted">
          {t('rate.reference')}: <strong>{formatPrice(rate.rate, locale)}</strong>
        </div>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/** Running totals from the best price outwards. */
function cumulative(levels: BookLevel[]) {
  let sum = 0;
  return levels.map((l) => (sum += Number(l.qty)));
}

const LADDER_ROWS = 10;

function DepthLadder({ pair }: { pair: PairInfo }) {
  const { books, t, locale, pickPrice } = useExchange();
  const [all, setAll] = useState(false);
  const book: Book = books[pair.symbol] ?? { pair: pair.symbol, bids: [], asks: [] };
  const depth = Math.max(book.bids.length, book.asks.length);
  const rows = all ? depth : Math.min(depth, LADDER_ROWS);
  const bidCum = cumulative(book.bids);
  const askCum = cumulative(book.asks);
  const maxCum = Math.max(1, bidCum[rows - 1] ?? bidCum.at(-1) ?? 0, askCum[rows - 1] ?? askCum.at(-1) ?? 0);
  const totalBids = book.bids.reduce((s, l) => addDecimal(s, l.qty, pair.baseDecimals), '0');
  const totalAsks = book.asks.reduce((s, l) => addDecimal(s, l.qty, pair.baseDecimals), '0');
  const bestBid = book.bids[0]?.price;
  const bestAsk = book.asks[0]?.price;
  const qty = (v: string) => formatDecimal(v, locale, 0, pair.baseDecimals);
  const pick = (price: string, side: Side) => pickPrice({ pair: pair.symbol, side, price });

  return (
    <section className="card ladder">
      <div className="card-head">
        <h3>{t('board.depth')}</h3>
        <small>
          {pairLabel(pair, locale)}
        </small>
      </div>
      <div className="ladder-grid head">
        <span>{t('board.count')}</span>
        <span>{t('book.qty')}</span>
        <span className="buy-text">{t('board.bid')}</span>
        <span className="sell-text">{t('board.ask')}</span>
        <span>{t('book.qty')}</span>
        <span>{t('board.count')}</span>
      </div>
      {rows === 0 && <Empty>{t('book.empty')}</Empty>}
      {Array.from({ length: rows }, (_, i) => {
        const b = book.bids[i];
        const a = book.asks[i];
        return (
          <div key={i} className="ladder-grid">
            <button className="half bid" disabled={!b} onClick={() => b && pick(b.price, 'SELL')} aria-label={b ? `${t('board.bid')} ${b.price}` : undefined}>
              {b && <span className="bar" style={{ width: `${(bidCum[i] / maxCum) * 100}%` }} />}
              <span className="count">{b?.count ?? ''}</span>
              <span>{b ? qty(b.qty) : ''}</span>
              <span className="price">{b ? formatPrice(b.price, locale) : ''}</span>
            </button>
            <button className="half ask" disabled={!a} onClick={() => a && pick(a.price, 'BUY')} aria-label={a ? `${t('board.ask')} ${a.price}` : undefined}>
              {a && <span className="bar" style={{ width: `${(askCum[i] / maxCum) * 100}%` }} />}
              <span className="price">{a ? formatPrice(a.price, locale) : ''}</span>
              <span>{a ? qty(a.qty) : ''}</span>
              <span className="count">{a?.count ?? ''}</span>
            </button>
          </div>
        );
      })}
      {depth > LADDER_ROWS && (
        <button className="link more" onClick={() => setAll((v) => !v)}>
          {all ? '−' : `+${depth - LADDER_ROWS}`}
        </button>
      )}
      <div className="ladder-foot">
        <span>
          {t('board.totalBids')}: <strong>{qty(totalBids)}</strong>
        </span>
        <span>
          {t('board.totalAsks')}: <strong>{qty(totalAsks)}</strong>
        </span>
        {bestBid && bestAsk && (
          <>
            <span>
              {t('board.spread')}: <strong>{formatPrice(addDecimal(bestAsk, '-' + bestBid, 4), locale)}</strong>
            </span>
            <span>
              {t('board.mid')}: <strong>{formatPrice(((Number(bestAsk) + Number(bestBid)) / 2).toFixed(4), locale)}</strong>
            </span>
          </>
        )}
      </div>
      <small className="hint muted">{t('board.tapHint')}</small>
    </section>
  );
}

const W = 340;
const H = 170;
const PAD = { l: 8, r: 8, t: 14, b: 22 };

interface Point {
  price: number;
  cum: number;
  side: Side;
}

function DepthChart({ pair }: { pair: PairInfo }) {
  const { books, t, locale } = useExchange();
  const book = books[pair.symbol];
  const [hover, setHover] = useState<Point | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const model = useMemo(() => {
    if (!book || (!book.bids.length && !book.asks.length)) return null;
    const bids = book.bids.map((l, i) => ({ price: Number(l.price), cum: cumulative(book.bids)[i], side: 'BUY' as Side }));
    const asks = book.asks.map((l, i) => ({ price: Number(l.price), cum: cumulative(book.asks)[i], side: 'SELL' as Side }));
    const prices = [...bids, ...asks].map((p) => p.price);
    let lo = Math.min(...prices);
    let hi = Math.max(...prices);
    const padX = (hi - lo || hi * 0.002) * 0.08;
    lo -= padX;
    hi += padX;
    const maxCum = Math.max(...bids.map((p) => p.cum), ...asks.map((p) => p.cum), 1);
    const x = (p: number) => PAD.l + ((p - lo) / (hi - lo)) * (W - PAD.l - PAD.r);
    const y = (c: number) => H - PAD.b - (c / maxCum) * (H - PAD.t - PAD.b);
    const y0 = H - PAD.b;
    // Step curves: bids rise to the left of the best bid, asks to the right of the best ask.
    const step = (pts: Point[], dir: -1 | 1) => {
      if (!pts.length) return { line: '', area: '' };
      let d = `M${x(pts[0].price)},${y0}`;
      pts.forEach((p, i) => {
        d += ` V${y(p.cum)}`;
        const next = pts[i + 1];
        d += ` H${next ? x(next.price) : dir < 0 ? PAD.l : W - PAD.r}`;
      });
      const end = dir < 0 ? PAD.l : W - PAD.r;
      return { line: d, area: `${d} V${y0} H${x(pts[0].price)} Z`, end };
    };
    return { bids, asks, lo, hi, maxCum, x, y, bidPath: step(bids, -1), askPath: step(asks, 1) };
  }, [book]);

  if (!model) return null;
  const { x, y } = model;
  const all = [...model.bids, ...model.asks];

  const onMove = (e: React.PointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    let best: Point | null = null;
    for (const p of all) if (!best || Math.abs(x(p.price) - px) < Math.abs(x(best.price) - px)) best = p;
    setHover(best);
  };
  const qty = (n: number) => formatDecimal(n.toFixed(pair.baseDecimals), locale, 0, pair.baseDecimals);
  const price = (n: number) => formatPrice(n.toFixed(4), locale);

  return (
    <section className="card depth-chart">
      <div className="card-head">
        <h3>{t('board.chart')}</h3>
        <small>{t('board.chartHint')}</small>
      </div>
      <div className="legend">
        <span className="key bid">{t('board.bid')}</span>
        <span className="key ask">{t('board.ask')}</span>
      </div>
      <div className="chart-wrap">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={t('board.chart')}
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={() => setHover(null)}
        >
          <line className="axis" x1={PAD.l} x2={W - PAD.r} y1={H - PAD.b} y2={H - PAD.b} />
          <path className="area bid" d={model.bidPath.area} />
          <path className="area ask" d={model.askPath.area} />
          <path className="line bid" d={model.bidPath.line} />
          <path className="line ask" d={model.askPath.line} />
          <text className="tick" x={PAD.l} y={H - 6}>{price(model.lo)}</text>
          <text className="tick" x={W - PAD.r} y={H - 6} textAnchor="end">{price(model.hi)}</text>
          <text className="tick" x={PAD.l} y={PAD.t - 3}>{qty(model.maxCum)} {currencySymbol(pair.base)}</text>
          {hover && (
            <g>
              <line className="crosshair" x1={x(hover.price)} x2={x(hover.price)} y1={PAD.t} y2={H - PAD.b} />
              <circle className={`dot ${hover.side === 'BUY' ? 'bid' : 'ask'}`} cx={x(hover.price)} cy={y(hover.cum)} r={4} />
            </g>
          )}
        </svg>
        {hover && (
          <div className="tooltip" style={{ left: `${Math.min(80, Math.max(20, (x(hover.price) / W) * 100))}%` }}>
            <strong>
              {hover.side === 'BUY' ? t('board.bid') : t('board.ask')} {price(hover.price)}
            </strong>
            <span>{t('board.cumulative', { qty: `${qty(hover.cum)} ${currencySymbol(pair.base)}` })}</span>
          </div>
        )}
      </div>
    </section>
  );
}

function Tape({ pair }: { pair: PairInfo }) {
  const { trades, t, locale, config } = useExchange();
  const list = (trades[pair.symbol] ?? []).slice(0, 30);
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: config.tradingHours.timezone });
  return (
    <section className="card tape">
      <div className="card-head">
        <h3>{t('board.tape')}</h3>
      </div>
      <div className="tape-row head">
        <span>{t('board.time')}</span>
        <span>{t('book.price')}</span>
        <span>{t('book.qty')} ({currencySymbol(pair.base)})</span>
      </div>
      {list.length === 0 && <Empty>{t('board.noTrades')}</Empty>}
      {list.map((tr) => (
        <div key={tr.id} className="tape-row flash">
          <span className="muted">{time.format(new Date(tr.at))}</span>
          <span className={tr.takerSide === 'BUY' ? 'buy-text' : 'sell-text'}>
            {tr.takerSide === 'BUY' ? '▲' : '▼'} {formatPrice(tr.price, locale)}
          </span>
          <span>{formatDecimal(tr.qty, locale, 0, pair.baseDecimals)}</span>
        </div>
      ))}
    </section>
  );
}
