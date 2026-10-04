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
- **Segment margin.** `dealing.margins` sets, per segment, bips added on top: the customer buys from the bank
  at `LP ask + buyBips × bipSize` and sells to the bank at `LP bid − sellBips × bipSize`. Unknown segments use
  `default`. Example: LP 49.140 / 49.160, default margin 10 bips → bank sells at 49.26, buys at 49.04;
  premium 4 bips → 49.20 / 49.10.
- **Reference rate.** The P2P price band and the reference rate shown on the board stay the core banking
  reference rate, as before. In the prototype the simulated LPs quote around that same rate.
- **No P2P commission** on bank deals: the margin is the bank's earning. Kambiyo vergisi applies as usual.

## Dealing with the bank (request for quote)

1. `POST /v1/bank/quotes { pair, side, qty }` returns a firm quote for the customer's segment: rate, tax,
   total, and an expiry (`quoteTtlSeconds`, default 10 s). The ticket shows a countdown.
2. `POST /v1/bank/deals { quoteId }` executes it if not expired and the customer's funds cover it: one FX
   transaction in core banking (the bank buys from or sells to the customer), a dekont, and the position
   update. A failed posting leaves the deal `FAILED_NEEDS_REVIEW`, like P2P settlements.
3. The deal appears in the customer's trades with the bank as counterparty.

## Positions and hedging

- Every bank deal changes the bank's position in the base currency (customer buys → bank short). P2P fills do
  not: the bank is back-to-back there.
- The position keeper tracks quantity, average cost, realized P&L (on reductions) and unrealized P&L at the
  aggregated mid. Margin earned per deal is reported separately (deal rate vs LP price at the time).
- `dealing.positionLimits` sets a limit per currency. With `autoHedge` on, a deal that takes the position past
  the limit is followed by a hedge with the best LP that brings it back to zero. Operations can also hedge by
  hand (`POST /ops/dealing/hedges`).
- `GET /ops/dealing` returns the LP feeds, aggregated prices, segment rates, positions, P&L and recent hedges.
  The demo bank app shows it as a dealer screen at http://localhost:5174/dealer.html (the bank's backend calls
  the ops API with its own token; the browser never sees it).

## Configuration

```jsonc
"dealing": {
  "enabled": true,
  "quoteTtlSeconds": 10,
  "maxStalenessMs": 3000,
  "margins": { "default": { "buyBips": 10, "sellBips": 10 }, "segments": { "premium": { "buyBips": 4, "sellBips": 4 } } },
  "maxDealQty": { "USD": "250000", "EUR": "250000", "GBP": "100000" },
  "positionLimits": { "USD": "100000", "EUR": "100000", "GBP": "50000" },
  "autoHedge": true
}
```

## Prototype limits

- The LPs are simulated by the mock core service (`/lp/*`): three venues with their own spreads around a
  random walk. A bank connects real LPs (or its existing price module) behind the same adapter.
- Positions are computed from deals and hedges in the platform database; a bank would reconcile them with its
  treasury system.
- Bank quotes are not placed into the P2P book; P2P limit orders never execute against the bank.
