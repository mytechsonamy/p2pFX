// A fake bank mobile app: a native-looking shell around the P2P web app, talking to it over the bridge.
import { createIframeHost, type BrandingPreview, type HostMessage } from '@p2p/sdk-bridge';

declare const __WEB_APP_URL__: string;
const appUrl = new URL(__WEB_APP_URL__);

interface Brand {
  id: string;
  bankName: string;
  shellColor: string;
  /** Undefined: the deployment's own branding from GET /v1/config. */
  preview?: BrandingPreview;
}

const BRANDS: Brand[] = [
  { id: 'demo', bankName: 'Demo Bank', shellColor: '#0B5FFF' },
  {
    id: 'yildiz',
    bankName: 'Yıldız Bank',
    shellColor: '#14532D',
    preview: {
      bankName: 'Yıldız Bank',
      productName: 'Yıldız Döviz',
      radius: 4,
      colors: { primary: '#14532D', onPrimary: '#FDE68A', buy: '#15803D', sell: '#B91C1C', background: '#FFFDF7', text: '#1C1917' },
    },
  },
];

const CUSTOMERS = [
  { ref: 'demo-ayse', name: 'Ayşe' },
  { ref: 'demo-mehmet', name: 'Mehmet' },
  { ref: 'demo-zeynep', name: 'Zeynep' },
  { ref: 'demo-ali', name: 'Ali' },
];

let brand = BRANDS[0];

async function launchToken(customer: string) {
  const res = await fetch(`/bank/launch-token?customer=${encodeURIComponent(customer)}`);
  if (!res.ok) throw new Error(await res.text());
  return ((await res.json()) as { launchToken: string }).launchToken;
}

class Phone {
  private readonly el: HTMLElement;
  private readonly screen: HTMLElement;
  private readonly logEl: HTMLElement;
  private readonly select: HTMLSelectElement;
  private dispose: (() => void) | undefined;

  constructor(parent: HTMLElement, private customer: string) {
    this.el = document.createElement('section');
    this.el.className = 'phone-col';
    this.el.innerHTML = `
      <label class="who">Müşteri <select></select></label>
      <div class="phone">
        <div class="notch"></div>
        <div class="shell-bar"><button class="back" aria-label="Geri">‹</button><span class="bank"></span></div>
        <div class="screen"></div>
      </div>
      <details open><summary>Köprü mesajları</summary><ol class="log"></ol></details>`;
    parent.append(this.el);
    this.screen = this.el.querySelector('.screen')!;
    this.logEl = this.el.querySelector('.log')!;
    this.select = this.el.querySelector('select')!;
    for (const c of CUSTOMERS) this.select.add(new Option(c.name, c.ref, false, c.ref === customer));
    this.select.onchange = () => {
      this.customer = this.select.value;
      this.open();
    };
    this.open();
  }

  /** Opens the marketplace inside the bank app (what P2PExchange.launch does natively). */
  open() {
    this.dispose?.();
    this.el.querySelector<HTMLElement>('.shell-bar')!.style.background = brand.shellColor;
    this.el.querySelector('.bank')!.textContent = brand.bankName;
    this.screen.innerHTML = '';
    const iframe = document.createElement('iframe');
    iframe.src = appUrl.href;
    iframe.title = 'Döviz Pazarı';
    this.screen.append(iframe);
    const host = createIframeHost(iframe, appUrl.origin);
    const send = (m: HostMessage) => {
      this.log('→', m);
      host.send(m);
    };
    const back = this.el.querySelector<HTMLButtonElement>('.back')!;
    back.onclick = () => send({ type: 'back' });

    host.onMessage(async (m) => {
      this.log('←', m);
      try {
        switch (m.type) {
          case 'ready':
            return send({ type: 'init', launchToken: await launchToken(this.customer), locale: 'tr-TR', preview: brand.preview ? { branding: brand.preview } : undefined });
          case 'tokenExpired':
            return send({ type: 'refreshToken', launchToken: await launchToken(this.customer) });
          case 'close':
            return this.showHome();
          case 'openBankScreen':
            return this.toast(`Banka ekranı açılırdı: ${m.screen}${m.params ? ' ' + JSON.stringify(m.params) : ''}`);
        }
      } catch (e) {
        this.toast(`Hata: ${(e as Error).message}`);
      }
    });
    this.dispose = () => host.dispose();
  }

  private showHome() {
    this.dispose?.();
    this.dispose = undefined;
    const name = CUSTOMERS.find((c) => c.ref === this.customer)?.name ?? this.customer;
    this.screen.innerHTML = `
      <div class="home">
        <p>Merhaba ${name}</p>
        <div class="tiles">
          <div class="tile">Hesaplarım</div><div class="tile">Para transferi</div><div class="tile">Kartlarım</div>
          <button class="tile launch">Döviz Pazarı</button>
        </div>
      </div>`;
    this.screen.querySelector<HTMLButtonElement>('.launch')!.onclick = () => this.open();
    this.el.querySelector<HTMLButtonElement>('.back')!.onclick = null;
  }

  private toast(text: string) {
    const t = document.createElement('div');
    t.className = 'host-toast';
    t.textContent = text;
    this.el.querySelector('.phone')!.append(t);
    setTimeout(() => t.remove(), 3000);
  }

  private log(dir: string, m: { type: string }) {
    const li = document.createElement('li');
    const detail = { ...m } as Record<string, unknown>;
    if ('launchToken' in detail) detail.launchToken = '…';
    delete detail.type;
    li.innerHTML = `<b>${dir} ${m.type}</b> <code></code>`;
    li.querySelector('code')!.textContent = Object.keys(detail).length ? JSON.stringify(detail) : '';
    this.logEl.prepend(li);
    while (this.logEl.children.length > 30) this.logEl.lastElementChild!.remove();
  }
}

const phonesEl = document.getElementById('phones')!;
const phones = [new Phone(phonesEl, 'demo-ayse'), new Phone(phonesEl, 'demo-mehmet')];

const brandSelect = document.getElementById('brand') as HTMLSelectElement;
for (const b of BRANDS) brandSelect.add(new Option(b.bankName, b.id));
brandSelect.onchange = () => {
  brand = BRANDS.find((b) => b.id === brandSelect.value) ?? BRANDS[0];
  phones.forEach((p) => p.open());
};
