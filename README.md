# p2pFX

White-label peer-to-peer FX marketplace that banks embed in their mobile apps. Customers place buy and sell orders for foreign currency at their own prices; when orders match, the bank buys from the seller and sells to the buyer, earning a configurable commission.

See [docs/architecture.md](docs/architecture.md) for the architecture and MVP scope.

## Layout

```
apps/
  api/          Fastify API: sessions, order entry, matching workers, settlement saga, scheduler, WebSocket, ops API
  mock-core/    Mock core banking service (accounts, holds, FX postings, receipts, reference rates)
packages/
  shared/       Config schema, API schemas, fixed-point money helpers, trading-hours helpers
  pricing/      Commission and kambiyo vergisi maths (pure)
  matching/     Order book and price-time matching (pure)
  core-adapter/ CoreBankingAdapter interface, in-memory MockCoreBank, HTTP client
db/migrations/  Postgres schema
```

## Run locally

Requires Node 20+, pnpm and Postgres 16.

```sh
pnpm install
pnpm dev:keys            # writes .env: demo bank RS256 key pair, session secret, ops token
createdb p2pfx           # or: docker compose up -d postgres
pnpm dev:mock-core       # :4100, seeded with demo customers and rates
pnpm dev:api             # :4000, migrates the database on start
```

Or everything in Docker: `pnpm dev:keys && docker compose up --build`.

Try a trade (demo customers: `demo-ayse`, `demo-mehmet`, `demo-zeynep`, `demo-ali`):

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
| `GET /v1/pairs/:pair/rate` | reference rate, indicative all-in buy/sell, price band |
| `POST /v1/orders/quote` | full breakdown for the confirmation screen |
| `POST /v1/orders` | place an order (`Idempotency-Key` header required) |
| `GET /v1/orders`, `GET /v1/orders/:id`, `DELETE /v1/orders/:id` | list, read, cancel |
| `GET /v1/fills`, `GET /v1/fills/:id/receipt` | fills from the customer's side, dekont |
| `WS /v1/stream?token=` | subscribe to `book:<pair>`, `orders`, `fills` |

Operations (`OPS_TOKEN` bearer): `GET/PUT /ops/config`, `GET /ops/settlements?status=`, `POST /ops/settlements/:id/retry`, `GET /ops/revenue?from&to`, `PUT /ops/rates/:pair`.

## Tests

```sh
createdb p2pfx_test
pnpm typecheck && pnpm test   # TEST_DATABASE_URL defaults to postgres://postgres:postgres@localhost:5432/p2pfx_test
```
