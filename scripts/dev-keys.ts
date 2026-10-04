// Writes .env with a demo bank signing key pair and local secrets.
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';

if (existsSync('.env') && !process.argv.includes('--force')) {
  console.log('.env already exists (use --force to overwrite)');
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
};
writeFileSync('.env', Object.entries(env).map(([k, v]) => `${k}="${v}"`).join('\n') + '\n');
console.log('wrote .env');
