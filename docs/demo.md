# Demo akışı

Bankaya 10 dakikalık sunum için. Hazırlık tek komut:

```sh
docker compose up --build
```

`seed exited with code 0` satırını görünce hazır. Tarayıcıda **http://localhost:5174** açılır: aynı bankanın
uygulamasında iki müşteri, solda Ayşe, sağda Mehmet. Tahta her parite için 14 işlemlik geçmiş ve iki taraflı
emir defteriyle dolu gelir; ardından emir botları (`bots` servisi) sürekli emir girip iptal ederek ve kendi
aralarında işlem yaparak tahtayı canlı tutar. Botlar müşteri emrini hiçbir zaman kendileri almaz (müşteri
botun emrini alabilir). Stack yeniden başlatılınca demo baştan başlar.

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
derinlik grafiği, son işlemler. Banka kuru 49,15; en iyi alış ve satış 49,11 ile 49,20 civarında, botlar
oynattıkça değişir.

## 3. İşlem (3 dk)

1. Ayşe: **Al-Sat** → Sat, 1.000 USD, fiyat 49,15, geçerlilik Gün sonu. Onay ekranında işlem kuru 49,10
   (49,15 − 0,05 komisyon), binde 2 kambiyo vergisi, hesabına yatacak 49.001,80 TL. Onayla: 1.000 USD bloke.
2. Mehmet'in emir defterinde 49,15'te Ayşe'nin teklifi anında belirir. Fiyata dokun: alış emri dolu gelir.
   Onay ekranı: **49,15 + 0,05 = 49,20**, 50 TL komisyon, 98,40 TL vergi, hesabından çekilecek 49.298,40 TL.
3. Onayla. İki telefon da güncellenir, yeni işlem tahtaya düşer.
4. **İşlemlerim** → işlem → dekont. Banka Ayşe'den aldı, Mehmet'e sattı; iki ayrı kayıt müşterilerin vadesiz
   hesaplarına atıldı, ayrı cüzdan yok.

Mesaj: banka 1.000 USD'lik eşleşmeden 50 TL alış, 50 TL satış komisyonu kazandı ve iki taraftan kambiyo
vergisini tahsil etti; fiyat riski almadı.

## 4. Senaryolu demo (2 dk)

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
| Komisyon, vergi oranı, bloke, geçerlilik, işlem saatleri | `GET/PUT /ops/config` (banka parametresi, anında geçerli) |
| Bankanın geliri | `GET /ops/revenue` |
| Bankanın döviz pozisyonu | http://localhost:4100/admin/bank-accounts (eşleşmede banka pozisyonu sıfır kalır) |
| Müşteri bildirimleri | http://localhost:4100/admin/notifications |
| Mimari | [architecture.md](architecture.md) |
