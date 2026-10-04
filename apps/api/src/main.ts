import { HttpCoreBankingAdapter, HttpLiquidityAdapter } from '@p2p/core-adapter';
import { buildApp } from './app.js';

const env = (name: string, fallback?: string) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`${name} is required`);
  return v;
};

const { app, close } = await buildApp({
  databaseUrl: env('DATABASE_URL', 'postgres://postgres:postgres@localhost:5432/p2pfx'),
  core: new HttpCoreBankingAdapter(env('CORE_BANKING_URL', 'http://localhost:4100'), process.env.CORE_BANKING_API_KEY),
  // The mock core also simulates the LPs; a bank points this at its price module or LP gateway.
  liquidity: new HttpLiquidityAdapter(env('LIQUIDITY_URL', env('CORE_BANKING_URL', 'http://localhost:4100'))),
  priceIntervalMs: Number(process.env.PRICE_INTERVAL_MS ?? 1000),
  bankPublicKeyPem: env('BANK_JWT_PUBLIC_KEY').replace(/\\n/g, '\n'),
  sessionSecret: env('SESSION_SECRET'),
  opsToken: env('OPS_TOKEN'),
  schedulerIntervalMs: Number(process.env.SCHEDULER_INTERVAL_MS ?? 5000),
  logger: true,
});

await app.listen({ port: Number(process.env.PORT ?? 4000), host: '0.0.0.0' });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    close().finally(() => process.exit(0));
  });
}
