import {
  CompositeLiquidity,
  HttpCoreBankingAdapter,
  HttpLiquidityAdapter,
  LMAX_DEMO,
  LmaxLiquidity,
  PairFilterLiquidity,
  SaxoLiquidity,
  SyntheticLiquidity,
  type LiquidityAdapter,
} from '@p2p/core-adapter';
import { buildApp } from './app.js';

const env = (name: string, fallback?: string) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`${name} is required`);
  return v;
};

// Demo defaults must never reach a production start.
if (process.env.NODE_ENV === 'production') {
  const demo: string[] = [];
  if (process.env.OPS_ADMIN_PASSWORD === 'demo-admin') demo.push('OPS_ADMIN_PASSWORD is the demo password');
  if (/\/\/postgres:postgres@/.test(process.env.DATABASE_URL ?? '')) demo.push('DATABASE_URL uses the demo postgres superuser password');
  if (!process.env.CORE_BANKING_URL || /mock-core|localhost:4100/.test(process.env.CORE_BANKING_URL)) demo.push('CORE_BANKING_URL points at the mock core');
  if (demo.length) throw new Error(`refusing to start in production with demo settings: ${demo.join('; ')}`);
}

const coreUrl = env('CORE_BANKING_URL', 'http://localhost:4100');
const lpGateway = new HttpLiquidityAdapter(env('LIQUIDITY_URL', coreUrl), process.env.LIQUIDITY_API_KEY);
// SAXO_TOKEN adds Saxo Bank OpenAPI (SIM by default) as a real LP next to the gateway's LPs.
const saxo = process.env.SAXO_TOKEN
  ? new SaxoLiquidity({
      token: process.env.SAXO_TOKEN,
      baseUrl: process.env.SAXO_BASE_URL,
      pairs: (process.env.SAXO_PAIRS ?? 'USDTRY,EURTRY,EURUSD,GBPUSD,USDCHF,USDJPY,XAUUSD,XAGUSD').split(','),
      minPollMs: Number(process.env.SAXO_POLL_MS ?? 1000),
    })
  : undefined;
// LMAX_FIX_USERNAME / LMAX_FIX_PASSWORD add LMAX Global over FIX 4.4 (the demo gateways by default) as a real LP.
const lmax =
  process.env.LMAX_FIX_USERNAME && process.env.LMAX_FIX_PASSWORD
    ? new LmaxLiquidity({
        username: process.env.LMAX_FIX_USERNAME,
        password: process.env.LMAX_FIX_PASSWORD,
        pairs: (process.env.LMAX_PAIRS || 'USDTRY,EURTRY,GBPTRY,EURUSD,GBPUSD,USDCHF,USDJPY,XAUUSD,XAGUSD').split(','),
        marketData: {
          ...LMAX_DEMO.marketData,
          ...(process.env.LMAX_MD_HOST ? { host: process.env.LMAX_MD_HOST } : {}),
          ...(process.env.LMAX_MD_TARGET ? { targetCompId: process.env.LMAX_MD_TARGET } : {}),
        },
        trading: {
          ...LMAX_DEMO.trading,
          ...(process.env.LMAX_TRADING_HOST ? { host: process.env.LMAX_TRADING_HOST } : {}),
          ...(process.env.LMAX_TRADING_TARGET ? { targetCompId: process.env.LMAX_TRADING_TARGET } : {}),
        },
      })
    : undefined;
const realLps = [saxo, lmax].filter((lp): lp is SaxoLiquidity | LmaxLiquidity => !!lp);
// Demo (mock core): the mock core's simulated LPs follow the real LPs' mid (below), and step aside on the pairs a real LP
// prices right now, so simulated and real prices never cross on the board. A pair a real LP stops pricing (session
// down) gets the simulated LPs back.
const demoWithRealLps = realLps.length > 0 && /mock-core|localhost:4100/.test(coreUrl) && process.env.SAXO_SYNC_MOCK !== '0';
// The real LPs alone, with the TRY pairs they can build from their dollar crosses (CHFTRY from USDCHF × USDTRY…).
const realOnly = realLps.length ? new SyntheticLiquidity(realLps.length === 1 ? realLps[0]! : new CompositeLiquidity(realLps)) : undefined;
let pricedByRealLps = { at: 0, pairs: new Set<string>() };
const realPairs = async () => {
  if (!realOnly || Date.now() - pricedByRealLps.at < 2000) return pricedByRealLps.pairs;
  const pairs = new Set<string>();
  const candidates = new Set([...(await lpGateway.instruments().catch(() => [] as string[])), ...(await realOnly.instruments().catch(() => [] as string[]))]);
  for (const pair of candidates) {
    if ((await realOnly.quotes(pair).catch(() => [])).length) pairs.add(pair);
  }
  pricedByRealLps = { at: Date.now(), pairs };
  return pairs;
};
const gateway: LiquidityAdapter = demoWithRealLps ? new PairFilterLiquidity(lpGateway, realPairs) : lpGateway;
const liquidity: LiquidityAdapter = realLps.length ? new CompositeLiquidity([gateway, ...realLps]) : lpGateway;

lmax?.start();

const { app, close } = await buildApp({
  databaseUrl: env('DATABASE_URL', 'postgres://postgres:postgres@localhost:5432/p2pfx'),
  core: new HttpCoreBankingAdapter(coreUrl, process.env.CORE_BANKING_API_KEY),
  // The mock core also simulates the LPs; a bank points this at its price module or LP gateway. Pairs the LPs
  // do not quote against TRY (gram gold, CHFTRY…) are built from their dollar cross and USDTRY.
  liquidity: new SyntheticLiquidity(liquidity),
  priceIntervalMs: Number(process.env.PRICE_INTERVAL_MS ?? 1000),
  bankBookIntervalMs: Number(process.env.BANK_BOOK_INTERVAL_MS ?? 1000),
  botIntervalMs: Number(process.env.BOT_INTERVAL_MS ?? 500),
  bankPublicKeyPem: env('BANK_JWT_PUBLIC_KEY').replace(/\\n/g, '\n'),
  sessionSecret: env('SESSION_SECRET'),
  opsToken: env('OPS_TOKEN'),
  opsAdminPassword: process.env.OPS_ADMIN_PASSWORD,
  schedulerIntervalMs: Number(process.env.SCHEDULER_INTERVAL_MS ?? 5000),
  matching: process.env.MATCHING !== '0',
  logger: true,
});

await app.listen({ port: Number(process.env.PORT ?? 4000), host: '0.0.0.0' });

// With a real LP (Saxo, LMAX) next to the mock core's simulated LPs, the simulated LPs follow the real mid (else the
// two markets would be far apart and the best bid would sit above the best ask).
if (demoWithRealLps && realOnly) {
  const real = realOnly;
  const sync = async () => {
    for (const pair of await lpGateway.instruments().catch(() => [] as string[])) {
      try {
        const qs = await real.quotes(pair);
        const mid = (Math.max(...qs.map((q) => Number(q.bid))) + Math.min(...qs.map((q) => Number(q.ask)))) / 2;
        await fetch(new URL(`/rates/${pair}`, coreUrl), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ rate: mid.toFixed(mid < 10 ? 6 : 4) }),
        });
      } catch {
        // Saxo does not price this pair: the mock keeps its own rate.
      }
    }
  };
  const run = () => sync().catch((err) => app.log.warn({ err }, 'mock rate sync from the real LPs failed'));
  await run();
  // A FIX LP (LMAX) prices only once its session is logged on: the first sync is repeated shortly after start.
  for (const ms of [5_000, 15_000]) setTimeout(run, ms).unref();
  setInterval(run, 60_000).unref();
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    lmax?.stop();
    close().finally(() => process.exit(0));
  });
}
