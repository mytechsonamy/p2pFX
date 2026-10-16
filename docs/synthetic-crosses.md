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

## Saxo SIM ile gerçek fiyat

`SaxoLiquidity` (`packages/core-adapter/src/saxo.ts`), Saxo OpenAPI'yi tek bir LP olarak bağlar. LP adı `SAXO` olur. `CompositeLiquidity` ise bunu mock LP'lerin yanına ekler.

- **Fiyat:** Bütün pariteler için tek bir `infoprices/list` isteği atılır ve en sık saniyede bir yenilenir (`SAXO_POLL_MS`). Saxo'nun "Indicative" olarak işaretlediği fiyatlar kullanılmaz.
- **İşlem:** Market emri gönderilir. Referans olarak `ExternalReference` ve `x-request-id` kullanılır. Dolum, order activity kaydından okunur. Süresi içinde doğrulanamayan emir "sonucu belirsiz" sayılır.
- **Fiyat eşitleme:** Saxo açıkken mock LP'lerin referans kurları her dakika Saxo'nun orta kuruna çekilir. Bu yapılmazsa iki piyasa birbirinden çok uzak kalır. Kapatmak için `SAXO_SYNC_MOCK=0` kullanılır.

Çalıştırmak için [developer.saxo/openapi/token/current](https://www.developer.saxo/openapi/token/current) adresinden 24 saatlik token alınır ve şu komut çalıştırılır:

```
SAXO_TOKEN='…' docker compose up
```

Varsayılan pariteler: `USDTRY,EURTRY,EURUSD,GBPUSD,USDCHF,USDJPY,XAUUSD,XAGUSD`. Bunlar `SAXO_PAIRS` ile değiştirilebilir. Saxo'da olmayan pariteler sessizce atlanır.

## One price per LP: its own book or its own cross, whichever is tighter

When an LP quotes a pair directly (LMAX's GBP/TRY book) and can also build it from its own two legs (LMAX GBP/USD ×
LMAX USD/TRY), it offers only one of the two for the pair: the one with the tighter spread (relative to its mid), its
direct book on a tie (one trade to hedge instead of two). Offering both let them disagree and cross each other on the
board. Combinations with another LP's leg (`LMAX+SAXO`) are offered as usual.

The spread the bank still quotes into is set in the back office: globally (Banka satırı fiyatlama › Spread koruması,
`dealing.maxSpreadBps`) and per pair (Pariteler ve komisyon › Spread koruması, `pairs[].maxSpreadBps`; empty means the
global limit).
