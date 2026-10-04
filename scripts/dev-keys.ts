// Writes .env (or the file after --out) with a demo bank signing key pair and local secrets.
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';

const outAt = process.argv.indexOf('--out');
const out = outAt > 0 ? process.argv[outAt + 1] : '.env';
if (existsSync(out) && !process.argv.includes('--force')) {
  console.log(`${out} already exists (use --force to overwrite)`);
  process.exit(0);
}
const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
const oneLine = (pem: string) => pem.trim().replace(/\n/g, '\\n');
const env = {
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/p2pfx',
  CORE_BANKING_URL: 'http://localhost:4100',
  BANK_JWT_PUBLIC_KEY: oneLine(await exportSPKI(publicKey)),
  // Only the bank backend (and the demo host) holds this; the platform never needs it.
  BANK_JWT_PRIVATE_KEY: oneLine(await exportPKCS8(privateKey)),
  SESSION_SECRET: randomBytes(32).toString('hex'),
  OPS_TOKEN: randomBytes(16).toString('hex'),
  // First back office administrator (user `admin`), created only while the database has no operators.
  // A known password so a demo presenter can sign in; set OPS_ADMIN_PASSWORD to choose another.
  OPS_ADMIN_PASSWORD: process.env.OPS_ADMIN_PASSWORD ?? 'demo-admin',
};
writeFileSync(out, Object.entries(env).map(([k, v]) => `${k}="${v}"`).join('\n') + '\n');
console.log(`wrote ${out}`);
