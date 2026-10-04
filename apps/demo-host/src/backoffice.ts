// Bank back office: every business parameter of the platform, edited at runtime. A change is validated by the
// API, shown as a diff, saved with a reason under the operator's name as a new configuration version, and
// takes effect at once (no restart). History can be restored; shipped defaults stay flagged until confirmed.
import { canEdit, current, opsFetch, OpsError, signIn, signOut, type Operator } from './ops-session';

type Path = (string | number)[];
type Cfg = Record<string, any>;

type Field =
  | { kind: 'int' | 'number'; path: Path; label: string; unit?: string; help?: string; min?: number; max?: number; step?: number }
  | { kind: 'decimal'; path: Path; label: string; unit?: string; help?: string; optional?: boolean; placeholder?: string }
  /** A fraction stored as a decimal string ("0.002"), edited as a percentage ("0,2"). */
  | { kind: 'pct'; path: Path; label: string; help?: string }
  /** A fraction stored as a number (0.25), edited as a percentage. */
  | { kind: 'share'; path: Path; label: string; help?: string }
  | { kind: 'bool'; path: Path; label: string; help?: string }
  | { kind: 'select'; path: Path; label: string; options: [string, string][]; help?: string }
  | { kind: 'multi'; path: Path; label: string; options: [string, string][]; help?: string }
  | { kind: 'days'; path: Path; label: string }
  | { kind: 'time' | 'text' | 'color'; path: Path; label: string; help?: string }
  | { kind: 'list'; path: Path; label: string; help?: string; placeholder?: string };

interface Group {
  title?: string;
  note?: string;
  fields: Field[];
  /** A removable entry of a keyed record (a customer segment). */
  remove?: Path;
}

interface Section {
  id: string;
  title: string;
  intro: string;
  /** Assumption keys (GET /ops/config/assumptions) this section covers. */
  assumptions?: string[];
  groups?: (c: Cfg) => Group[];
  /** Keyed record that can take new entries, e.g. customer segments. */
  addKey?: { label: string; record: Path; template: (c: Cfg) => unknown };
  view?: () => Promise<string>;
}

interface Assumption {
  key: string;
  label: string;
  settled: null | { how: 'changed' | 'confirmed'; by: string; at: string; version: number };
}

const app = document.getElementById('app')!;
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const when = (iso: string) => new Date(iso).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'medium' });
const trNum = (v: string | number) => String(v).replace('.', ',');
const fromTr = (v: string) => v.trim().replace(/\s/g, '').replace(',', '.');
const DEC = /^\d+(\.\d+)?$/;
const SEGMENT_NAMES: Record<string, string> = { default: 'Bireysel (varsayılan)', premium: 'Premium', 'market-maker': 'Piyasa yapıcı (demo bot)' };
const segName = (s: string) => SEGMENT_NAMES[s] ?? s;
const DAYS = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'];

/** "0.2" → "0.002": moves the decimal point without floating point noise. */
function shift(dec: string, places: number): string {
  const [i, f = ''] = dec.split('.');
  let digits = i + f;
  let point = i.length + places;
  if (point < 0) {
    digits = '0'.repeat(-point) + digits;
    point = 0;
  }
  if (point > digits.length) digits += '0'.repeat(point - digits.length);
  const int = digits.slice(0, point).replace(/^0+(?=\d)/, '') || '0';
  const frac = digits.slice(point).replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
}

function get(obj: any, path: Path) {
  return path.reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function set(obj: any, path: Path, value: unknown) {
  const parent = get(obj, path.slice(0, -1));
  const k = path[path.length - 1];
  if (value === undefined) delete parent[k];
  else parent[k] = value;
}

// ---- state ----

let operator: Operator | undefined;
let live: { version: number; data: Cfg } | undefined;
let draft: Cfg | undefined;
let assumptions: Assumption[] = [];
let active = location.hash.slice(1) || 'overview';
let errors: string[] = [];

const dirty = () => !!live && !!draft && JSON.stringify(live.data) !== JSON.stringify(draft);
const bases = (c: Cfg) => [...new Set<string>(c.pairs.map((p: Cfg) => p.base))];
const segmentsOf = (c: Cfg, record: Path) => Object.keys(get(c, record) ?? {});

/** Diff path (pairs keyed by symbol) for a field path (pairs keyed by index). */
const diffKey = (c: Cfg, path: Path) => path.map((p, i) => (path[i - 1] === 'pairs' && typeof p === 'number' ? c.pairs[p]?.symbol : p)).join('.');

// ---- sections ----

const ccyFields = (c: Cfg, record: Path, label: (ccy: string) => string, opts: { optional?: boolean; placeholder?: string } = {}): Field[] =>
  bases(c).map((ccy) => ({ kind: 'decimal', path: [...record, ccy], label: label(ccy), unit: ccy, ...opts }));

const SECTIONS: Section[] = [
  { id: 'overview', title: 'Genel bakış', intro: '', view: overview },
  {
    id: 'pairs',
    title: 'Pariteler ve komisyon',
    intro: 'P2P eşleşmelerde bankanın taraf başı komisyonu ve parite kuralları. Komisyon kitap fiyatına eklenir (alıcı) veya düşülür (satıcı) ve onaydan önce müşteriye gösterilir.',
    assumptions: ['commission'],
    groups: (c) =>
      c.pairs.map((p: Cfg, i: number) => ({
        title: `${p.base}/${p.quote}`,
        note: commissionNote(p),
        fields: [
          { kind: 'bool', path: ['pairs', i, 'enabled'], label: 'İşleme açık' },
          { kind: 'int', path: ['pairs', i, 'commission', 'buyBips'], label: 'Alıcı komisyonu', unit: 'bip', min: 0 },
          { kind: 'int', path: ['pairs', i, 'commission', 'sellBips'], label: 'Satıcı komisyonu', unit: 'bip', min: 0 },
          { kind: 'decimal', path: ['pairs', i, 'bipSize'], label: '1 bip değeri', unit: `${p.quote} / birim`, help: 'Örn. 0,01 TL' },
          { kind: 'decimal', path: ['pairs', i, 'tickSize'], label: 'Fiyat adımı', unit: p.quote },
          { kind: 'decimal', path: ['pairs', i, 'minQty'], label: 'En küçük emir', unit: p.base },
          { kind: 'decimal', path: ['pairs', i, 'priceBandPct'], label: 'Fiyat bandı', unit: '%', help: 'Referans kurdan bu kadar uzak emirler reddedilir' },
        ] as Field[],
      })),
  },
  {
    id: 'tax',
    title: 'Kambiyo vergisi',
    intro: 'Hem alıcıdan hem satıcıdan alınan kambiyo vergisi (BSMV). Oran değişikliği yeni emirlere uygulanır; müşterinin onayladığı emirler onayladığı oranla işler.',
    assumptions: ['tax'],
    groups: () => [
      {
        fields: [
          { kind: 'pct', path: ['tax', 'buyRate'], label: 'Alıcıdan', help: 'Binde 2 için 0,2 girin' },
          { kind: 'pct', path: ['tax', 'sellRate'], label: 'Satıcıdan' },
          { kind: 'select', path: ['tax', 'base'], label: 'Matrah', options: [['effective', 'Komisyon dahil tutar'], ['book', 'Kitap fiyatı tutarı']] },
        ],
      },
    ],
  },
  {
    id: 'orders',
    title: 'Emir kuralları',
    intro: 'Bakiye bloke politikası, emir geçerlilik seçenekleri, yuvarlama ve müşteri başına emir hızı.',
    assumptions: ['balanceMode', 'validity'],
    groups: () => [
      {
        title: 'Bakiye',
        fields: [
          {
            kind: 'select',
            path: ['balanceMode'],
            label: 'Emir girişinde',
            options: [['block', 'Bakiyeyi bloke et'], ['no_block', 'Sadece kontrol et; eşleşmede yetersizse emri iptal et']],
          },
          { kind: 'select', path: ['rounding'], label: 'Yuvarlama', options: [['HALF_UP', 'Yarım yukarı'], ['HALF_EVEN', 'Bankacı yuvarlaması'], ['DOWN', 'Aşağı'], ['UP', 'Yukarı']] },
        ],
      },
      {
        title: 'Geçerlilik',
        fields: [
          { kind: 'multi', path: ['validity', 'options'], label: 'Müşterinin seçebileceği', options: [['DAY', 'Gün sonu'], ['GTD', 'Tarihe kadar'], ['GTC', 'İptal edilene kadar']] },
          { kind: 'int', path: ['validity', 'maxValidityDays'], label: 'En uzun geçerlilik', unit: 'gün', min: 1 },
        ],
      },
      {
        title: 'Emir hızı',
        fields: [
          { kind: 'int', path: ['orderRateLimit', 'max'], label: 'En fazla emir', unit: 'adet', min: 1 },
          { kind: 'int', path: ['orderRateLimit', 'windowSeconds'], label: 'Süre penceresi', unit: 'saniye', min: 1 },
        ],
      },
    ],
  },
  {
    id: 'hours',
    title: 'İşlem saatleri',
    intro: 'Pazarın açık olduğu günler ve saatler, tatiller ve kapalıyken gelen emirlerin akıbeti.',
    assumptions: ['tradingHours'],
    groups: () => [
      {
        fields: [
          { kind: 'days', path: ['tradingHours', 'days'], label: 'Açık günler' },
          { kind: 'time', path: ['tradingHours', 'open'], label: 'Açılış' },
          { kind: 'time', path: ['tradingHours', 'close'], label: 'Kapanış', help: 'Gün sonu için 24:00' },
          { kind: 'text', path: ['tradingHours', 'timezone'], label: 'Saat dilimi' },
          { kind: 'select', path: ['tradingHours', 'outsideHours'], label: 'Kapalıyken gelen emir', options: [['reject', 'Reddet'], ['queue', 'Sıraya al, açılışta işle']] },
          { kind: 'list', path: ['tradingHours', 'holidays'], label: 'Tatil günleri', placeholder: '2026-10-29', help: 'Her satıra bir tarih (YYYY-AA-GG)' },
        ],
      },
    ],
  },
  {
    id: 'limits',
    title: 'Limitler',
    intro: 'Müşteri segmentine göre tek emir ve günlük toplam emir tutarı üst sınırları (kitap fiyatından, TL).',
    assumptions: ['limits'],
    groups: (c) => [
      { title: segName('default'), fields: limitFields(['limits', 'default']) },
      ...segmentsOf(c, ['limits', 'segments']).map((s) => ({ title: segName(s), fields: limitFields(['limits', 'segments', s]), remove: ['limits', 'segments', s] })),
    ],
    addKey: { label: 'Segment ekle', record: ['limits', 'segments'], template: (c) => structuredClone(c.limits.default) },
  },
  {
    id: 'dealing',
    title: 'Banka satırı fiyatlama',
    intro: "Bankanın kendi kurundan işlem: LP'lerin en iyi fiyatına segment marjı eklenir. Marjlar bellekte tutulur, LP her fiyat gönderdiğinde veritabanı okunmaz; kaydettiğiniz an tüm sunucularda geçerli olur.",
    assumptions: ['margins', 'dealing'],
    groups: (c) => [
      {
        title: 'Genel',
        fields: [
          { kind: 'bool', path: ['dealing', 'enabled'], label: 'Banka satırı açık' },
          { kind: 'int', path: ['dealing', 'quoteTtlSeconds'], label: 'Kotasyon geçerliliği', unit: 'saniye', min: 1, max: 120 },
          { kind: 'int', path: ['dealing', 'maxStalenessMs'], label: 'LP fiyatı en fazla', unit: 'ms eski', min: 100 },
          ...ccyFields(c, ['dealing', 'maxDealQty'], (ccy) => `Tek işlem üst sınırı ${ccy}`),
        ],
      },
      { title: `Marj: ${segName('default')}`, fields: marginFields(['dealing', 'margins', 'default']) },
      ...segmentsOf(c, ['dealing', 'margins', 'segments']).map((s) => ({
        title: `Marj: ${segName(s)}`,
        fields: marginFields(['dealing', 'margins', 'segments', s]),
        remove: ['dealing', 'margins', 'segments', s],
      })),
    ],
    addKey: { label: 'Segment marjı ekle', record: ['dealing', 'margins', 'segments'], template: (c) => structuredClone(c.dealing.margins.default) },
  },
  {
    id: 'hedging',
    title: 'Pozisyon ve hedge',
    intro: "Banka pozisyonu limiti aşınca LP'lerle otomatik hedge. FX masası ekranı bu kuralları uygular.",
    assumptions: ['hedging'],
    groups: (c) => [
      {
        title: 'Kural',
        fields: [
          { kind: 'bool', path: ['dealing', 'autoHedge'], label: 'Otomatik hedge açık' },
          { kind: 'number', path: ['dealing', 'hedging', 'targetPct'], label: 'Hedef seviye', unit: '% (limitin; 0 = sıfırla)', min: 0, max: 99, step: 1 },
          { kind: 'select', path: ['dealing', 'hedging', 'split'], label: 'Dağıtım', options: [['ACROSS_LPS', "Parçaları LP'lere sırayla dağıt"], ['BEST_LP', 'Hepsi en iyi fiyatlı LP\'ye']] },
        ],
      },
      { title: 'Pozisyon limitleri', fields: ccyFields(c, ['dealing', 'positionLimits'], (ccy) => ccy, { optional: true, placeholder: 'limitsiz' }) },
      { title: 'En büyük hedge parçası', fields: ccyFields(c, ['dealing', 'hedging', 'maxClipQty'], (ccy) => ccy, { optional: true, placeholder: 'tek parça' }) },
    ],
  },
  {
    id: 'operations',
    title: 'Oturum ve settlement',
    intro: 'Müşteri oturum süresi ve core banking kayıtlarının yeniden deneme politikası.',
    assumptions: ['session', 'settlement'],
    groups: () => [
      { title: 'Oturum', fields: [{ kind: 'int', path: ['session', 'ttlMinutes'], label: 'Müşteri oturumu', unit: 'dakika', min: 1, max: 1440 }] },
      {
        title: 'Settlement',
        fields: [
          { kind: 'int', path: ['settlement', 'attempts'], label: 'Bacak başına deneme', unit: 'kez', min: 1, max: 10, help: 'Sonra işlem operasyon incelemesine düşer' },
          { kind: 'int', path: ['settlement', 'baseDelayMs'], label: 'İlk bekleme', unit: 'ms', min: 0, help: 'Her denemede iki katına çıkar' },
        ],
      },
    ],
  },
  {
    id: 'bots',
    title: 'Demo botlar',
    intro: 'Demo sırasında tahtayı canlı tutan piyasa yapıcı botlar. Sadece demo içindir; canlıda likidite bankanın kendi hesabından gelir. Değişiklikler birkaç saniye içinde botlara ulaşır.',
    assumptions: ['bots'],
    groups: (c) => [
      {
        fields: [
          { kind: 'bool', path: ['bots', 'enabled'], label: 'Botlar çalışsın' },
          { kind: 'int', path: ['bots', 'intervalMs'], label: 'Ortalama aralık', unit: 'ms', min: 200 },
          { kind: 'int', path: ['bots', 'maxOrdersPerSide'], label: 'Taraf başı en fazla emir', min: 1 },
          { kind: 'int', path: ['bots', 'offsetBips', 'min'], label: 'Referanstan en az', unit: 'bip', min: 1 },
          { kind: 'int', path: ['bots', 'offsetBips', 'max'], label: 'Referanstan en çok', unit: 'bip', min: 1 },
          { kind: 'share', path: ['bots', 'tradeShare'], label: 'Kendi aralarında işlem payı' },
          { kind: 'share', path: ['bots', 'cancelShare'], label: 'İptal payı' },
          { kind: 'text', path: ['bots', 'segment'], label: 'Segment' },
          { kind: 'list', path: ['bots', 'refs'], label: 'Bot müşterileri', help: 'Her satıra bir müşteri no' },
        ],
      },
      ...Object.keys(c.bots.lots).map((k) => ({
        title: `Emir büyüklüğü: ${k === 'default' ? 'diğer dövizler' : k}`,
        fields: (['min', 'max', 'step'] as const).map((f) => ({ kind: 'decimal', path: ['bots', 'lots', k, f], label: { min: 'En az', max: 'En çok', step: 'Adım' }[f] })) as Field[],
      })),
    ],
  },
  {
    id: 'branding',
    title: 'Marka',
    intro: 'Banka uygulaması içinde görünen ürün adı ve renkler.',
    groups: (c) => [
      {
        fields: [
          { kind: 'text', path: ['bank', 'name'], label: 'Banka adı' },
          { kind: 'text', path: ['branding', 'productName'], label: 'Ürün adı' },
          { kind: 'int', path: ['branding', 'radius'], label: 'Köşe yuvarlaklığı', unit: 'px', min: 0 },
          ...Object.keys(c.branding.colors).map((k) => ({ kind: 'color', path: ['branding', 'colors', k], label: k }) as Field),
        ],
      },
    ],
  },
  { id: 'history', title: 'Değişiklik geçmişi', intro: 'Her parametre değişikliği yeni bir versiyondur: kim, ne zaman, neden ve neyi değiştirdi. Eski bir versiyona dönmek de yeni bir versiyon olarak kaydedilir.', view: history },
  { id: 'audit', title: 'Denetim izi', intro: 'Silinemez, değiştirilemez kayıt: girişler, parametre değişiklikleri, onaylar, hedge ve settlement işlemleri.', view: auditLog },
  { id: 'users', title: 'Kullanıcılar', intro: 'Backoffice kullanıcıları ve rolleri. İzleyici sadece görür; editör parametre değiştirir; yönetici kullanıcıları da yönetir.', view: users },
];

function limitFields(base: Path): Field[] {
  return [
    { kind: 'decimal', path: [...base, 'maxOrderNotional'], label: 'Tek emir üst sınırı', unit: 'TL' },
    { kind: 'decimal', path: [...base, 'maxDailyNotional'], label: 'Günlük toplam', unit: 'TL' },
  ];
}
function marginFields(base: Path): Field[] {
  return [
    { kind: 'int', path: [...base, 'buyBips'], label: 'Müşteri alırken', unit: 'bip', min: 0 },
    { kind: 'int', path: [...base, 'sellBips'], label: 'Müşteri satarken', unit: 'bip', min: 0 },
  ];
}
function commissionNote(p: Cfg) {
  const bip = Number(p.bipSize);
  if (!bip) return '';
  const per = (b: number) => (b * bip * 1000).toLocaleString('tr-TR', { maximumFractionDigits: 2 });
  return `1.000 ${p.base} işlemde banka alıcıdan ${per(p.commission.buyBips)} ${p.quote}, satıcıdan ${per(p.commission.sellBips)} ${p.quote} kazanır.`;
}

/** Field labels and kinds by diff path, for the diff and history views. */
type FieldIndex = Map<string, { label: string; kind: Field['kind'] }>;
function labels(c: Cfg): FieldIndex {
  const out: FieldIndex = new Map();
  for (const s of SECTIONS)
    for (const g of s.groups?.(c) ?? []) for (const f of g.fields) out.set(diffKey(c, f.path), { label: `${s.title} › ${g.title ? `${g.title} › ` : ''}${f.label}`, kind: f.kind });
  return out;
}
function labelFor(map: FieldIndex, path: string) {
  if (map.has(path)) return map.get(path)!.label;
  const parent = [...map.keys()].find((k) => path.startsWith(`${k}.`));
  return parent ? `${map.get(parent)!.label} (${path.slice(parent.length + 1)})` : path;
}
/** A changed value as the operator typed it: percentages as %, decimals with a comma. */
function show(v: unknown, kind?: Field['kind']) {
  if (v === undefined) return '<em>yok</em>';
  if (kind === 'pct' && typeof v === 'string') return `%${esc(trNum(shift(v, 2)))}`;
  if (kind === 'share' && typeof v === 'number') return `%${esc(trNum(+(v * 100).toFixed(4)))}`;
  if (kind === 'bool') return v ? 'Açık' : 'Kapalı';
  if (kind === 'decimal' && typeof v === 'string') return esc(trNum(v));
  return esc(typeof v === 'string' ? v : JSON.stringify(v));
}

// ---- rendering ----

function fieldHtml(f: Field, c: Cfg) {
  const v = get(c, f.path);
  const id = `f-${f.path.join('-')}`;
  const attrs = `id="${esc(id)}" data-path='${esc(JSON.stringify(f.path))}' data-kind="${f.kind}" ${canEdit(operator) ? '' : 'disabled'}`;
  const changed = live && JSON.stringify(get(live.data, f.path)) !== JSON.stringify(v) ? ' changed' : '';
  const help = 'help' in f && f.help ? `<small>${esc(f.help)}</small>` : '';
  const unit = 'unit' in f && f.unit ? `<span class="unit">${esc(f.unit)}</span>` : '';
  let input: string;
  switch (f.kind) {
    case 'bool':
      return `<label class="field check${changed}"><input type="checkbox" ${attrs} ${v ? 'checked' : ''}/> ${esc(f.label)}${help}</label>`;
    case 'select':
      input = `<select ${attrs}>${f.options.map(([val, l]) => `<option value="${esc(val)}" ${val === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
      break;
    case 'multi':
      input = `<span class="chips">${f.options
        .map(([val, l]) => `<label><input type="checkbox" ${attrs} value="${esc(val)}" ${(v as string[]).includes(val) ? 'checked' : ''}/> ${esc(l)}</label>`)
        .join('')}</span>`;
      break;
    case 'days':
      input = `<span class="chips">${DAYS.map((d, i) => `<label><input type="checkbox" ${attrs} value="${i + 1}" ${(v as number[]).includes(i + 1) ? 'checked' : ''}/> ${d}</label>`).join('')}</span>`;
      break;
    case 'list':
      input = `<textarea rows="3" ${attrs} placeholder="${esc(f.placeholder ?? '')}">${esc((v as string[]).join('\n'))}</textarea>`;
      break;
    case 'color':
      input = `<input type="color" ${attrs} value="${esc(v)}"/>`;
      break;
    case 'time':
      input = `<input ${attrs} value="${esc(v)}" inputmode="numeric" pattern="([01]\\d|2[0-4]):[0-5]\\d" class="short"/>`;
      break;
    case 'text':
      input = `<input ${attrs} value="${esc(v)}"/>`;
      break;
    case 'pct':
      input = `<input ${attrs} value="${esc(trNum(shift(String(v), 2)))}" inputmode="decimal" class="short"/><span class="unit">%</span>`;
      break;
    case 'share':
      input = `<input ${attrs} value="${esc(trNum(+(Number(v) * 100).toFixed(4)))}" inputmode="decimal" class="short"/><span class="unit">%</span>`;
      break;
    case 'decimal':
      input = `<input ${attrs} value="${esc(v === undefined ? '' : trNum(v))}" inputmode="decimal" placeholder="${esc(f.placeholder ?? '')}"/>${unit}`;
      break;
    default:
      input = `<input type="number" ${attrs} value="${esc(v)}" ${f.min !== undefined ? `min="${f.min}"` : ''} ${f.max !== undefined ? `max="${f.max}"` : ''} step="${f.step ?? 1}" class="short"/>${unit}`;
  }
  return `<div class="field${changed}"><label for="${esc(id)}">${esc(f.label)}</label><div class="control">${input}</div>${help}</div>`;
}

function readInput(el: HTMLElement): { ok: true; value: unknown } | { ok: false; message: string } {
  const kind = el.dataset.kind!;
  const path = JSON.parse(el.dataset.path!) as Path;
  const input = el as HTMLInputElement;
  const text = 'value' in input ? input.value : '';
  switch (kind) {
    case 'bool':
      return { ok: true, value: input.checked };
    case 'multi':
    case 'days': {
      const all = [...app.querySelectorAll<HTMLInputElement>(`[data-path='${CSS.escape(el.dataset.path!)}']`)].filter((x) => x.checked).map((x) => x.value);
      return { ok: true, value: kind === 'days' ? all.map(Number) : all };
    }
    case 'list':
      return { ok: true, value: text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean) };
    case 'pct': {
      const d = fromTr(text);
      return DEC.test(d) ? { ok: true, value: shift(d, -2) } : { ok: false, message: 'yüzde olarak sayı girin' };
    }
    case 'share': {
      const d = fromTr(text);
      return DEC.test(d) && Number(d) <= 100 ? { ok: true, value: Number(shift(d, -2)) } : { ok: false, message: '0 ile 100 arası girin' };
    }
    case 'decimal': {
      const d = fromTr(text);
      if (!d) {
        const f = findField(path);
        return f && f.kind === 'decimal' && f.optional ? { ok: true, value: undefined } : { ok: false, message: 'zorunlu' };
      }
      return DEC.test(d) ? { ok: true, value: d } : { ok: false, message: 'sayı girin (örn. 0,01)' };
    }
    case 'int':
    case 'number': {
      const n = Number(fromTr(text));
      if (text.trim() === '' || !Number.isFinite(n) || (kind === 'int' && !Number.isInteger(n))) return { ok: false, message: kind === 'int' ? 'tam sayı girin' : 'sayı girin' };
      return { ok: true, value: n };
    }
    default:
      return { ok: true, value: text.trim() };
  }
}

function findField(path: Path): Field | undefined {
  const key = JSON.stringify(path);
  for (const s of SECTIONS) for (const g of s.groups?.(draft!) ?? []) for (const f of g.fields) if (JSON.stringify(f.path) === key) return f;
  return undefined;
}

function badge(keys: string[] | undefined) {
  const open = (keys ?? []).filter((k) => assumptions.find((a) => a.key === k && !a.settled)).length;
  return open ? `<span class="badge warn" title="Onaylanmamış varsayılan">${open}</span>` : '';
}

async function render() {
  if (!operator) return renderLogin();
  const section = SECTIONS.find((s) => s.id === active) ?? SECTIONS[0];
  if (section.id === 'users' && operator.role !== 'admin') {
    active = 'overview';
    return render();
  }
  const body = section.view ? await section.view() : formView(section);
  const nav = SECTIONS.filter((s) => s.id !== 'users' || operator!.role === 'admin')
    .map((s) => `<a href="#${s.id}" class="${s.id === section.id ? 'active' : ''}">${esc(s.title)}${badge(s.assumptions)}</a>`)
    .join('');
  app.innerHTML = `
    <aside>
      <div class="brand">Döviz Pazarı<small>Backoffice · ${esc(live?.data.bank.name ?? '')}</small></div>
      <nav>${nav}</nav>
      <div class="me"><strong>${esc(operator.displayName)}</strong><small>${esc(operator.username)} · ${roleName(operator.role)}</small>
        <a href="/dealer.html">FX masası</a> · <a href="/">Banka uygulaması</a> · <button id="logout" class="link">Çıkış</button></div>
    </aside>
    <main>
      <header><h1>${esc(section.title)}</h1>${section.intro ? `<p>${esc(section.intro)}</p>` : ''}
        <span class="version">Yürürlükteki versiyon: v${live?.version ?? '?'}</span></header>
      ${body}
    </main>`;
}

function formView(s: Section) {
  const c = draft!;
  const open = assumptions.filter((a) => s.assumptions?.includes(a.key) && !a.settled);
  const warn = open.length
    ? `<div class="notice warn">Bu bölümdeki varsayılanlar henüz banka tarafından onaylanmadı: ${open.map((a) => esc(a.label)).join(', ')}.
        ${canEdit(operator) ? `Değeri değiştirip kaydedebilir ya da olduğu gibi onaylayabilirsiniz. <button class="secondary" data-confirm="${open.map((a) => a.key).join(',')}">Mevcut değerleri onayla</button>` : ''}</div>`
    : '';
  const groups = (s.groups?.(c) ?? [])
    .map(
      (g) => `<section class="card">
        ${g.title || g.remove ? `<h2>${esc(g.title ?? '')}${g.remove && canEdit(operator) ? `<button class="link danger" data-remove='${esc(JSON.stringify(g.remove))}'>Kaldır</button>` : ''}</h2>` : ''}
        ${g.note ? `<p class="note">${esc(g.note)}</p>` : ''}
        <div class="fields">${g.fields.map((f) => fieldHtml(f, c)).join('')}</div>
      </section>`,
    )
    .join('');
  const add =
    s.addKey && canEdit(operator)
      ? `<form class="card add" data-add="${s.id}"><label>${esc(s.addKey.label)} <input name="key" placeholder="segment adı (örn. gold)" pattern="[a-z0-9-]{2,32}" required/></label><button class="secondary">Ekle</button></form>`
      : '';
  const errs = errors.length ? `<div class="notice error"><strong>Kaydedilemedi</strong><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : '';
  const bar = canEdit(operator)
    ? `<div class="savebar ${dirty() ? 'show' : ''}"><span>Kaydedilmemiş değişiklikler var</span><button class="secondary" id="discard">Vazgeç</button><button id="save">Değişiklikleri gözden geçir</button></div>`
    : `<div class="notice">Sadece görüntüleme yetkiniz var.</div>`;
  return `${warn}${errs}${groups}${add}${bar}`;
}

// ---- views ----

async function overview() {
  const versions = await opsFetch<any[]>('GET', '/config/versions?limit=5');
  const open = assumptions.filter((a) => !a.settled);
  const sectionOf = (key: string) => SECTIONS.find((s) => s.assumptions?.includes(key));
  const rows = assumptions
    .map((a) => {
      const s = sectionOf(a.key);
      const st = a.settled
        ? `<span class="badge ok">${a.settled.how === 'changed' ? 'Değiştirildi' : 'Onaylandı'}</span> <small>${esc(a.settled.by)} · ${when(a.settled.at)} · v${a.settled.version}</small>`
        : `<span class="badge warn">Onay bekliyor</span>`;
      return `<tr><td>${canEdit(operator) && !a.settled ? `<input type="checkbox" name="confirm" value="${a.key}"/>` : ''}</td>
        <td>${s ? `<a href="#${s.id}">${esc(a.label)}</a>` : esc(a.label)}</td><td>${st}</td></tr>`;
    })
    .join('');
  const recent = versions
    .map((v) => `<li><strong>v${v.version}</strong> ${esc(v.createdBy)} · ${when(v.createdAt)} · ${esc(v.reason ?? '')} <small>(${v.diff.length} değişiklik)</small></li>`)
    .join('');
  return `
    <section class="card">
      <h2>Banka onayı bekleyen varsayılanlar <small>${open.length} / ${assumptions.length}</small></h2>
      <p class="note">Prototip bu değerlerle geldi. Bir parametre, yetkili bir kullanıcı onu değiştirdiğinde ya da olduğu gibi onayladığında bu listeden düşer.</p>
      <form id="confirm-form"><table class="list"><tbody>${rows}</tbody></table>
      ${canEdit(operator) && open.length ? `<div class="row"><input name="reason" placeholder="Onay notu (örn. Hazine 4.10 kararı)"/><button class="secondary">Seçilenleri onayla</button></div>` : ''}</form>
    </section>
    <section class="card"><h2>Son değişiklikler</h2><ul class="plain">${recent}</ul><a href="#history">Tüm geçmiş</a></section>`;
}

async function history() {
  const versions = await opsFetch<any[]>('GET', '/config/versions?limit=100');
  const map = labels(live!.data);
  return versions
    .map(
      (v) => `<section class="card">
      <h2>v${v.version} <small>${esc(v.createdBy)} · ${when(v.createdAt)}${v.revertedFrom ? ` · v${v.revertedFrom} geri yüklendi` : ''}</small>
        ${canEdit(operator) && v.version !== live!.version ? `<button class="link" data-revert="${v.version}">Bu versiyona dön</button>` : ''}</h2>
      <p class="note">${esc(v.reason ?? '')}</p>
      ${v.diff.length ? diffTable(v.diff, map) : ''}
    </section>`,
    )
    .join('');
}

function diffTable(diff: { path: string; from: unknown; to: unknown }[], map: FieldIndex) {
  return `<table class="diff"><thead><tr><th>Parametre</th><th>Önce</th><th>Sonra</th></tr></thead><tbody>${diff
    .map((d) => {
      const kind = map.get(d.path)?.kind;
      return `<tr><td>${esc(labelFor(map, d.path))}</td><td class="from">${show(d.from, kind)}</td><td class="to">${show(d.to, kind)}</td></tr>`;
    })
    .join('')}</tbody></table>`;
}

const ACTIONS: Record<string, string> = {
  'config.update': 'Parametre değişikliği',
  'config.revert': 'Versiyona dönüş',
  'config.confirm': 'Varsayılan onayı',
  'ops.login': 'Giriş',
  'ops.user.create': 'Kullanıcı eklendi',
  'ops.user.update': 'Kullanıcı güncellendi',
  'dealing.hedge': 'Hedge',
  'rate.set': 'Referans kur',
};

async function auditLog() {
  const filter = sessionStorageGet('audit-filter') || 'backoffice';
  const rows = await opsFetch<any[]>('GET', `/audit?limit=200${filter !== 'all' ? `&action=${encodeURIComponent(filter)}` : ''}`);
  const opts = [['backoffice', 'Backoffice işlemleri'], ['config.', 'Parametreler'], ['ops.', 'Giriş ve kullanıcılar'], ['dealing.', 'Hedge'], ['settlement', 'Settlement'], ['order', 'Müşteri emirleri'], ['fill', 'Eşleşmeler'], ['all', 'Tümü']];
  const summary = (r: any) => {
    const p = r.payload ?? {};
    if (r.action.startsWith('config.') && p.changes) return `v${p.version}: ${esc(p.reason ?? '')} (${p.changes.length} değişiklik)`;
    if (r.action === 'config.confirm') {
      const names = (p.keys ?? []).map((k: string) => assumptions.find((a) => a.key === k)?.label ?? k);
      return `${esc(names.join(', '))}${p.reason ? `: ${esc(p.reason)}` : ''}`;
    }
    return `<code>${esc(JSON.stringify(p)).slice(0, 220)}</code>`;
  };
  return `<section class="card">
    <div class="row"><label>Tür <select id="audit-filter">${opts.map(([v, l]) => `<option value="${v}" ${v === filter ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
    <table class="list"><thead><tr><th>Zaman</th><th>Kim</th><th>İşlem</th><th>Ayrıntı</th></tr></thead><tbody>${rows
      .map((r) => `<tr><td>${when(r.at)}</td><td>${esc(r.actor)}</td><td>${esc(ACTIONS[r.action] ?? r.action)}</td><td>${summary(r)}</td></tr>`)
      .join('')}</tbody></table></section>`;
}

const roleName = (r: string) => ({ viewer: 'İzleyici', editor: 'Editör', admin: 'Yönetici' })[r] ?? r;
const roleSelect = (name: string, v = 'editor') =>
  `<select name="${name}">${['viewer', 'editor', 'admin'].map((r) => `<option value="${r}" ${r === v ? 'selected' : ''}>${roleName(r)}</option>`).join('')}</select>`;

async function users() {
  const list = await opsFetch<any[]>('GET', '/users');
  return `<section class="card"><table class="list"><thead><tr><th>Kullanıcı</th><th>Ad</th><th>Rol</th><th>Durum</th><th>Son giriş</th><th></th></tr></thead><tbody>${list
    .map(
      (u) => `<tr data-user="${esc(u.username)}"><td>${esc(u.username)}</td><td>${esc(u.displayName)}</td>
      <td>${roleSelect('role', u.role)}</td><td>${u.active ? 'Aktif' : '<span class="muted">Pasif</span>'}</td>
      <td>${u.lastLoginAt ? when(u.lastLoginAt) : '—'}</td>
      <td><button class="link" data-toggle="${u.active ? 'off' : 'on'}">${u.active ? 'Pasifleştir' : 'Aktifleştir'}</button>
        <button class="link" data-reset>Şifre sıfırla</button></td></tr>`,
    )
    .join('')}</tbody></table></section>
    <form class="card add" id="new-user"><h2>Yeni kullanıcı</h2>
      <div class="fields">
        <div class="field"><label>Kullanıcı adı</label><input name="username" required pattern="[a-z0-9._-]{3,32}" placeholder="ayse.k"/></div>
        <div class="field"><label>Ad soyad</label><input name="displayName" required/></div>
        <div class="field"><label>Rol</label>${roleSelect('role')}</div>
        <div class="field"><label>Geçici şifre</label><input name="password" type="password" minlength="8" required/></div>
      </div><button>Ekle</button></form>`;
}

function renderLogin(message = '') {
  app.innerHTML = `<form id="login" class="login card">
    <h1>Döviz Pazarı Backoffice</h1>
    <p class="note">Banka personeli girişi. Demo: <code>admin</code> / <code>demo-admin</code></p>
    <label>Kullanıcı adı<input name="username" autocomplete="username" required/></label>
    <label>Şifre<input name="password" type="password" autocomplete="current-password" required/></label>
    ${message ? `<p class="error">${esc(message)}</p>` : ''}
    <button>Giriş</button></form>`;
}

// ---- dialogs ----

function dialog(html: string): Promise<FormData | null> {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.innerHTML = `<form method="dialog">${html}<div class="row end"><button value="cancel" class="secondary" formnovalidate>Vazgeç</button><button value="ok">Onayla</button></div></form>`;
    document.body.append(d);
    d.addEventListener('close', () => {
      resolve(d.returnValue === 'ok' ? new FormData(d.querySelector('form')!) : null);
      d.remove();
    });
    d.showModal();
  });
}
const reasonField = (placeholder: string) =>
  `<label class="reason">Değişiklik gerekçesi <small>(denetim izine yazılır)</small><textarea name="reason" required minlength="3" rows="2" placeholder="${esc(placeholder)}"></textarea></label>`;

// ---- actions ----

async function refresh() {
  [live, assumptions] = await Promise.all([opsFetch('GET', '/config'), opsFetch<Assumption[]>('GET', '/config/assumptions')]);
  draft = structuredClone(live!.data);
}

function issueText(e: OpsError): string[] {
  if (Array.isArray(e.details)) {
    const map = labels(draft!);
    return (e.details as { path: (string | number)[]; message: string }[]).map((i) => `${labelFor(map, diffKey(draft!, i.path))}: ${i.message}`);
  }
  return [e.message];
}

async function save() {
  errors = [];
  let preview;
  try {
    preview = await opsFetch('PUT', '/config', { config: draft, reason: '', dryRun: true });
  } catch (e) {
    errors = e instanceof OpsError ? issueText(e) : [(e as Error).message];
    return render();
  }
  if (!preview.diff.length) return render();
  const form = await dialog(`<h2>Değişiklikleri onaylayın</h2>
    <p class="note">Kaydedince v${live!.version + 1} olarak yürürlüğe girer, yeniden başlatma gerekmez.</p>
    ${diffTable(preview.diff, labels(draft!))}${reasonField('Örn. Hazine komitesi 4.10.2026 kararı')}`);
  if (!form) return;
  try {
    await opsFetch('PUT', '/config', { config: draft, reason: String(form.get('reason')) });
    await refresh();
    toast(`Kaydedildi: v${live!.version} yürürlükte`);
  } catch (e) {
    errors = e instanceof OpsError ? issueText(e) : [(e as Error).message];
  }
  render();
}

function toast(text: string) {
  const box = document.querySelector('.toasts') ?? document.body.appendChild(Object.assign(document.createElement('div'), { className: 'toasts' }));
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text;
  box.append(t);
  setTimeout(() => t.remove(), 3500);
}

function sessionStorageGet(k: string) {
  try {
    return sessionStorage.getItem(k) ?? '';
  } catch {
    return '';
  }
}

app.addEventListener('input', (e) => {
  const el = e.target as HTMLElement;
  if (!el.dataset?.path || !draft) return;
  const r = readInput(el);
  const field = el.closest('.field');
  field?.classList.toggle('invalid', !r.ok);
  field?.querySelector('.err')?.remove();
  if (!r.ok) {
    field?.insertAdjacentHTML('beforeend', `<small class="err">${esc(r.message)}</small>`);
    return;
  }
  set(draft, JSON.parse(el.dataset.path) as Path, r.value);
  field?.classList.toggle('changed', JSON.stringify(get(live!.data, JSON.parse(el.dataset.path))) !== JSON.stringify(r.value));
  app.querySelector('.savebar')?.classList.toggle('show', dirty());
});
app.addEventListener('change', (e) => {
  const el = e.target as HTMLElement;
  if (el.id === 'audit-filter') {
    try {
      sessionStorage.setItem('audit-filter', (el as HTMLSelectElement).value);
    } catch {
      // ignore
    }
    render();
  }
  if (el.matches('[data-user] select[name=role]')) {
    const u = el.closest<HTMLElement>('[data-user]')!.dataset.user!;
    opsFetch('PATCH', `/users/${u}`, { role: (el as HTMLSelectElement).value }).then(() => toast('Rol güncellendi'), (err) => toast(err.message)).finally(render);
  }
});

app.addEventListener('click', async (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('button');
  if (!el) return;
  if (el.id === 'logout') {
    signOut();
    operator = undefined;
    return render();
  }
  if (el.id === 'discard') {
    draft = structuredClone(live!.data);
    errors = [];
    return render();
  }
  if (el.id === 'save') return save();
  if (el.dataset.remove) {
    e.preventDefault();
    set(draft, JSON.parse(el.dataset.remove), undefined);
    return render();
  }
  if (el.dataset.confirm) return confirmAssumptions(el.dataset.confirm.split(','));
  if (el.dataset.revert) {
    const v = Number(el.dataset.revert);
    const data = (await opsFetch('GET', `/config/versions/${v}`)).data;
    const diff = (await opsFetch('PUT', '/config', { config: data, reason: '', dryRun: true }).catch((err: OpsError) => ({ diff: [], err }))).diff;
    const form = await dialog(`<h2>v${v} geri yüklensin mi?</h2><p class="note">Yeni bir versiyon olarak kaydedilir.</p>${diffTable(diff, labels(live!.data))}${reasonField('Örn. hatalı oran girişi')}`);
    if (!form) return;
    await opsFetch('POST', '/config/revert', { version: v, reason: String(form.get('reason')) }).then(
      () => toast(`v${v} geri yüklendi`),
      (err) => toast(err.message),
    );
    await refresh();
    return render();
  }
  const row = el.closest<HTMLElement>('[data-user]');
  if (row && el.dataset.toggle) {
    await opsFetch('PATCH', `/users/${row.dataset.user}`, { active: el.dataset.toggle === 'on' }).catch((err) => toast(err.message));
    return render();
  }
  if (row && 'reset' in el.dataset) {
    const form = await dialog(`<h2>${esc(row.dataset.user)} için yeni şifre</h2><label>Geçici şifre<input name="password" type="password" minlength="8" required/></label>`);
    if (!form) return;
    await opsFetch('PATCH', `/users/${row.dataset.user}`, { password: String(form.get('password')) }).then(() => toast('Şifre değiştirildi'), (err) => toast(err.message));
  }
});

async function confirmAssumptions(keys: string[], reason?: string) {
  if (reason === undefined) {
    const names = keys.map((k) => assumptions.find((a) => a.key === k)?.label ?? k);
    const form = await dialog(`<h2>Mevcut değerler onaylansın mı?</h2><ul>${names.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
      <label class="reason">Onay notu<textarea name="reason" rows="2" placeholder="Örn. Hazine 4.10 kararı"></textarea></label>`);
    if (!form) return;
    reason = String(form.get('reason'));
  }
  assumptions = await opsFetch('POST', '/config/assumptions/confirm', { keys, reason });
  toast('Onaylandı');
  render();
}

app.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target as HTMLFormElement;
  const f = new FormData(form);
  if (form.id === 'login') {
    try {
      operator = await signIn(String(f.get('username')).trim().toLowerCase(), String(f.get('password')));
      await refresh();
      render();
    } catch (err) {
      renderLogin(
        err instanceof OpsError && err.code === 'NO_OPERATORS'
          ? 'Henüz backoffice kullanıcısı yok: .env dosyasına OPS_ADMIN_PASSWORD ekleyip API\'yi yeniden başlatın (pnpm dev:keys eksikleri ekler).'
          : err instanceof OpsError && err.status === 401
            ? 'Kullanıcı adı veya şifre hatalı'
            : (err as Error).message,
      );
    }
    return;
  }
  if (form.id === 'confirm-form') {
    const keys = f.getAll('confirm').map(String);
    if (!keys.length) return toast('Onaylanacak parametreyi seçin');
    return confirmAssumptions(keys, String(f.get('reason') ?? ''));
  }
  if (form.id === 'new-user') {
    try {
      await opsFetch('POST', '/users', Object.fromEntries(f));
      toast('Kullanıcı eklendi');
      render();
    } catch (err) {
      toast((err as Error).message);
    }
    return;
  }
  if (form.dataset.add) {
    const s = SECTIONS.find((x) => x.id === form.dataset.add)!;
    const key = String(f.get('key')).trim();
    if (get(draft, [...s.addKey!.record, key]) !== undefined) return toast('Bu segment zaten var');
    set(draft, [...s.addKey!.record, key], s.addKey!.template(draft!));
    render();
  }
});

window.addEventListener('hashchange', () => {
  active = location.hash.slice(1) || 'overview';
  errors = [];
  render();
});
window.addEventListener('beforeunload', (e) => {
  if (dirty()) e.preventDefault();
});

// Another operator's change: reload if nothing is being edited here.
setInterval(async () => {
  if (!operator || dirty()) return;
  try {
    const c = await opsFetch('GET', '/config');
    if (c.version !== live?.version) {
      await refresh();
      if (!document.querySelector('dialog')) render();
    }
  } catch {
    // offline for a moment
  }
}, 5000);

(async () => {
  const s = current();
  if (s) {
    try {
      operator = await opsFetch<Operator>('GET', '/me');
      await refresh();
    } catch {
      signOut();
      operator = undefined;
    }
  }
  render();
})();
