// Writes .env (or the file after --out) with a demo bank signing key pair and local secrets.
// An existing file is kept and only gets the entries it is missing (so an older checkout's keys survive an
// upgrade); --force rewrites it from scratch.
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';

const outAt = process.argv.indexOf('--out');
const out = outAt > 0 ? process.argv[outAt + 1] : '.env';
const force = process.argv.includes('--force');
const existing = existsSync(out) && !force ? readFileSync(out, 'utf8') : undefined;
const has = new Set((existing ?? '').split('\n').map((l) => l.match(/^\s*([A-Z0-9_]+)=/)?.[1]).filter(Boolean));

const oneLine = (pem: string) => pem.trim().replace(/\n/g, '\\n');
const env: Record<string, string> = {
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/p2pfx',
  CORE_BANKING_URL: 'http://localhost:4100',
  SESSION_SECRET: randomBytes(32).toString('hex'),
  OPS_TOKEN: randomBytes(16).toString('hex'),
  // First back office administrator (user `admin`), created only while the database has no operators.
  // A known password so a demo presenter can sign in; set OPS_ADMIN_PASSWORD to choose another.
  OPS_ADMIN_PASSWORD: process.env.OPS_ADMIN_PASSWORD ?? 'demo-admin',
};
// The key pair is generated only when neither half exists, so a kept file never gets a mismatched pair.
if (!has.has('BANK_JWT_PUBLIC_KEY') && !has.has('BANK_JWT_PRIVATE_KEY')) {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  env.BANK_JWT_PUBLIC_KEY = oneLine(await exportSPKI(publicKey));
  // Only the bank backend (and the demo host) holds this; the platform never needs it.
  env.BANK_JWT_PRIVATE_KEY = oneLine(await exportPKCS8(privateKey));
}

const missing = Object.entries(env).filter(([k]) => !has.has(k));
const lines = missing.map(([k, v]) => `${k}="${v}"`).join('\n') + '\n';
if (existing === undefined) {
  writeFileSync(out, lines);
  console.log(`wrote ${out}`);
} else if (missing.length) {
  appendFileSync(out, (existing.endsWith('\n') || !existing ? '' : '\n') + lines);
  console.log(`${out}: added ${missing.map(([k]) => k).join(', ')}`);
} else {
  console.log(`${out} is up to date (use --force to regenerate)`);
}
