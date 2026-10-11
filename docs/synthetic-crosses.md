# Sentetik kurlar

Bankalararası LP'ler TRY'yi büyük ölçüde yalnızca **USDTRY** olarak fiyatlar. Diğer her şeyi dolara karşı fiyatlarlar: EURUSD, GBPUSD, USDCHF, USDJPY, XAUUSD (ons başına) gibi. Bizim sunduğumuz TRY pariteleri (gram altın, CHFTRY…) bu yüzden iki bacaktan türetilir.

## Fiyat

`SyntheticLiquidity` (`packages/core-adapter/src/synthetic.ts`) mevcut LP adapter'ını sarar ve şunları hesaplar:

| Parite | Kaynak | Formül |
|---|---|---|
| XAUTRY, XAGTRY, XPTTRY (gram) | XAUUSD (ons) + USDTRY | XAUUSD × USDTRY ÷ 31,1034768 |
| EURTRY, GBPTRY, AUDTRY | EURUSD + USDTRY | EURUSD × USDTRY |
| CHFTRY, JPYTRY, SARTRY, … | USDCHF + USDTRY | USDTRY ÷ USDCHF |

- **Bankanın alış fiyatı (ask):** iki bacağın ask'ları kullanılır. Bölmeli kurlarda (USDCHF) çapraz bacağın bid'i alınır. Satış (bid) bunun tersidir. Böylece sentetik spread, iki bacağın spread'lerinin toplamı olur.
- **LP kombinasyonları:** Her LP kombinasyonu ayrı bir fiyat olarak yayınlanır, adı `çaprazLP+fonlamaLP` biçimindedir (ör. `LP-A+LP-C`). Fiyat motoru en iyi alış ve satışı seçer.
- **Fiyat zamanı:** Bir kombinasyonun zamanı, iki bacaktan eski olanınkidir. Bacaklardan biri bayatsa sentetik fiyat da bayat sayılır.
- **Doğrudan fiyatlar:** LP'nin doğrudan fiyatladığı TRY pariteleri olduğu gibi kalır. Fiyat motoru doğrudan ve sentetik fiyatların en iyisini alır.

## Hedge

Sentetik bir hedge, iki ayrı LP işlemidir:

1. **Çapraz bacak.** Örneğin 100 gr altın alımı XAUUSD'de 3,215 ons alımına çevrilir. CHF alımında ise USDCHF'de dolar satılır. Bu bacağın referansı `<ref>/1`'dir. Bu bacak reddedilirse hiçbir işlem olmamıştır ve klip bir sonraki LP'ye gider.
2. **Fonlama bacağı.** Birinci bacağın dolar tutarı USDTRY'de alınır veya satılır. Bu bacağın referansı `<ref>/2`'dir. Önce adı geçen LP denenir, reddederse diğer LP'ler fiyat sırasıyla denenir. Göndermeden önce bu referans tüm LP'lerde aranır, böylece aynı bacak iki kez işlem görmez.

**Fonlama bacağını hiçbir LP almazsa:** Klip "sonucu belirsiz" (UNKNOWN) olarak kalır ve pozisyonda sayılır. Bir sonraki sorguda (`resolveOpenClips`) fonlama bacağı tamamlanır ve klip DONE olur. Kaydedilen kur, ödenen veya alınan TRY'nin istenen miktara bölümüdür.

**Küçük artıklar:** Ons ve dolar tutarları LP'ye 3 ve 2 ondalıkla gider. Bölmeli kurlarda dolar tutarı işlem anındaki fiyattan hesaplanır. Bu yüzden çok küçük bir dolar veya döviz artığı kalabilir.

## Demo

Mock LP'ler varsayılan olarak her TRY paritesini doğrudan fiyatlar. Gerçek bankalararası düzen için:

```
MOCK_LP_MODE=interbank docker compose up
```

Bu modda mock LP'ler yalnızca USDTRY ve dolar çaprazlarını fiyatlar. Diğer bütün pariteler sentetik olarak gelir.
