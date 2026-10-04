// End-to-end demo against a running stack, narrated in Turkish for the audience:
//   1. Ayşe sells 1,000 USD at 49.15; Mehmet sees the all-in price (49.20), confirms and buys it.
//      The bank buys from Ayşe and sells to Mehmet, both legs post to their core banking accounts,
//      each gets a dekont, and the bank earns 50 TRY commission per side.
//   2. Mehmet (premium segment) buys from the bank's own rate instead: a firm quote, one FX transaction,
//      and the bank's position and P&L on the dealer screen.
//   3. With balance blocking turned off, an order the customer can no longer cover at match time
//      is cancelled instead of settling.
//   4. When core banking is down, the fill waits for operations review; a retry settles it.
// Open the demo bank app (http://localhost:5174) next to it to watch the board and both phones update.
// Usage: pnpm demo:walkthrough
import { api, core, login, ops, placeOrder, waitFor, waitForApi } from './lib/demo-client.js';

const PAIR = 'USDTRY';
const PRICE = '49.15';
const QTY = '1000';

const tl = (v: string) => `${Number(v).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const step = (n: number, title: string) => console.log(`\n\x1b[1m${n}. ${title}\x1b[0m`);
const line = (label: string, value: string) => console.log(`   ${label.padEnd(32)} ${value}`);
const pause = () => new Promise((r) => setTimeout(r, Number(process.env.DEMO_PAUSE_MS ?? 1200)));

async function balances(token: string) {
  const accounts: { currency: string; balance: string; available: string }[] = await api('GET', '/v1/accounts', token);
  return Object.fromEntries(accounts.map((a) => [a.currency, a]));
}

async function fillIn(status: string, token: string, orderId: string) {
  return waitFor(`order ${orderId} to reach ${status}`, async () => {
    const fills: any[] = await api('GET', '/v1/fills?limit=20', token);
    return fills.find((f) => f.orderId === orderId && f.settlementStatus === status);
  });
}
const settledFill = (token: string, orderId: string) => fillIn('SETTLED', token, orderId);

await waitForApi();
const [ayse, mehmet] = await Promise.all([login('demo-ayse'), login('demo-mehmet', 'premium')]);

step(1, 'Piyasa');
const rate = await api('GET', `/v1/pairs/${PAIR}/rate`, ayse);
const book = await api('GET', `/v1/pairs/${PAIR}/book`, ayse);
line('Referans kur', rate.rate);
line('En iyi alış / satış', `${book.bids[0]?.price ?? '-'} / ${book.asks[0]?.price ?? '-'}`);
const before = { ayse: await balances(ayse), mehmet: await balances(mehmet) };
line('Ayşe', `${tl(before.ayse.USD.available)} USD, ${tl(before.ayse.TRY.available)} TL`);
line('Mehmet', `${tl(before.mehmet.USD?.available ?? '0')} USD, ${tl(before.mehmet.TRY.available)} TL`);
await pause();

step(2, `Ayşe ${QTY} USD'yi ${PRICE}'ten satışa koyuyor`);
const sellQuote = await api('POST', '/v1/orders/quote', ayse, { pair: PAIR, side: 'SELL', qty: QTY, price: PRICE });
line('Ayşe için işlem kuru', `${sellQuote.effectivePrice} (${PRICE} − ${sellQuote.commissionPerUnit} komisyon)`);
line('Eline geçecek (vergi sonrası)', `${tl(sellQuote.total)} TL`);
const sell = await placeOrder(ayse, { pair: PAIR, side: 'SELL', qty: QTY, price: PRICE, validity: 'DAY' });
line('Emir', `${sell.status}, gün sonuna kadar geçerli, ${QTY} USD bloke edildi`);
await pause();

step(3, 'Mehmet tahtada teklifi görüp onay ekranını açıyor');
const q = await api('POST', '/v1/orders/quote', mehmet, { pair: PAIR, side: 'BUY', qty: QTY, price: PRICE });
line('Eşleşme kuru', q.bookPrice);
line('Banka komisyonu (birim)', `+${q.commissionPerUnit}`);
line('İşlem kuru', q.effectivePrice);
line('İşlem tutarı', `${tl(q.notional)} TL`);
line('Banka komisyonu', `${tl(q.commission)} TL`);
line(`Kambiyo vergisi (binde ${Number(q.taxRate) * 1000})`, `${tl(q.tax)} TL`);
line('Hesabından çekilecek', `${tl(q.total)} TL`);
await pause();

step(4, 'Mehmet onaylıyor: emirler eşleşiyor, banka iki taraflı işlemi çekirdek bankacılığa yazıyor');
const buy = await placeOrder(mehmet, { pair: PAIR, side: 'BUY', qty: QTY, price: PRICE, validity: 'DAY' });
const [mFill, aFill] = await Promise.all([settledFill(mehmet, buy.id), settledFill(ayse, sell.id)]);
line('Mehmet aldı', `${mFill.qty} USD @ ${mFill.effectivePrice}, ödedi ${tl(mFill.total)} TL`);
line('Ayşe sattı', `${aFill.qty} USD @ ${aFill.effectivePrice}, aldı ${tl(aFill.total)} TL`);
const after = { ayse: await balances(ayse), mehmet: await balances(mehmet) };
line('Ayşe bakiye', `${tl(after.ayse.USD.balance)} USD, ${tl(after.ayse.TRY.balance)} TL`);
line('Mehmet bakiye', `${tl(after.mehmet.USD.balance)} USD, ${tl(after.mehmet.TRY.balance)} TL`);
await pause();

step(5, 'Mehmet\'in dekontu');
const receipt = await api('GET', `/v1/fills/${mFill.id}/receipt`, mehmet);
console.log(`   ${receipt.title} (${receipt.receiptRef})`);
for (const l of receipt.lines as { label: string; value: string }[]) line(l.label, l.value);
await pause();

step(6, 'Bankanın bu işlemden geliri');
line('Alış tarafı komisyonu', `${tl(mFill.commission)} TL`);
line('Satış tarafı komisyonu', `${tl(aFill.commission)} TL`);
line('Toplam komisyon', `${tl(String(Number(mFill.commission) + Number(aFill.commission)))} TL`);
line('Tahsil edilen kambiyo vergisi', `${tl(String(Number(mFill.tax) + Number(aFill.tax)))} TL`);
const revenue: any[] = await ops('GET', '/ops/revenue');
const usd = revenue.find((r) => r.pair === PAIR);
if (usd) line(`Bugünkü toplam (${PAIR})`, `${usd.fills} eşleşme, ${tl(usd.commission.total)} TL komisyon`);
await pause();

step(7, 'Mehmet aynı anda bankanın kendi kurundan da alabilir');
const ayseRates = await api('GET', `/v1/bank/rates/${PAIR}`, ayse);
const mehmetRates = await api('GET', `/v1/bank/rates/${PAIR}`, mehmet);
line('Banka kuru, bireysel (Ayşe)', `alış ${ayseRates.sell} / satış ${ayseRates.buy}`);
line('Banka kuru, premium (Mehmet)', `alış ${mehmetRates.sell} / satış ${mehmetRates.buy}`);
const bq = await api('POST', '/v1/bank/quotes', mehmet, { pair: PAIR, side: 'BUY', qty: '500' });
line('Kesin fiyat (10 sn geçerli)', `${bq.qty} USD @ ${bq.rate}, vergi ${tl(bq.tax)} TL, toplam ${tl(bq.total)} TL`);
const deal = await api('POST', '/v1/bank/deals', mehmet, { quoteId: bq.id });
line('Banka işlemi', `${deal.settlementStatus}, tek döviz işlemi, dekont hazır`);
const desk = await ops('GET', '/ops/dealing');
const pos = desk.positions.find((p: any) => p.pair === PAIR);
line('Bankanın USD pozisyonu', `${pos.qty} (ort. ${pos.avgRate}), marj geliri ${tl(pos.marginEarned)} TL`);
line('FX masası', 'http://localhost:5174/dealer.html');
await pause();

step(8, 'Bloke kapalıyken bakiye eşleşme anında yetersizse emir iptal olur');
const cfg = await ops('GET', '/ops/config');
await ops('PUT', '/ops/config', { ...cfg.data, balanceMode: 'no_block' });
line('Banka ayarı', 'balanceMode = no_block (girişte sadece kontrol, bloke yok)');
try {
  // A fresh customer each run, with exactly 100 USD.
  const ref = `demo-cem-${Date.now().toString(36)}`;
  await core('POST', '/admin/customers', { customerRef: ref, accounts: [{ currency: 'TRY', balance: '1000' }, { currency: 'USD', balance: '100' }] });
  const cem = await login(ref);
  const first = await placeOrder(cem, { pair: PAIR, side: 'SELL', qty: '100', price: '49.16' });
  const second = await placeOrder(cem, { pair: PAIR, side: 'SELL', qty: '100', price: '49.17' });
  line('Cem (100 USD bakiyesi var)', `iki ayrı satış emri: 100 USD @ 49.16 ve 100 USD @ 49.17, ikisi de kabul (${first.status}, ${second.status})`);
  const mBuy = await placeOrder(mehmet, { pair: PAIR, side: 'BUY', qty: '200', price: '49.17' });
  line('Mehmet', '200 USD @ 49.17 alıyor');
  await settledFill(cem, first.id);
  const cancelled = await waitFor('the second order to be cancelled', async () => {
    const o = await api('GET', `/v1/orders/${second.id}`, cem);
    return o.status === 'CANCELLED' ? o : undefined;
  });
  line('Birinci emir', 'eşleşti ve ödendi');
  line('İkinci emir', `${cancelled.status} (${cancelled.cancelReason}), müşteriye bildirim gitti`);
  const left = await api('GET', `/v1/orders/${mBuy.id}`, mehmet);
  line('Mehmet\'in emri', `${left.filledQty} USD doldu, kalan ${left.remainingQty} USD iptal ediliyor`);
  await api('DELETE', `/v1/orders/${mBuy.id}`, mehmet);
} finally {
  const current = await ops('GET', '/ops/config');
  await ops('PUT', '/ops/config', { ...current.data, balanceMode: 'block' });
  line('Banka ayarı', 'balanceMode = block (geri alındı)');
}

await pause();

step(9, 'Çekirdek bankacılık yanıt vermezse eşleşme operasyon kuyruğuna düşer, tekrar denenince tamamlanır');
const zeynep = await login('demo-zeynep');
await core('POST', '/admin/faults', { failNextPostings: 3 });
line('Mock çekirdek bankacılık', 'sonraki 3 kayıt denemesi hata verecek');
const zSell = await placeOrder(zeynep, { pair: PAIR, side: 'SELL', qty: '100', price: PRICE });
const zBuy = await placeOrder(mehmet, { pair: PAIR, side: 'BUY', qty: '100', price: PRICE });
const stuck = await fillIn('FAILED_NEEDS_REVIEW', mehmet, zBuy.id);
line('Zeynep → Mehmet 100 USD', `eşleşti, mutabakat: ${stuck.settlementStatus} (3 deneme başarısız)`);
const review: any[] = await ops('GET', '/ops/settlements?status=FAILED_NEEDS_REVIEW');
const legs = review.filter((r) => r.fillId === stuck.id);
line('Operasyon ekranı', `${legs.length} bacak inceleme bekliyor, hiçbir hesaba kayıt atılmadı`);
const retry = await ops('POST', `/ops/settlements/${legs[0].id}/retry`);
line('Operasyon "tekrar dene"', retry.outcome);
const zFill = await settledFill(zeynep, zSell.id);
line('Zeynep', `${zFill.qty} USD sattı, ${tl(zFill.total)} TL aldı, dekont hazır`);

console.log('\nDemo tamamlandı.');
