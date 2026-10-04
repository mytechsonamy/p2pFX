# Backoffice: banka parametreleri

http://localhost:5174/backoffice.html — demo girişi `admin` / `demo-admin` (`OPS_ADMIN_PASSWORD` ile değişir).
Önceki bir sürümden kalan `.env` dosyası ya da Docker `keys` volume'ü silinmeden çalışır: `pnpm dev:keys` ve
compose'un `keys` servisi mevcut dosyaya yalnızca eksik değerleri ekler.

Platformdaki her iş parametresi bankanın elinde: kodda sabit iş değeri yok, değerler Postgres'te versiyonlu
duruyor, değişiklik yeniden başlatma olmadan geçerli oluyor.

## Ekranlar

| Bölüm | Parametreler |
|---|---|
| Pariteler ve komisyon | parite açık/kapalı, alıcı/satıcı komisyonu (bip), 1 bip değeri, fiyat adımı, en küçük emir, fiyat bandı |
| Kambiyo vergisi | alıcı ve satıcı oranı, matrah (komisyon dahil / kitap fiyatı) |
| Emir kuralları | bakiye bloke (`block` / `no_block`), yuvarlama, geçerlilik seçenekleri ve üst sınırı, emir hızı limiti |
| İşlem saatleri | günler, açılış/kapanış, saat dilimi, tatiller, kapalıyken gelen emir (reddet / sıraya al) |
| Limitler | segment bazında tek emir ve günlük toplam tutar; segment eklenip kaldırılabilir |
| Banka satırı fiyatlama | banka satırı açık/kapalı, kotasyon süresi, LP fiyat tazeliği, tek işlem üst sınırı, segment marjları |
| Pozisyon ve hedge | otomatik hedge, pozisyon limitleri, hedef seviye, parça büyüklüğü, LP dağıtımı |
| Oturum ve settlement | müşteri oturum süresi, core banking yeniden deneme sayısı ve beklemesi |
| Demo botlar | açık/kapalı, hız, emir sayısı, referanstan uzaklık (bip), emir büyüklükleri, bot müşterileri |
| Marka | banka ve ürün adı, renkler, köşe yuvarlaklığı |

## Değişiklik akışı

1. Editör değeri değiştirir; değişen alanlar işaretlenir.
2. "Değişiklikleri gözden geçir": API yapılandırmayı doğrular ve önce/sonra farkını döner (`dryRun`).
3. Gerekçe zorunlu. Kaydedince yeni versiyon olur; `config` tablosunda kim, ne zaman, gerekçe ve fark,
   `audit_log`'da (silinemez) aynı kayıt tutulur.
4. Yeni değer o anda geçerli olur: API yapılandırmayı bellekte tutar, diğer API sunucuları Postgres `NOTIFY`
   ile yeniden yükler, bağlı müşteri uygulamaları `config` mesajı alıp ayarlarını tazeler, botlar birkaç
   saniye içinde görür.

Müşterinin onayladığı emirler onayladığı komisyon ve vergiyle işler (emir, yapılandırma versiyonunu saklar).

**Değişiklik geçmişi** her versiyonun farkını gösterir; "Bu versiyona dön" eski değerleri yeni bir versiyon
olarak geri yükler. **Denetim izi** girişleri, parametre değişikliklerini, onayları, hedge ve settlement
işlemlerini listeler.

## Onay bekleyen varsayılanlar

Prototip bazı değerlerle geldi (binde 2 vergi, 7/24 işlem, 5 bip komisyon, 10/4 bip segment marjı vb.).
Genel bakış bunları listeler ve menüde sayı olarak gösterir. Bir varsayılan, adı olan bir kullanıcı onu
değiştirdiğinde ya da "Mevcut değerleri onayla" ile olduğu gibi onayladığında listeden düşer. Demo betikleri
gibi servis entegrasyonlarının değişiklikleri onay sayılmaz.

## Segment fiyatlaması ve performans

LP'ler parite başına saniyede 4-6 fiyat gönderir. Segment marjları, bip değeri ve fiyat adımı her
yapılandırma versiyonu için bir kez derlenip bellekte tutulur (`price-engine.ts`, `pricingTable`); her fiyatta
veritabanı okunmaz, hesap bir harita okuması ve iki toplamadır. Backoffice'te kaydedilen değişiklik yeni bir
yapılandırma nesnesi üretir, tablo ilk kullanımda yeniden derlenir.

## Kullanıcılar ve roller

| Rol | Yetki |
|---|---|
| İzleyici | her şeyi görür, değiştiremez |
| Editör | parametre değiştirir, onaylar, settlement tekrar dener, manuel hedge yapar |
| Yönetici | editör + kullanıcı ekler, rol değiştirir, pasifleştirir, şifre sıfırlar |

Şifreler scrypt ile saklanır; backoffice oturumu 8 saat, müşteri oturumundan ayrı bir anahtarla imzalanır.
Pasifleştirilen kullanıcının oturumu hemen geçersiz olur. Servis entegrasyonları (`OPS_TOKEN`) okuma ve
editör işlemleri yapabilir, kullanıcı yönetemez; denetim izine `service:<X-Ops-Actor>` olarak yazılır.
Canlıda bu girişin yerini bankanın SSO'su alır.

## API

`POST /ops/login`, `GET /ops/me`, `GET /ops/config`, `PUT /ops/config` (`{ config, reason, dryRun? }`),
`GET /ops/config/versions`, `GET /ops/config/versions/:v`, `POST /ops/config/revert` (`{ version, reason }`),
`GET /ops/config/assumptions`, `POST /ops/config/assumptions/confirm` (`{ keys, reason }`),
`GET /ops/audit?action=&actor=&before=&limit=`, `GET/POST /ops/users`, `PATCH /ops/users/:username`.
