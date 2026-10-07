# Backoffice: banka parametreleri

http://localhost:5174/backoffice.html — demo girişi `admin` / `demo-admin` (`OPS_ADMIN_PASSWORD` ile değişir).
Önceki bir sürümden kalan `.env` dosyası ya da Docker `keys` volume'ü silinmeden çalışır: `pnpm dev:keys` ve
compose'un `keys` servisi mevcut dosyaya yalnızca eksik değerleri ekler.

Platformdaki her iş parametresi bankanın elinde: kodda sabit iş değeri yok, değerler Postgres'te versiyonlu
duruyor, değişiklik yeniden başlatma olmadan geçerli oluyor.

## Ekranlar

| Bölüm | Parametreler |
|---|---|
| Pariteler ve komisyon | LP'lerin fiyat verdiği tüm kurlar (döviz ve gram altın, gümüş, platin) ve LP orta kuru; tek tıkla parite ekleme (önerilen ayarlarla, işleme kapalı gelir), işleme açma/kapatma; parite bazında komisyon birimi (pip ya da bps), alıcı/satıcı komisyonu, 1 pip değeri, fiyat adımı, en küçük emir, fiyat bandı |
| Kambiyo vergisi | döviz için alıcı ve satıcı oranı, kıymetli madenler için ayrı alıcı ve satıcı oranı, matrah (komisyon dahil / kitap fiyatı) |
| Emir kuralları | bakiye bloke (`block` / `no_block`), yuvarlama, geçerlilik seçenekleri ve üst sınırı, emir hızı limiti |
| İşlem saatleri | günler, açılış/kapanış, saat dilimi, tatiller, kapalıyken gelen emir (reddet / sıraya al) |
| Limitler | segment bazında tek emir ve günlük toplam tutar, segmente özel emir sıklığı sınırı; segment eklenip kaldırılabilir |
| Banka satırı fiyatlama | kotasyon süresi, LP fiyat tazeliği, tek işlem üst sınırı, segment marjları |
| Pozisyon ve hedge | otomatik hedge, pozisyon limitleri (hedge eşiği), envanter tavanı (Direct, merdiven ve botun paylaştığı sert sınır), hedef seviye, parça büyüklüğü, LP dağıtımı |
| Banka emirleri (tahta) | bankanın işlem hesabı, baz alınan segment kuru, komisyonu hesaba katma, yeniden fiyatlama eşiği (pip); parite ve yön bazında banka kurundan uzaklık (%), kademe aralığı (%), kademe tutarları |
| Oturum ve settlement | müşteri oturum süresi, core banking yeniden deneme sayısı ve beklemesi, gönderim (asenkron / eşleşme bekler) |
| Likidite kaynakları ve sunum | Direct, banka merdiveni (Bank MM) ve banka botu (Bot MM) ayrı ayrı açık/kapalı; müşteri ekranı sunumu (SEPARATE ayrı / UNIFIED birleşik); banka likiditesini tahtada işaretleme; piyasa emri ve fiyat koruması (bps); aynı principal eşleşirse hangi emrin iptal edileceği |
| Kill switch | tüm işlemleri / yeni müşteri emirlerini durdurma, durdurulan pariteler, devre dışı LP'ler; tahtada bekleyen emirleri (parite ve kaynak bazında) nedeniyle iptal etme |
| Banka botu (Bot MM) | strateji kimliği, taraf başı kademe, orta kurdan uzaklık (pip), kademe aralığı (pip), yenileme süresi, emir büyüklükleri |
| Raporlar ve istisnalar | C2C, C2B (merdiven, bot) ve Direct hacimleri, P2P eşleşme oranı, müşteri bacak hacmi, komisyon, Direct marjı ve katkı; settlement, Direct, hedge ve bloke istisnaları, pozisyonlar |
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

Prototip bazı değerlerle geldi (binde 2 vergi, 7/24 işlem, 500 pip = 0,05 TL komisyon, 1000/400 pip segment marjı vb.).
Genel bakış bunları listeler ve menüde sayı olarak gösterir. Bir varsayılan, adı olan bir kullanıcı onu
değiştirdiğinde ya da "Mevcut değerleri onayla" ile olduğu gibi onayladığında listeden düşer. Demo betikleri
gibi servis entegrasyonlarının değişiklikleri onay sayılmaz.

## Segment fiyatlaması ve performans

LP'ler parite başına saniyede 4-6 fiyat gönderir. Segment marjları, pip değeri ve fiyat adımı her
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

## Pariteler ve kıymetli madenler

Pariteler bölümünün başındaki tablo, bankanın likidite sağlayıcılarının (LP) fiyat verdiği her kuru gösterir (`GET /ops/instruments`): tanımlı pariteler açık ya da kapalı, LP'nin fiyat verdiği ama bankada henüz tanımlı olmayanlar "Tanımlı değil".

- **Parite ekle** (`POST /ops/pairs`, editör): parite yeni bir konfigürasyon versiyonu olarak, gerekçesiyle ve **işleme kapalı** eklenir. Kataloğdaki öneriler gelir: 500 pip komisyon, kura göre pip değeri ve fiyat adımı, en küçük emir, tek işlem üst sınırı, pozisyon limiti, envanter tavanı, hedge parçası, bot emir büyüklükleri ve bankanın tahtadaki kademeleri. Katalogda olmayan bir kur için bu değerler LP kurundan türetilir.
- **İşleme aç / Kapat**: açık parite müşteri ekranında sekme olarak görünür. Kapatılan paritede yeni emir ve banka kotasyonu alınmaz, bankanın tahtadaki emirleri çekilir; müşterilerin bekleyen emirleri iptal edilene ya da süresi dolana kadar kalır.
- **Kıymetli madenler** (XAU altın, XAG gümüş, XPT platin) gram üzerinden işlem görür, fiyat TL/gram'dır; müşteri ekranında "Altın (gr)" olarak görünür. Bip değeri metale göre ayarlıdır (altında 1 TL, platinde 0,50 TL, gümüşte 0,01 TL).
- Kambiyo vergisinin kıymetli madenler için ayrı oranı vardır (Kambiyo vergisi › Kıymetli madenler). Başlangıçta dövizle aynıdır (binde 2); ileride farklılaşırsa sadece bu oran değiştirilir.

Demo LP'leri 18 kur verir: USD, EUR, GBP, CHF, JPY, CAD, AUD, SAR, XAU, XAG, XPT açık gelir; AED, QAR, KWD, DKK, SEK, NOK, CNY "Parite ekle" ile açılabilir.
