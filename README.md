# p2pFX

White-label peer-to-peer FX marketplace that banks embed in their mobile apps. Customers place buy and sell orders for foreign currency at their own prices; when orders match, the bank buys from the seller and sells to the buyer, earning a configurable commission.

See [docs/architecture.md](docs/architecture.md) for the architecture and MVP scope.

## Layout

```
apps/
  api/          Fastify API: sessions, order entry, matching workers, settlement saga, scheduler, WebSocket, ops API
  mock-core/    Mock core banking service (accounts, holds, FX postings, receipts, reference rates)
  web/          Embeddable customer UI (React + Vite) that runs in the bank app's WebView
  demo-host/    Fake bank app: two phones side by side, mints launch tokens, shows bridge messages
packages/
  shared/       Config schema, API schemas, fixed-point money helpers, trading-hours helpers
  pricing/      Commission and kambiyo vergisi maths (pure)
  matching/     Order book and price-time matching (pure)
  core-adapter/ CoreBankingAdapter interface, in-memory MockCoreBank, HTTP client
  sdk-bridge/   postMessage protocol between the bank app and the web app; native SDK stubs in its README
db/migrations/  Postgres schema
```

## Demo in one command

Requires Docker only.

```sh
docker compose up --build      # or: pnpm demo
```

Open **http://localhost:5174**: the demo bank app with Ayşe and Mehmet side by side. The stack generates
its own demo keys, starts Postgres, the mock core banking service, the API and the web app, seeds every
pair with a trade history and a resting order book, and runs order bots that keep the board moving (they post,
cancel and trade among themselves, never taking a customer's order). Then, in a second terminal, the scripted end-to-end
trade (narrated in Turkish) while the phones update live:

```sh
docker compose run --rm walkthrough
```

Restarting the stack resets the demo (Postgres and the mock core both run in memory). The presenter's
script is in [docs/demo.md](docs/demo.md).

| | |
|---|---|
| http://localhost:5174 | demo bank app (two phones, bank brand switch, bridge message log) |
| http://localhost:5174/dealer.html | the bank's FX desk: LP prices, segment rates, positions and P&L, hedges |
| http://localhost:5174/backoffice.html | bank back office: every business parameter, change history, audit log, operators (`admin` / `demo-admin`), see [docs/backoffice.md](docs/backoffice.md) |
| http://localhost:5173 | the embeddable web app: opened directly it refuses to start (bank app only) |
| http://localhost:4000 | P2P API |
| http://localhost:4100 | mock core banking (`/admin/bank-accounts`, `/admin/notifications`, `/admin/faults`) |

## Run locally

Requires Node 20+, pnpm and Postgres 16.

```sh
pnpm install
pnpm dev:keys            # writes .env: demo bank RS256 key pair, session secret, ops token, first admin password
createdb p2pfx           # or: docker compose up -d postgres
pnpm dev:mock-core       # :4100, seeded with demo customers and rates
pnpm dev:api             # :4000, migrates the database on start
```

Then the UI, in two more terminals:

```sh
pnpm dev:web             # :5173, proxies /v1 to the API
pnpm dev:demo-host       # :5174, open this: the demo bank app with Ayşe and Mehmet side by side
```

In the demo, sell USD as Ayşe and tap her offer in Mehmet's order book to buy it. The bank brand switch
shows the same build in a second bank's colours. See [apps/web/README.md](apps/web/README.md) and
[packages/sdk-bridge/README.md](packages/sdk-bridge/README.md).

`pnpm demo:seed` fills the board with market-maker orders and trades, `pnpm demo:bots` keeps it moving and
`pnpm demo:walkthrough` runs the scripted trade, all against this local setup.

## Access

The marketplace only opens inside the bank's app. The bank backend mints a launch token for its logged-in
customer (RS256 with the bank's key, audience `p2pfx`, at most 60 seconds, one-time `jti`) and the bank app
hands it over the bridge; the API exchanges it for a 30-minute session held in memory only. The web app
refuses to start when opened from a link in a browser (no host bridge) or framed by a page outside
`VITE_HOST_ORIGINS`, and the server sends `Content-Security-Policy: frame-ancestors` (`FRAME_ANCESTORS`) so
browsers refuse other embedders. Without a bank-signed token the API answers nothing.

Try a trade by hand (demo customers: `demo-ayse`, `demo-mehmet`, `demo-zeynep`, `demo-ali`; `demo-mm-1` to `demo-mm-6` are the seeder's market makers):

```sh
login() { curl -s localhost:4000/v1/session -H 'content-type: application/json' \
  -d "{\"launchToken\":\"$(pnpm -s dev:token $1)\"}" | jq -r .token; }
AYSE=$(login demo-ayse); MEHMET=$(login demo-mehmet)

curl -s localhost:4000/v1/orders -H "authorization: Bearer $AYSE" -H 'idempotency-key: 1' \
  -H 'content-type: application/json' -d '{"pair":"USDTRY","side":"SELL","qty":"1000","price":"49.15","validity":"DAY"}'
curl -s localhost:4000/v1/orders/quote -H "authorization: Bearer $MEHMET" \
  -H 'content-type: application/json' -d '{"pair":"USDTRY","side":"BUY","qty":"1000","price":"49.15"}'
curl -s localhost:4000/v1/orders -H "authorization: Bearer $MEHMET" -H 'idempotency-key: 2' \
  -H 'content-type: application/json' -d '{"pair":"USDTRY","side":"BUY","qty":"1000","price":"49.15","validity":"GTC"}'
curl -s localhost:4000/v1/fills -H "authorization: Bearer $MEHMET"
curl -s localhost:4000/ops/revenue -H "authorization: Bearer $(grep OPS_TOKEN .env | cut -d'"' -f2)"
curl -s localhost:4100/admin/bank-accounts
```

## API

Customer (session bearer token from `POST /v1/session`):

| | |
|---|---|
| `POST /v1/session` | `{ launchToken }` (bank-signed RS256 JWT, ≤60s, one-time) → session token |
| `GET /v1/config` | branding, pairs with commission per unit, tax, validity options, hours, the customer's limits |
| `GET /v1/accounts` | the customer's core-banking accounts with balance, held, available |
| `GET /v1/pairs/:pair/book` | aggregated order book |
| `GET /v1/pairs/:pair/trades`, `GET /v1/pairs/:pair/stats` | market board: recent trades (anonymous), today's open/high/low/last/volume |
| `GET /v1/pairs/:pair/rate` | reference rate, indicative all-in buy/sell, price band |
| `POST /v1/orders/quote` | full breakdown for the confirmation screen |
| `POST /v1/orders` | place an order (`Idempotency-Key` header required) |
| `GET /v1/orders`, `GET /v1/orders/:id`, `DELETE /v1/orders/:id` | list, read, cancel |
| `GET /v1/fills`, `GET /v1/fills/:id/receipt` | fills from the customer's side, dekont |
| `GET /v1/bank/rates/:pair` | the bank's buy/sell rate for the customer's segment (LP price + segment margin) |
| `POST /v1/bank/quotes`, `POST /v1/bank/deals` | firm quote with expiry, then instant deal with the bank |
| `GET /v1/pairs/:pair/history?minutes=` | LP price history |
| `WS /v1/stream?token=` | subscribe to `book:<pair>`, `trades:<pair>`, `bank:<pair>`, `orders`, `fills` |

Operations (a back office operator's session from `POST /ops/login`, or the `OPS_TOKEN` service bearer): `GET/PUT /ops/config` (with a reason, as a new version), `GET /ops/config/versions`, `POST /ops/config/revert`, `GET /ops/config/assumptions`, `POST /ops/config/assumptions/confirm`, `GET /ops/audit`, `GET/POST/PATCH /ops/users`, `GET /ops/settlements?status=`, `POST /ops/settlements/:id/retry`, `GET /ops/revenue?from&to`, `PUT /ops/rates/:pair`, `GET /ops/dealing` (LP feeds, positions, P&L, deals, hedges), `POST /ops/dealing/hedges`, `POST /ops/dealing/hedges/:id/resolve` (close a clip the LP never confirmed, after the LP is asked again), `POST /ops/dealing/deals/:id/retry`, `GET /ops/instruments` (what the LPs quote, configured or not), `POST /ops/pairs` (add a quoted pair, closed for trading).

Health: `GET /health` (liveness) and `GET /ready` (database, event stream, matching running, LP prices fresh, plus
settlements needing review, the oldest pending settlement, open deals, unresolved hedge clips and queued hold changes).

**One matching instance per database.** Each API instance with matching on keeps the order books in memory, so only
one may run: it holds a Postgres advisory lock and a second one refuses to start. Extra instances for reads and
WebSocket fan-out run with `MATCHING=0`: every trading command there (orders, cancels, bank quotes and deals, hedges,
settlement retries) answers 503 `MATCHING_UNAVAILABLE` before it touches the database, core banking or an LP.

**Unknown outcomes.** A core banking posting or LP trade that times out is never assumed failed: it is looked up by its
idempotency key or LP reference first (`findFxTransaction`, `findExecution` in the adapters). Until a lookup answers,
the settlement leg is `UNKNOWN_OUTCOME` and the hedge clip `UNKNOWN`; nothing is re-sent under a new key or to
another LP. A fill's legs are settled in order by one worker at a time: `BANK_SELL` is never posted while `BANK_BUY` is
unknown. A reversal is stored as `REVERSAL_PENDING` before it is sent and retried under the same key until core banking
confirms it; until then nothing on that fill is re-sent. An LP's silence never rejects a clip: it stays `UNKNOWN` (and in
the position, shown as `unconfirmedHedgeQty`) until the LP shows it or operations close it after asking the LP again.
A bank quote is valid until it is claimed, checked with the clock at the claim. The Docker Compose stack is demo-only and publishes its ports on 127.0.0.1.

Bank dealing (the bank's own FX desk next to the P2P book: LP aggregation, segment margins, positions,
auto-hedge) is described in [docs/bank-dealing.md](docs/bank-dealing.md).

## Tests

```sh
createdb p2pfx_test
pnpm typecheck && pnpm test   # TEST_DATABASE_URL defaults to postgres://postgres:postgres@localhost:5432/p2pfx_test
```
