# Demo akışı

Bankaya 10 dakikalık sunum için. Hazırlık tek komut:

```sh
docker compose up --build
```

`api` servisi sağlıklı olunca hazır. Tarayıcıda **http://localhost:5174** açılır: aynı bankanın
uygulamasında iki müşteri, solda Ayşe, sağda Mehmet. Tahta boş görünmez: bankanın merdiveni (Bank MM) ve
bankanın botu (Bot MM) LP fiyatı etrafında gerçek banka emirleri tutar ve fiyat oynadıkça yeniler. Botlar
kendi aralarında ve banka merdiveniyle işlem yapmaz (aynı principal); müşteri onların emrini alabilir, bu
işlemler P2P sayılmaz (C2B). Stack yeniden başlatılınca demo baştan başlar.

## 1. Uygulama içinde uygulama (1 dk)

- Bankanın kendi uygulaması (mavi bar) içinde "Döviz Pazarı" açık. Ayrı giriş yok: banka backend'i oturum
  açmış müşteri için kendi anahtarıyla imzalı, en fazla 60 sn geçerli, tek kullanımlık bir token üretir; P2P
  platformu imzayı doğrulayıp 30 dakikalık oturuma çevirir.
- Dışarıdan erişim yok: http://localhost:5173 adresini doğrudan tarayıcıda açın, uygulama "yalnızca
  bankanızın mobil uygulaması içinden açılabilir" der ve API'ye hiç gitmez. Başka bir sitenin içine
  gömülmeye çalışılırsa tarayıcı da reddeder (`frame-ancestors`).
- Telefonların altındaki **Köprü mesajları**: banka uygulaması ile gömülü uygulama arasındaki mesajlar
  (`ready`, `init`, geri tuşu, kapat). Native SDK'nın yapacağı iş bu.
- Sağ üstte **Banka markası** → Yıldız Bank: aynı build, başka bankanın renkleri. Her banka kendi kurulumunu
  alır.

## 2. Tahta (1 dk)

Mehmet'te **Tahta**: son işlem ve günlük değişim, açılış/en yüksek/en düşük, hacim, derinlik merdiveni,
derinlik grafiği, son işlemler. Referans kur 49,1500; tahtada en iyi alış ve satış 49,1100 ile 49,2000 civarında, botlar
oynattıkça değişir.

## 3. İşlem (3 dk)

1. Al-Sat ekranının üstündeki kart referans kuru ve tahtadaki en iyi alış/satışı gösterir (emir defteriyle
   aynı fiyatlar, komisyonsuz). Kurlar 4 hanelidir.
2. Ayşe: **Al-Sat** → Sat, 1.000 USD, fiyat 49,15, geçerlilik Gün sonu. Onay ekranında işlem kuru 49,1000
   (49,1500 − 0,0500 komisyon); satışta kambiyo vergisi yok, hesabına yatacak 49.100,00 TL. Onayla: 1.000 USD bloke.
3. Mehmet'in emir defterinde 49,15'te Ayşe'nin teklifi anında belirir. Fiyata dokun: alış emri dolu gelir.
   Onay ekranı: **49,1500 + 0,0500 = 49,2000**, 50 TL komisyon, 98,40 TL vergi, hesabından çekilecek 49.298,40 TL.
4. Onayla. İki telefon da güncellenir, yeni işlem tahtaya düşer.
5. **İşlemlerim** → işlem → dekont. Banka Ayşe'den aldı, Mehmet'e sattı; iki ayrı kayıt müşterilerin vadesiz
   hesaplarına atıldı, ayrı cüzdan yok.

Mesaj: banka 1.000 USD'lik eşleşmeden 50 TL alış, 50 TL satış komisyonu kazandı ve iki taraftan kambiyo
vergisini tahsil etti; fiyat riski almadı.

## 4. Bankanın kendi kuru ve FX masası (2 dk)

1. Tahtanın ve emir defterinin üstünde **Banka** satırı: bankanın LP'lerden aldığı en iyi fiyat + müşterinin
   segment marjı. Ayşe bireysel (1000 pip = 0,10 TL), Mehmet premium (400 pip) segmentte: aynı anda iki telefonda farklı
   kur görünür, LP fiyatı oynadıkça canlı değişir.
2. Mehmet: **Bankadan al** → 1.000 USD → **Fiyat al**. 10 saniyelik kesin fiyat, vergi ve toplam; geri sayım
   bitince yeniden fiyat ister. Onayla: tek bir döviz işlemi, anında dekont, **İşlemlerim**'de "Banka" etiketi.
   Emir girerken bankanın kuru P2P'den iyiyse bilet bunu söyler.
3. Yeni sekmede **http://localhost:5174/dealer.html** (Banka FX masası): üç LP'nin fiyatı ve en iyileri,
   segment kurları, USD pozisyonu (−1.000, kısa), ortalama maliyet, gerçekleşmemiş/gerçekleşen K/Z, marj
   geliri. **Kapat** pozisyonu LP'lerle kapatır. Limit (USD 100.000) aşılırsa sistem kendisi hedge eder.
4. Üstteki **Otomatik hedge kuralı**: limit, hedef seviye (limitin yüzdesi, 0 = sıfırla), en büyük LP
   parçası ve dağıtım (LP'lere sırayla ya da hepsi en iyi LP'ye). Örnek: USD limitini 1.000, hedefi %50,
   parçayı 500 yapıp kaydedin; Mehmet bankadan 2.000 USD alınca pozisyon 500'e iner, hedge üç parça halinde
   LP-A, LP-B, LP-C'ye gider.

5. Tahtada bankanın kendi emirleri de var: banka kurunun %0,02 uzağından başlayan 3 kademe (USD: 5.000,
   10.000, 20.000). Fiyatlar komisyon düşülmüş olarak girilir, müşteri komisyonla birlikte banka kurundan
   daha iyi bir fiyat bulamaz. FX masasında "Tahtadaki banka emirleri", ayarlar backoffice'te "Banka emirleri
   (tahta)". Müşteri bir kademeyi alınca kademe yeniden dolar, işlem bankanın pozisyonuna yazılır.

Mesaj: P2P eşleşmede banka risk almadan komisyon kazanır; kendi kurunda marj kazanır ve pozisyonu yönetir.
İkisi aynı uygulamada, müşteri iyi olanı seçer.

## 5. Senaryolu demo (2 dk)

Telefonlar açıkken ikinci terminalde:

```sh
docker compose run --rm walkthrough
```

Betik aynı işlemi API üzerinden yapar ve ekrana Türkçe anlatır; telefonlar ve tahta canlı güncellenir.
Ardından iki banka seçeneğini gösterir:

- **Bloke kapalı** (`balanceMode = no_block`): müşteri 100 USD'si varken iki ayrı 100 USD satış emri
  verebilir; eşleşme anında ikincisini karşılayamaz, emir `INSUFFICIENT_BALANCE` ile iptal olur ve müşteriye
  bildirim gider. Betik sonunda ayarı geri alır.
- **Çekirdek bankacılık hatası**: mock çekirdek 3 kaydı reddeder, eşleşme operasyon kuyruğuna düşer, hiçbir
  hesaba yarım kayıt atılmaz; operasyon "tekrar dene" ile tamamlanır.

Betik her çalıştırmada yeni bir müşteri açar, istediğiniz kadar tekrar çalıştırılabilir.

## Sorulara hazır

| Soru | Nerede |
|---|---|
| Komisyon, vergi oranı, bloke, geçerlilik, işlem saatleri | http://localhost:5174/backoffice.html (`admin` / `demo-admin`), anında geçerli, gerekçeli ve versiyonlu; [backoffice.md](backoffice.md) |
| Bankanın geliri | `GET /ops/revenue` |
| Bankanın döviz pozisyonu | http://localhost:5174/dealer.html (yalnız banka işlemleri pozisyon yaratır; P2P eşleşmede sıfır kalır) |
| Segment marjları, kesin fiyat süresi, limitler, otomatik hedge | `dealing` ayarı, [bank-dealing.md](bank-dealing.md) |
| Müşteri bildirimleri | http://localhost:4100/admin/notifications |
| Mimari | [architecture.md](architecture.md) |
