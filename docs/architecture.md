# P2P FX Exchange: Architecture and MVP Scope

Status: draft v2 (2026-10-04). Scope: working prototype.
v2 changes: the bank is the legal counterparty to every trade, one isolated deployment per bank, parametric bank commission and FX transaction tax (kambiyo vergisi), optional balance blocking, order validity.

## 1. What we are building

A product we sell to banks: an FX marketplace inside the bank's mobile app. A customer logged in to the bank's app can offer the foreign currency in their own FX accounts for sale at a price they choose, and other customers of the same bank can enter buy orders. It works like a small FX exchange.

Under Turkish regulation only authorised institutions may buy and sell FX, so customers never trade directly with each other. When a buy order and a sell order match, the bank buys the FX from the seller and sells it to the buyer in two back-to-back transactions. The bank earns a configurable commission on both sides and collects the FX transaction tax from both customers.

Each bank runs its own isolated copy of the platform (its own deployment and database), branded as its own product.

## 2. Key decisions

| Area | Decision | Why |
|---|---|---|
| Tenancy | Single-tenant: one deployment and one database per bank | Banks require isolation; deployable on-prem or in the bank's private cloud |
| Counterparty | Bank buys from the seller and sells to the buyer on every fill | Regulation: only authorised institutions trade FX |
| Balances | Customer's own core-banking FX and TRY accounts, through a `CoreBankingAdapter` | No separate wallets; the bank's core is the source of truth |
| Language | TypeScript end to end (pnpm monorepo) | One language for backend, SDK and UI; shared API types |
| Backend | Node 20 + Fastify, Zod | Simple, fast, good WebSocket support |
| Database | Postgres 16 | Orders, trades, settlement records, audit; `LISTEN/NOTIFY` for live updates |
| Money math | Amounts as `bigint` minor units; prices and rates as `bigint` fixed-point with 8 decimals | No floating point near money |
| Matching | In-process, one single-threaded worker per currency pair, price-time priority | Deterministic and easy to audit; enough for a bank's retail volume |
| Embedding | React + Vite web app in the bank app's WebView, thin native bridges (iOS, Android, React Native) | Works with any bank app stack |
| Auth | Bank-signed launch token exchanged for a platform session | Customer is already logged in to the bank app |
| Prototype deployment | Docker Compose: `api`, `postgres`, `web`, `mock-core` | One command to run the demo |

## 3. Pricing: book price, commission and tax

**Book price** is the customer-to-customer price that sits in the order book and is used for matching. The customer types a book price and the order ticket shows their all-in price before they confirm.

**Bank commission** is a number of "pips" added to (buy) or subtracted from (sell) the book price, configured per pair and per side (v1.1: or, with `mode: BPS`, a share of the book price in basis points). One pip is 0.0001 of the quote currency for USD/TRY (`pipSize`, per pair), so the default 500 pips = 0.05 TRY per unit of FX (before v1.1 the same amount was written as 5 bips of 0.01; stored configurations are converted ×100 on upgrade, amounts unchanged). Confirmed by Musti on 2026-10-04: on a 1,000 USD trade the bank earns 1,000 × 0.05 on the buy side and 1,000 × 0.05 on the sell side.

**FX transaction tax (kambiyo vergisi)** is a configurable rate per side, applied to the TRY value of the trade, collected from the buyer and from the seller, and credited to the bank's tax-payable account. Rates are configuration, not code.

Worked example, USD/TRY, commission 500 pips (0.05 TRY) per side, tax rate `t` per side, 1,000 USD:

| | Buyer | Seller |
|---|---|---|
| Book price | 49.15 | 49.15 |
| Effective price | 49.15 + 0.05 = **49.20** | 49.15 − 0.05 = **49.10** |
| TRY before tax | pays 49,200.00 | receives 49,100.00 |
| Tax | pays + 49,200.00 × t | has − 49,100.00 × t deducted |
| FX | receives 1,000 USD | delivers 1,000 USD |

Bank revenue on this fill: 1,000 × (0.05 + 0.05) = 100.00 TRY. Bank FX position: +1,000 USD bought, −1,000 USD sold, net zero. Whether tax is computed on the effective price or the book price is a setting (`taxBase: effective | book`); the default is effective price.

Order ticket for a buy order shows: book price, commission per unit, effective price, quantity, total TRY, tax, grand total. The customer confirms the grand total.

Rounding: TRY amounts round to kuruş with a configurable rule (default half-up). Commission and tax are rounded separately per fill and shown on the receipt.

MVP pairs are FX against TRY (USD/TRY, EUR/TRY, GBP/TRY, configurable). Cross pairs such as EUR/USD are out of scope because tax and commission rules differ.

## 4. Order rules

- Limit orders only: buy or sell a quantity of FX at a book price. Partial fills allowed.
- Matching: price-time priority. A fill executes at the resting (maker) order's book price, so an aggressive buyer can get a better price than they entered. Commission and tax are recalculated on the actual fill price.
- Validity, chosen by the customer from the options the bank enables:
  - `DAY`: until the end of today's trading session.
  - `GTD`: until a chosen date and time (capped by `maxValidityDays`).
  - `GTC`: until cancelled, still capped by `maxValidityDays` (default 30).
- An expiry scheduler cancels expired orders and releases any blocks.
- Trading hours and holidays are bank configuration; orders can be entered only during the configured session (or queued until the session opens, per bank setting).
- Self-match prevention: a customer's buy never fills against their own sell; the incoming order is cancelled for the matching quantity.
- Price band: orders more than ±N% away from the bank's reference rate are rejected (N per pair, default 3%).
- Limits per order and per day per customer segment, from bank configuration.

## 5. Balance blocking (bank's choice)

`balanceMode` is a bank-level setting:

**`block`**: at order entry the platform places a hold (bloke) in core banking:
- Sell order: hold `qty` on the selected FX account.
- Buy order: hold `qty × effective price + tax` on the selected TRY account (worst case, at the limit price).
The hold is reduced on each fill (and any price-improvement excess released) and released on cancel or expiry.

**`no_block`**: at order entry the platform only checks that the balance is sufficient at that moment. At match time it tries to hold both sides. If either hold fails, that order is cancelled with reason `INSUFFICIENT_BALANCE`, the other side's hold is released, and the other order goes on matching against the next order in the book. The cancelled customer is notified.

In both modes, an order is not shown in the public book until it has passed the entry check.

## 6. Settlement of a fill

Each fill becomes two bank FX transactions, posted in the customers' core-banking accounts through the `CoreBankingAdapter`:

1. **Bank buys from seller:** debit seller FX account `qty`; credit seller TRY account `qty × (book − commission) − sellerTax`.
2. **Bank sells to buyer:** debit buyer TRY account `qty × (book + commission) + buyerTax`; credit buyer FX account `qty`.

Commission goes to the bank's commission income account and tax to the tax-payable account. The bank's own FX position account is debited and credited by the same amount.

Flow per fill (saga with idempotency):
1. Ensure holds exist on both sides (already there in `block` mode, placed now in `no_block` mode).
2. Write a `settlement` record in state `PENDING` with deterministic idempotency keys for each leg.
3. Post leg 1 and leg 2 against the holds (capture). Each call is idempotent, so retries are safe.
4. Mark `SETTLED`, update orders, notify both customers, generate receipts (dekont) through the core.
5. If a leg fails after holds were placed (should be rare, since holds guarantee funds), retry with backoff; if it still fails, reverse any posted leg and mark `FAILED_NEEDS_REVIEW` for the operations screen.

The prototype settles each fill inside the pair's matching worker before taking the next match, in both modes. That keeps hold adjustments simple (a partially filled buy order's hold is shrunk to what its remainder needs, at its limit price, right after each fill). A bank with higher volume can move settlement to its own queue in `block` mode, since funds are already held.

## 7. Bank integration (`CoreBankingAdapter`)

The interface each bank implements (the prototype ships a mock):

- `getAccounts(customerRef)`: the customer's TRY and FX accounts with available balances.
- `placeHold(accountId, amount, ref)`, `releaseHold(holdId)`, `adjustHold(holdId, newAmount)`.
- `postFxTransaction({ side, customerRef, fxAccount, tryAccount, qty, price, commission, tax, holdIds, idempotencyKey })`: posts one leg as a bank FX buy or sell and returns the transaction reference and receipt.
- `getReferenceRate(pair)`: the bank's mid-rate for the price band and the reference display.
- `notify(customerRef, event)`: optional, for push notifications through the bank app.

Customer identity and KYC stay at the bank. The launch token carries `customer_ref` and the customer's `segment`, which selects limits.

## 8. System overview

```
 Bank mobile app
 ┌─────────────────────────────────────┐
 │ native shell ──bridge── WebView     │
 │   (iOS/Android/RN SDK)  P2P web UI  │
 └───────────┬─────────────────┬───────┘
             │ bank session    │ HTTPS + WSS
             ▼                 ▼
     Bank backend ──token──▶ P2P API (one deployment per bank)
                              ├─ Session / auth
                              ├─ Pricing (commission, tax, rounding)
                              ├─ Orders API ──▶ Matching worker per pair
                              ├─ Settlement saga ──▶ CoreBankingAdapter ──▶ Bank core
                              ├─ Expiry scheduler
                              ├─ Ops/admin API (config, failed settlements)
                              └─ WebSocket gateway ◀─ LISTEN/NOTIFY
                                        │
                                    Postgres
```

## 9. Data model

- `customers` (id, customer_ref, segment)
- pairs live in `config` (symbol, base, quote, decimals, tick size, min qty, price band, commission mode and pips/bps, pip size, enabled)
- `orders` (id, customer_id, pair, side, book_price, qty, filled_qty, validity `DAY|GTD|GTC`, expires_at, fx_account_id, try_account_id, hold_id, status `NEW|QUEUED|OPEN|PARTIAL|FILLED|CANCELLED|EXPIRED|REJECTED`, cancel_reason, pricing snapshot (commission and tax the customer confirmed), config_version, balance_mode, idempotency_key, created_at)
- `fills` (id, pair, maker_order_id, taker_order_id, book_price, qty, buyer_effective_price, seller_effective_price, buyer_commission, seller_commission, buyer_tax, seller_tax, created_at)
- `settlements` (id, fill_id, leg `BANK_BUY|BANK_SELL`, idempotency_key unique, core_txn_ref, receipt_ref, status `PENDING|SETTLED|FAILED_NEEDS_REVIEW|REVERSED`, attempts, last_error)
- `config` (versioned jsonb: branding, pairs, commission, tax, balanceMode, validity options, trading hours, limits)
- `audit_log` (actor, action, payload, created_at)

## 10. API surface (v1)

Customer:
- `POST /v1/session`, `GET /v1/config`, `GET /v1/accounts`
- `GET /v1/pairs/:pair/book`, `GET /v1/pairs/:pair/rate`
- `POST /v1/orders/quote`: returns the full breakdown (effective price, commission, tax, total) for the confirmation screen
- `POST /v1/orders` (`Idempotency-Key`), `GET /v1/orders`, `DELETE /v1/orders/:id`
- `GET /v1/fills`
- WebSocket `/v1/stream`: `book:<pair>`, `orders`, `fills`

Bank operations (separate auth): `GET/PUT /ops/config`, `GET /ops/settlements?status=FAILED_NEEDS_REVIEW`, `POST /ops/settlements/:id/retry`, `GET /ops/revenue?from&to`, `PUT /ops/rates/:pair` (prototype only).

## 11. White-label embedding and branding

One web app bundle per bank deployment, styled from the bank's configuration. The bank app opens it in a WebView with a launch token minted by the bank backend (JWT, RS256, ≤60s, claims `customer_ref`, `segment`, `locale`).

Native bridges (`P2PExchange.launch(token, options)`) for iOS (`WKWebView`), Android (`WebView`) and React Native (`react-native-webview`) carry a `postMessage` protocol: host → web `init`, `refreshToken`; web → host `ready`, `close`, `tokenExpired`, `openBankScreen`, `analyticsEvent`. The prototype includes a demo host page that simulates the bridge; native SDKs are stubs with the protocol documented.

Branding config: name, logo, colours, radius, font, locale (default `tr-TR`), string overrides. The theme maps to CSS custom properties, so the same build looks native in each bank's app.

## 12. Security and compliance

- Every fill produces two bank FX transactions with receipts, so reporting runs through the bank's existing FX processes.
- Idempotency keys on order entry and on every settlement leg.
- Append-only audit log of orders, config changes and ops actions; config is versioned, and each fill records the config version used.
- Rate limiting on order entry; self-match prevention; price band.
- Final tax treatment, receipts and reporting must be confirmed with each bank's compliance and tax teams; the platform keeps all rates and rules configurable.

## 13. Repository layout

```
p2p-exchange/
  apps/
    api/          Fastify server, matching workers, settlement saga, scheduler, WebSocket
    web/          React + Vite embeddable UI (customer)
    ops/          small bank operations UI (config, failed settlements, revenue)
    demo-host/    fake bank app page that launches the web app with a signed token
    mock-core/    mock core-banking service (accounts, holds, FX postings, receipts)
  packages/
    shared/       Zod schemas, API types, money and price helpers
    pricing/      commission, tax and rounding (pure, unit-tested)
    matching/     order book and matching engine (pure, unit-tested)
    core-adapter/ CoreBankingAdapter interface + mock client
    sdk-bridge/   postMessage protocol types; native stubs
  db/migrations/
  docker-compose.yml
```

## 14. Build plan

1. **Core backend:** pricing and matching packages with tests, schema, order API with quote and confirm, both balance modes, settlement saga against the mock core, expiry scheduler, WebSocket stream, seed script.
2. **Embeddable UI:** pair list, order book, order ticket with the full breakdown and confirmation, my orders with validity, fills and receipts, accounts; theme from config; demo host page with two bank brandings.
3. **Demo and polish:** one-command run, seeded customers with TRY and USD balances, a scripted demo of a USD/TRY match showing both customers' account movements, bank commission and tax, plus an `no_block` case where an unfunded order is cancelled at match time.

## 15. Open questions

- Kambiyo vergisi default is 0.2% on both sides in the prototype config; the real rate and whether the seller side is taxed must be confirmed per bank.
