# @p2p/web

The customer UI that banks embed in their mobile app's WebView. React + Vite, Turkish by default.

Screens: **Al-Sat** (bank rate, live order book, order ticket with the full price breakdown and a confirmation
sheet), **Tahta** (live market board: last price and the day's open/high/low/volume, 20-level depth ladder
with cumulative bars, spread, a depth chart and the trade tape; tapping a price opens the ticket), **Emirlerim** (open and past orders with validity, fill progress and cancel), **İşlemlerim** (fills with
commission, tax, settlement status and dekont), **Hesaplarım** (core-banking accounts with held amounts).

- Branding comes from `GET /v1/config` (`branding.colors`, `radius`, `font`, `logoUrl`, `strings` overrides)
  and is applied as CSS variables (`src/theme.ts`, `src/styles.css`). Every UI string can be overridden per bank
  by key (see `src/i18n.ts`).
- The host bridge (`@p2p/sdk-bridge`) delivers the launch token; `tokenExpired` / `refreshToken` renew the
  session on a 401, also for the WebSocket.
- Live data from `WS /v1/stream`: order books, public trades, the customer's orders and fills. After a reconnect the app
  reloads its lists so nothing missed while offline is lost.
- Money is never handled as floats for display or comparisons (`src/format.ts`); the API computes all amounts.

Environment (build time): `VITE_API_BASE` (default: same origin), `VITE_HOST_ORIGINS` (comma-separated parent
origins allowed when embedded in an iframe; required outside development), `VITE_BRANDING_PREVIEW=1` lets the
host override branding (the demo host uses it; always on in dev). Server: `FRAME_ANCESTORS` sets the
`frame-ancestors` header on the dev and preview servers.

The app runs only inside the bank app (`src/guard.ts`): opened directly in a browser it shows a message and
never calls the API. For local debugging only, a build with `VITE_ALLOW_URL_TOKEN=1` accepts a launch token in
the URL: `http://localhost:5173/#token=$(pnpm -s dev:token demo-ayse)`.
