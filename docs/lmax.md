# LMAX Global as an LP (FIX 4.4)

`LmaxLiquidity` (`packages/core-adapter/src/lmax.ts`) connects to LMAX Global's broker FIX gateways and joins the
other LPs through `CompositeLiquidity`: its quotes carry the LP name `LMAX`, it can be the cross or the funding leg of a
synthetic pair (`LMAX+SAXO`, `LP-A+LMAX`…), and the kill switch, staleness, spread guard and price sanity checks apply to
it like to any LP.

## Turning it on

Set in the project's `.env` (never committed):

```
LMAX_FIX_USERNAME=<LMAX username>
LMAX_FIX_PASSWORD=<LMAX password>
# optional
LMAX_PAIRS=USDTRY,EURTRY,GBPTRY,EURUSD,GBPUSD,USDCHF,USDJPY,XAUUSD,XAGUSD
LMAX_MD_HOST=…  LMAX_MD_TARGET=…  LMAX_TRADING_HOST=…  LMAX_TRADING_TARGET=…
```

Without the hosts the demo gateways are used: market data `fix-marketdata.london-demo.lmax.com:443` (TargetCompID
`LMXBDM`) and trading `fix-order.london-demo.lmax.com:443` (`LMXBD`), TLS. The username is also the SenderCompID. The
FIX password is the LMAX account's password (the demo web platform: https://web-order.london-demo.lmax.com).

## Sessions

Two FIX 4.4 sessions over TLS, each logged on with `ResetSeqNumFlag=Y` (LMAX recommends application recovery over
FIX resends): heartbeats every 30 s, test requests answered, a reconnect after any disconnection. Resend requests from
LMAX are gap-filled (nothing is resent).

## Prices

On logon the market data session subscribes to top of book (`MarketDepth=1`, full refresh) for the configured order
books; every `W` replaces the pair's quote. LMAX sends a price only when it changes, so a quote read while the session
is logged on is stamped with the time it is read (heartbeats prove the stream is alive), not with the time it last
changed, which the staleness check would reject in a quiet market. When the session drops, LMAX's quotes are gone until
it is back, so nothing prices from a frozen feed.

## In the demo

With the mock core, the simulated LPs follow the real LPs' mid (synced every minute, and shortly after start) and step
aside on every pair the real LPs price right now, directly or as a synthetic cross; simulated and real prices never
meet on the board, where their small differences would cross. A pair the real LPs stop pricing gets the simulated LPs
back.

## Orders

Every clip is Fill-or-Kill: with a limit rate a FOK limit order at that rate, rounded to LMAX's tick never looser for
the bank (LMAX enforces the worst price itself); without one a FOK market order. Quantities are sent in contracts
(`qty ÷ contract size`) and must be a whole number of the smallest order (1 000 units for FX, 1 oz of gold, 50 oz of
silver); any other quantity is refused before anything is sent.

| What LMAX answers | Outcome |
|---|---|
| Execution report `Filled` (39=2) | the trade, at the average price |
| `Rejected` (39=8), `Cancelled` (39=4) with nothing filled, a session `Reject` of the order message | definite rejection: the clip may go to the next LP |
| no final report in time, the session drops, a cancel after a partial fill | unknown: never re-sent elsewhere before it is looked up |

The bank's reference (a UUID, or `…/1` and `…/2` for synthetic legs) is longer than LMAX's 20-character ClOrdID, so
the ClOrdID is a fixed hash of the reference: a lookup after a restart finds the same order. A reference this process
already sent is never sent again.

## Lookups

With the original request (pair, side) the order's status is asked for (`OrderStatusRequest`). Without it the trade
history of just under 7 days (LMAX's limit) is searched (`TradeCaptureReportRequest`). A lookup that gets no answer fails, so the clip
stays open; "not found" means LMAX shows no fill.

## Instruments

Order book ids, contract sizes, smallest orders and ticks come from LMAX's instrument list (`LMAX_INSTRUMENTS`):
USD/TRY 100541, EUR/TRY 100537, GBP/TRY 100539, EUR/USD 4001, GBP/USD 4002, USD/JPY 4004, AUD/USD 4007, USD/CHF 4010,
USD/CAD 4013, gold 100637 (10 oz), silver 100639 (500 oz).

## Verified on the LMAX demo account (16 Oct 2026)

- Logon on both gateways (the FIX password is the account's web platform password; no IP whitelisting on demo).
  A refused logon (`ACCESS_DENIED`, `User not authorized`) stops the session instead of retrying, so failed logins
  never pile up.
- Top-of-book prices for USD/TRY, EUR/TRY, EUR/USD, GBP/USD, USD/JPY, gold and silver.
- An order status request for a ClOrdID never used is answered with an execution report `39=8`, `150=I`,
  `58=UNKNOWN ORDER`, echoing `790` (which must be a hex 64-bit integer): read as "not found".
- A trade history request must cover less than 7 days (`TIME_RANGE_REQUESTED_GREATER_THAN_7_DAYS` otherwise); the
  lookup asks for 7 days less a minute.
- Two test orders through `execute()`: buy 1 000 USD/TRY as a FOK limit 5 bps above the ask (filled at the ask), sell
  1 000 as a FOK market order (filled at the bid). Both found again by order status and in the trade history, whose
  reports carry the ClOrdID.

- A FOK limit buy 0.2 % below the bid was not filled: reported as a definite rejection, and "not found" by order
  status afterwards.

Quantities that are not a whole number of the smallest order are refused by the adapter before sending (not tried
against LMAX).
