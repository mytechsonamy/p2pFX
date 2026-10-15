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
books; every `W` replaces the pair's quote. When the session drops, LMAX's quotes are gone until it is back, so nothing
prices from a frozen feed.

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
history of the last 7 days is searched (`TradeCaptureReportRequest`). A lookup that gets no answer fails, so the clip
stays open; "not found" means LMAX shows no fill.

## Instruments

Order book ids, contract sizes, smallest orders and ticks come from LMAX's instrument list (`LMAX_INSTRUMENTS`):
USD/TRY 100541, EUR/TRY 100537, GBP/TRY 100539, EUR/USD 4001, GBP/USD 4002, USD/JPY 4004, AUD/USD 4007, USD/CHF 4010,
USD/CAD 4013, gold 100637 (10 oz), silver 100639 (500 oz).

## Not verified against LMAX yet

The adapter is tested against a fake FIX gateway built from LMAX's specification and sample messages (framing, body
length and checksum checked against LMAX's own sample). To confirm on the demo account: logon, the price subscription,
whether quantities must be multiples of the smallest order, how an unknown order is answered to a status request, and
whether trade history reports carry the ClOrdID.
