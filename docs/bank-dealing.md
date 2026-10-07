# Bank dealing: LP aggregation, segment pricing, positions

The P2P marketplace lets customers trade with each other; the bank is the legal counterparty of both sides
and runs no FX risk. Bank dealing adds the bank's own FX desk to the same app: the bank aggregates its
liquidity providers' (LP) prices, adds a margin that differs by customer segment, publishes executable
buy/sell rates, and manages the position that results.

Customers then see two sources of liquidity on one screen: other customers (the P2P book) and the bank (a
**Banka** row on top of the book, priced for their own segment). The order ticket offers whichever is better.

## How it maps to a bank FX platform

A typical bank FX platform (the reference topology is Fibabanka's): web tier behind WAF and load balancer,
application servers, a messaging service, a cache cluster, and services for price module, order manager,
price history, price alarms and pool (position) manager, with reporting on Oracle.

| Reference component | Here |
|---|---|
| Price module (LP feeds, aggregation, margins) | `apps/api/src/dealing/price-engine.ts`, LP adapter in `@p2p/core-adapter` |
| Order manager | P2P order entry and matching (`order-entry.ts`, `engine/`) and bank deals (`dealing/dealing.ts`) |
| Price history | `price_ticks` table, `GET /v1/pairs/:pair/history` |
| Pool manager | `dealing/positions.ts`: positions, average cost, P&L, limits, auto-hedge |
| Price alarm | Not in the prototype (would use `price_ticks` and the bank's notification channel) |
| Messaging service | `EventBus` (Postgres LISTEN/NOTIFY) feeding the WebSocket stream |
| Coherence cache | In-process caches (latest aggregated price, config); a shared cache when scaled out |
| Reporting / Oracle | `/ops/*` endpoints on Postgres; a bank would point reporting at its own warehouse |
| Web tier, WAF, LB | The bank's existing edge; the app is served behind it and embedded in the mobile app |

## Pricing

- **LP feeds.** Each LP streams bid/ask per pair. The engine drops quotes older than `maxStalenessMs` and
  takes the best bid (highest) and best ask (lowest) across LPs: the aggregated LP price.
- **Segment margin.** `dealing.margins` sets, per segment, pips added on top: the customer buys from the bank
  at `LP ask + buyPips × pipSize` and sells to the bank at `LP bid − sellPips × pipSize`. Unknown segments use
  `default`. Example (USD/TRY, pip 0.0001): LP 49.140 / 49.160, default margin 1000 pips → bank sells at 49.26,
  buys at 49.04; premium 400 pips → 49.20 / 49.10.
- **Reference rate.** The P2P price band and the reference rate shown on the board stay the core banking
  reference rate, as before. In the prototype the simulated LPs quote around that same rate.
- **No P2P commission** on bank deals: the margin is the bank's earning. Kambiyo vergisi applies as usual.

## Dealing with the bank (request for quote)

1. `POST /v1/bank/quotes { pair, side, qty }` returns a firm quote for the customer's segment: rate, tax,
   total, and an expiry (`quoteTtlSeconds`, default 10 s). The ticket shows a countdown.
2. `POST /v1/bank/deals { quoteId }` executes it if not expired and the customer's funds cover it: one FX
   transaction in core banking (the bank buys from or sells to the customer), a dekont, and the position
   update. A failed posting leaves the deal `FAILED_NEEDS_REVIEW`, like P2P settlements. The deal is a principal
   execution of the bank (`BANK_DIRECT`): its position moves when the deal commits, and a deal that would take the
   position past `inventory.maxPosition` is refused (`INVENTORY_LIMIT`). `channels.bankDirect` switches the
   channel; the kill switch halts it.
3. The deal appears in the customer's trades with the bank as counterparty.

## Positions and hedging

- The bank's position comes from its principal executions (`principal_executions`): Direct deals, and board
  fills where the bank's ladder (BANK_MM) or bot (BOT_MM) was one side. It moves when the execution commits, not
  when settlement finishes (a board fill whose settlement fails is taken out again). Fills between two customers
  (C2C) do not move it: the bank is back-to-back there.
- `inventory.maxPosition` is a hard cap per currency shared by Direct, the ladder and the bot: ladder and bot
  levels are cut to what the bank may still buy or sell, a fill that would breach it is refused at the moment of
  the fill, and Direct refuses that side. `dealing.positionLimits` stays the auto-hedge trigger.
- The position keeper tracks quantity, average cost, realized P&L (on reductions) and unrealized P&L at the
  aggregated mid. Margin earned per deal is reported separately (deal rate vs LP price at the time).
- `dealing.positionLimits` sets a limit per currency. With `autoHedge` on, a deal that takes the position past
  the limit is followed by an automatic hedge. `dealing.hedging` sets how:
  - `targetPct`: the hedge brings the position down to this share of the limit, keeping its direction
    (0 = flat). Example: limit 100,000, target 50 → a 130,000 short is cut to 50,000 short with an 80,000 buy.
  - `maxClipQty`: the largest single LP ticket per currency; a bigger hedge is split into clips.
  - `split`: `ACROSS_LPS` sends the clips round the LPs from best to worst price; `BEST_LP` sends every clip to
    the best-priced LP.
  - If an LP rejects a clip, the clip goes to the next LP by price. What no LP takes is logged as unhedged and
    shows as open position. All clips of one decision share a `batch_id`.
- Operations can also hedge by hand (`POST /ops/dealing/hedges`, same clip rules). The dealer screen edits
  the auto-hedge rule and limits in place (it writes `PUT /ops/config`).
- `GET /ops/dealing` returns the LP feeds, aggregated prices, segment rates, positions, P&L and recent hedges.
  The demo bank app shows it as a dealer screen at http://localhost:5174/dealer.html (the bank's backend calls
  the ops API with its own token; the browser never sees it).

## Bank orders in the book

The bank can also be a participant in the P2P book with its own trading account (`bankBook.customerRef`), so
the book has the bank's liquidity in it, not only customers'. `dealing/bank-book.ts` keeps a ladder per pair
and side:

- Anchor: the bank-row rate of `bankBook.anchorSegment`. Asks start `startPct` % above its buy rate, bids
  `startPct` % below its sell rate; each further level is `stepPct` % further out; `levels` lists the
  quantity of each level (t1 … tz).
- `includeCommission`: the book shows matching prices and the customer pays commission on top, so a level
  priced at the bank rate would cost the customer more than the bank row. With this on, the customer's
  commission is taken out of the level price: a customer who takes a bank level pays (or receives) the level
  price plus commission, which is never better than the bank's own rate. Example, USD/TRY: bank rate
  49.2559, first ask level 0.02 % out = 49.2658 all-in, shown in the book at 49.2158.
- The ladder is repriced when the anchor moves `repricePips` or more, when the configuration changes, and
  when customers take a level (the level is refilled). Each repricing is one generation
  (`Exchange.replaceLiquidity`): the old orders go and the new ones come in one step of the pair's sequencer, so
  a customer order sees the old ladder or the new one, never half of each. A new level that crosses a resting
  customer order trades at the resting price. The bank's orders pay no commission or tax, are held at fill time
  (`no_block`) and are GTC.
- The bank's bot (BOT_MM, `botMarketMaker`) adds levels around the LP mid in the same way, as the same principal:
  it never trades with the ladder or with itself (self trade prevention by principal) and never crosses the book.
  A stale LP feed, the channel switched off (`channels.bankMarketMaker`, `channels.botMarketMaker`) or a halt
  withdraw both at once.
- Fills against the bank's orders change the bank position (with P&L) like bank-row deals and go through the
  same auto-hedge rule, started in the background as the fill commits (the customer's fill is firm whatever the
  hedge does). Fills between customers stay back-to-back.
- Editing: backoffice → "Banka emirleri (tahta)". The dealer screen lists the bank's resting orders.

## Configuration

```jsonc
"dealing": {
  "quoteTtlSeconds": 10,
  "maxStalenessMs": 3000,
  "margins": { "default": { "buyPips": 1000, "sellPips": 1000 }, "segments": { "premium": { "buyPips": 400, "sellPips": 400 } } },
  "maxDealQty": { "USD": "250000", "EUR": "250000", "GBP": "100000" },
  "positionLimits": { "USD": "100000", "EUR": "100000", "GBP": "50000" },
  "autoHedge": true,
  "hedging": { "targetPct": 0, "maxClipQty": { "USD": "50000", "EUR": "50000", "GBP": "25000" }, "split": "ACROSS_LPS" }
}
```

## Prototype limits

- The LPs are simulated by the mock core service (`/lp/*`): three venues with their own spreads around a
  random walk. A bank connects real LPs (or its existing price module) behind the same adapter.
- Positions are computed from deals and hedges in the platform database; a bank would reconcile them with its
  treasury system.
- Bank quotes are not placed into the P2P book; P2P limit orders never execute against the bank.
