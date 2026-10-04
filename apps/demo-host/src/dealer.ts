// The bank's FX desk (dealer screen): LP feeds and the aggregated price, segment rates, positions with P&L,
// customer deals and LP hedges. Reads GET /ops/dealing through the demo bank backend every second.

interface LpQuote {
  lp: string;
  bid: string;
  ask: string;
  at: string;
}
interface PairView {
  pair: string;
  lps: LpQuote[];
  best: { bid: string; ask: string; bidLp: string; askLp: string } | null;
  segments: Record<string, { buy: string; sell: string; buyBips: number; sellBips: number }>;
}
interface Position {
  pair: string;
  currency: string;
  qty: string;
  avgRate: string | null;
  mid: string | null;
  limit: string | null;
  realizedPnl: string;
  unrealizedPnl: string;
  deals: number;
  marginEarned: string;
  quoteCurrency: string;
}
interface Deal {
  id: string;
  pair: string;
  side: 'BUY' | 'SELL';
  qty: string;
  effectivePrice: string;
  lpRate: string;
  margin: string;
  customerRef: string;
  segment: string;
  settlementStatus: string;
  createdAt: string;
}
interface Hedge {
  pair: string;
  side: 'BUY' | 'SELL';
  qty: string;
  rate: string;
  lp: string;
  reason: 'AUTO' | 'MANUAL';
  at: string;
}
interface Desk {
  dealing: { autoHedge: boolean; margins: { default: { buyBips: number; sellBips: number }; segments: Record<string, { buyBips: number; sellBips: number }> } };
  pairs: PairView[];
  positions: Position[];
  deals: Deal[];
  hedges: Hedge[];
}

const root = document.getElementById('dealer')!;
const statusEl = document.getElementById('status')!;
const nf = (d: number) => new Intl.NumberFormat('tr-TR', { minimumFractionDigits: d, maximumFractionDigits: d });
const rate = (v: string | null) => (v == null ? '—' : nf(4).format(Number(v)));
const money = (v: string) => nf(2).format(Number(v));
const time = (iso: string) => new Date(iso).toLocaleTimeString('tr-TR');
const signed = (v: string) => `<span class="${Number(v) > 0 ? 'pos' : Number(v) < 0 ? 'neg' : ''}">${money(v)}</span>`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const segName = (s: string) => (s === 'default' ? 'Bireysel' : s === 'premium' ? 'Premium' : s);

function pairCard(p: PairView) {
  const lps = p.lps
    .map(
      (q) => `<tr><td>${esc(q.lp)}</td>
        <td class="num ${p.best?.bidLp === q.lp ? 'best' : ''}">${rate(q.bid)}</td>
        <td class="num ${p.best?.askLp === q.lp ? 'best' : ''}">${rate(q.ask)}</td></tr>`,
    )
    .join('');
  const segs = Object.entries(p.segments)
    .map(([s, r]) => `<tr><td>${segName(s)}</td><td class="num">${rate(r.sell)}</td><td class="num">${rate(r.buy)}</td><td class="num muted">${r.sellBips}/${r.buyBips} bip</td></tr>`)
    .join('');
  return `<section class="desk-card">
    <h2>${p.pair.slice(0, 3)}/${p.pair.slice(3)}</h2>
    <table><thead><tr><th>LP</th><th class="num">Alış (bid)</th><th class="num">Satış (ask)</th></tr></thead><tbody>${lps}</tbody>
      <tfoot><tr><td>En iyi</td><td class="num">${rate(p.best?.bid ?? null)}</td><td class="num">${rate(p.best?.ask ?? null)}</td></tr></tfoot></table>
    <h3>Müşteriye yayınlanan kur</h3>
    <table><thead><tr><th>Segment</th><th class="num">Bankaya sat</th><th class="num">Bankadan al</th><th class="num">Marj</th></tr></thead><tbody>${segs}</tbody></table>
  </section>`;
}

function positionRow(p: Position) {
  const qty = Number(p.qty);
  const limit = p.limit ? Number(p.limit) : 0;
  const used = limit ? Math.min(100, (Math.abs(qty) / limit) * 100) : 0;
  const side = qty > 0 ? 'Uzun' : qty < 0 ? 'Kısa' : 'Kapalı';
  return `<tr>
    <td>${p.currency}</td>
    <td class="num ${qty > 0 ? 'pos' : qty < 0 ? 'neg' : ''}">${money(p.qty)} <small>${side}</small></td>
    <td class="num">${rate(p.avgRate)}</td>
    <td class="num">${rate(p.mid)}</td>
    <td class="num">${signed(p.unrealizedPnl)}</td>
    <td class="num">${signed(p.realizedPnl)}</td>
    <td class="num">${money(p.marginEarned)} <small>(${p.deals})</small></td>
    <td><div class="limit"><span style="width:${used}%" class="${used > 80 ? 'hot' : ''}"></span></div><small>${p.limit ? nf(0).format(limit) : '—'}</small></td>
    <td>${qty !== 0 ? `<button data-flatten="${p.pair}" data-side="${qty < 0 ? 'BUY' : 'SELL'}" data-qty="${Math.abs(qty)}">Kapat</button>` : ''}</td>
  </tr>`;
}

function render(d: Desk) {
  const deals = d.deals
    .map(
      (x) => `<tr><td>${time(x.createdAt)}</td><td>${esc(x.customerRef)}</td><td>${segName(x.segment)}</td>
      <td class="${x.side === 'BUY' ? 'neg' : 'pos'}">${x.side === 'BUY' ? 'Müşteri aldı' : 'Müşteri sattı'}</td>
      <td class="num">${money(x.qty)} ${x.pair.slice(0, 3)}</td><td class="num">${rate(x.effectivePrice)}</td><td class="num muted">${rate(x.lpRate)}</td>
      <td class="num pos">${money(x.margin)}</td><td>${x.settlementStatus === 'SETTLED' ? '✓' : esc(x.settlementStatus)}</td></tr>`,
    )
    .join('');
  const hedges = d.hedges
    .map(
      (h) => `<tr><td>${time(h.at)}</td><td>${h.reason === 'AUTO' ? 'Otomatik' : 'Manuel'}</td><td>${h.side === 'BUY' ? 'Banka aldı' : 'Banka sattı'}</td>
      <td class="num">${money(h.qty)} ${h.pair.slice(0, 3)}</td><td class="num">${rate(h.rate)}</td><td>${esc(h.lp)}</td></tr>`,
    )
    .join('');
  root.innerHTML = `
    <div class="desk-grid">${d.pairs.map(pairCard).join('')}</div>
    <section class="desk-card wide">
      <h2>Pozisyonlar <small>Otomatik hedge: ${d.dealing.autoHedge ? 'açık, limit aşılınca LP ile kapatılır' : 'kapalı'}</small></h2>
      <table><thead><tr><th>Döviz</th><th class="num">Pozisyon</th><th class="num">Ort. maliyet</th><th class="num">LP orta</th>
        <th class="num">Gerçekleşmemiş K/Z (TL)</th><th class="num">Gerçekleşen K/Z (TL)</th><th class="num">Marj geliri (TL)</th><th>Limit</th><th></th></tr></thead>
        <tbody>${d.positions.map(positionRow).join('')}</tbody></table>
    </section>
    <div class="desk-grid two">
      <section class="desk-card"><h2>Müşteri işlemleri</h2>
        <table><thead><tr><th>Saat</th><th>Müşteri</th><th>Segment</th><th>Yön</th><th class="num">Miktar</th><th class="num">Kur</th><th class="num">LP</th><th class="num">Marj</th><th></th></tr></thead>
        <tbody>${deals || '<tr><td colspan="9" class="muted">Henüz bankayla işlem yok</td></tr>'}</tbody></table></section>
      <section class="desk-card"><h2>LP hedge işlemleri</h2>
        <table><thead><tr><th>Saat</th><th>Tür</th><th>Yön</th><th class="num">Miktar</th><th class="num">Kur</th><th>LP</th></tr></thead>
        <tbody>${hedges || '<tr><td colspan="6" class="muted">Henüz hedge yok</td></tr>'}</tbody></table></section>
    </div>`;
}

async function refresh() {
  try {
    const res = await fetch('/bank/ops/dealing');
    if (!res.ok) throw new Error(await res.text());
    render((await res.json()) as Desk);
    statusEl.textContent = `canlı · ${new Date().toLocaleTimeString('tr-TR')}`;
    statusEl.className = 'status-dot live';
  } catch (e) {
    statusEl.textContent = `bağlantı yok: ${(e as Error).message.slice(0, 80)}`;
    statusEl.className = 'status-dot';
  }
}

root.addEventListener('click', async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-flatten]');
  if (!b) return;
  b.disabled = true;
  await fetch('/bank/ops/dealing/hedges', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pair: b.dataset.flatten, side: b.dataset.side, qty: b.dataset.qty }),
  });
  refresh();
});

refresh();
setInterval(refresh, 1000);
