// The bank's FX desk (dealer screen): LP feeds and the aggregated price, segment rates, positions with P&L,
// customer deals and LP hedges. Reads GET /ops/dealing through the demo bank backend every second.
// Changing the hedge rule or hedging by hand needs a back office sign-in (editor), so the audit log names the dealer.
import { canEdit, current, opsFetch } from './ops-session';

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
  batchId: string;
  pair: string;
  side: 'BUY' | 'SELL';
  qty: string;
  rate: string;
  lp: string;
  reason: 'AUTO' | 'MANUAL';
  at: string;
}
interface Desk {
  dealing: {
    autoHedge: boolean;
    positionLimits: Record<string, string>;
    hedging: { targetPct: number; maxClipQty: Record<string, string>; split: 'BEST_LP' | 'ACROSS_LPS' };
    margins: { default: { buyBips: number; sellBips: number }; segments: Record<string, { buyBips: number; sellBips: number }> };
  };
  pairs: PairView[];
  positions: Position[];
  deals: Deal[];
  hedges: Hedge[];
  bankBook?: { enabled: boolean; orders: { pair: string; side: 'BUY' | 'SELL'; price: string; qty: string }[] };
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
  const batches = new Map<string, number>();
  for (const h of d.hedges) batches.set(h.batchId, (batches.get(h.batchId) ?? 0) + 1);
  const hedges = d.hedges
    .map(
      (h, i) => `<tr class="${i > 0 && d.hedges[i - 1].batchId === h.batchId ? 'same-batch' : ''}"><td>${time(h.at)}${batches.get(h.batchId)! > 1 ? ' <small>parça</small>' : ''}</td><td>${h.reason === 'AUTO' ? 'Otomatik' : 'Manuel'}</td><td>${h.side === 'BUY' ? 'Banka aldı' : 'Banka sattı'}</td>
      <td class="num">${money(h.qty)} ${h.pair.slice(0, 3)}</td><td class="num">${rate(h.rate)}</td><td>${esc(h.lp)}</td></tr>`,
    )
    .join('');
  root.innerHTML = `
    <div class="desk-grid">${d.pairs.map(pairCard).join('')}</div>
    <section class="desk-card wide">
      <h2>Pozisyonlar <small>${policyText(d.dealing)}</small></h2>
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
    </div>
    ${bankBookCard(d)}`;
}

function bankBookCard(d: Desk) {
  if (!d.bankBook) return '';
  const pairs = [...new Set(d.bankBook.orders.map((o) => o.pair))];
  const col = (pair: string, side: 'BUY' | 'SELL') =>
    d.bankBook!.orders
      .filter((o) => o.pair === pair && o.side === side)
      .sort((a, b) => (side === 'SELL' ? Number(a.price) - Number(b.price) : Number(b.price) - Number(a.price)))
      .map((o) => `<tr><td class="num ${side === 'SELL' ? 'neg' : 'pos'}">${rate(o.price)}</td><td class="num">${money(o.qty)}</td></tr>`)
      .join('');
  const cards = pairs
    .map(
      (p) => `<div><h3>${p.slice(0, 3)}/${p.slice(3)}</h3><div class="desk-grid two-small">
        <table><thead><tr><th class="num">Satış</th><th class="num">Miktar</th></tr></thead><tbody>${col(p, 'SELL')}</tbody></table>
        <table><thead><tr><th class="num">Alış</th><th class="num">Miktar</th></tr></thead><tbody>${col(p, 'BUY')}</tbody></table></div></div>`,
    )
    .join('');
  return `<section class="desk-card wide"><h2>Tahtadaki banka emirleri <small>${
    d.bankBook.enabled ? 'Kademeler backoffice\'ten yönetilir, LP fiyatı oynadıkça yeniden fiyatlanır' : 'Kapalı'
  }</small></h2><div class="desk-grid">${cards || '<p class="muted">Tahtada banka emri yok</p>'}</div></section>`;
}

function policyText(d: Desk['dealing']) {
  if (!d.autoHedge) return 'Otomatik hedge kapalı';
  const h = d.hedging;
  const target = h.targetPct === 0 ? 'sıfırlanır' : `limitin %${h.targetPct}'ine indirilir`;
  return `Otomatik hedge: limit aşılınca pozisyon ${target}, ${h.split === 'ACROSS_LPS' ? "parçalar LP'lere dağıtılır" : 'en iyi LP ile yapılır'}`;
}

// Hedge rule editor: reads /ops/config, writes the dealing part back with PUT /ops/config and a reason.
const policy = document.getElementById('policy')!;
const form = document.getElementById('policy-form') as HTMLFormElement;
const msg = document.getElementById('policy-msg')!;
let current_: { data: { dealing: Desk['dealing'] & Record<string, unknown> } & Record<string, unknown> } | undefined;
const operator = current()?.operator;
const editable = canEdit(operator);

async function loadPolicy() {
  try {
    current_ = await opsFetch('GET', '/config');
  } catch {
    return;
  }
  const d = current_!.data.dealing;
  (form.elements.namedItem('autoHedge') as HTMLInputElement).checked = d.autoHedge;
  (form.elements.namedItem('targetPct') as HTMLInputElement).value = String(d.hedging.targetPct);
  (form.elements.namedItem('split') as HTMLSelectElement).value = d.hedging.split;
  document.getElementById('per-ccy')!.innerHTML = Object.keys(d.positionLimits)
    .map(
      (c) => `<fieldset><legend>${c}</legend>
        <label>Limit <input name="limit-${c}" value="${esc(d.positionLimits[c])}" inputmode="decimal" /></label>
        <label>En büyük parça <input name="clip-${c}" value="${esc(d.hedging.maxClipQty[c] ?? '')}" inputmode="decimal" placeholder="tek parça" /></label>
      </fieldset>`,
    )
    .join('');
  for (const el of form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input, select, button')) el.disabled = !editable;
  msg.innerHTML = editable
    ? `${esc(operator!.displayName)} olarak değiştiriyorsunuz`
    : `Değiştirmek için <a href="/backoffice.html">backoffice'e</a> editör olarak giriş yapın`;
  policy.hidden = false;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!current_) return;
  const f = new FormData(form);
  const d = current_.data.dealing;
  const positionLimits: Record<string, string> = {};
  const maxClipQty: Record<string, string> = {};
  for (const c of Object.keys(d.positionLimits)) {
    positionLimits[c] = String(f.get(`limit-${c}`) ?? '').trim();
    const clip = String(f.get(`clip-${c}`) ?? '').trim();
    if (clip) maxClipQty[c] = clip;
  }
  const dealing = {
    ...d,
    autoHedge: f.get('autoHedge') === 'on',
    positionLimits,
    hedging: { targetPct: Number(f.get('targetPct')), split: f.get('split'), maxClipQty },
  };
  try {
    await opsFetch('PUT', '/config', { config: { ...current_.data, dealing }, reason: String(f.get('reason') ?? '') });
    msg.textContent = 'Kaydedildi, hemen geçerli';
    (form.elements.namedItem('reason') as HTMLInputElement).value = '';
    await loadPolicy();
  } catch (err) {
    msg.textContent = `Kaydedilemedi: ${(err as Error).message.slice(0, 120)}`;
  }
});

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
  if (!editable) {
    statusEl.textContent = 'Manuel hedge için backoffice girişi gerekli';
    return;
  }
  b.disabled = true;
  await opsFetch('POST', '/dealing/hedges', { pair: b.dataset.flatten, side: b.dataset.side, qty: b.dataset.qty }).catch((err) => {
    statusEl.textContent = `Hedge yapılamadı: ${(err as Error).message.slice(0, 80)}`;
  });
  refresh();
});

loadPolicy();
refresh();
setInterval(refresh, 1000);
