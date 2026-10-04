// Mints a bank launch token for a customer, as the bank backend would: pnpm dev:token demo-ayse [segment]
import { randomUUID } from 'node:crypto';
import { SignJWT, importPKCS8 } from 'jose';

const [customerRef = 'demo-ayse', segment = 'default'] = process.argv.slice(2);
const pem = process.env.BANK_JWT_PRIVATE_KEY?.replace(/\\n/g, '\n');
if (!pem) throw new Error('BANK_JWT_PRIVATE_KEY missing: run pnpm dev:keys');
const key = await importPKCS8(pem, 'RS256');
const now = Math.floor(Date.now() / 1000);
const token = await new SignJWT({ customer_ref: customerRef, segment, locale: 'tr-TR' })
  .setProtectedHeader({ alg: 'RS256' })
  .setAudience('p2pfx')
  .setIssuedAt(now)
  .setExpirationTime(now + 60)
  .setJti(randomUUID())
  .sign(key);
console.log(token);
