import { randomUUID } from 'node:crypto';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { SignJWT, importPKCS8 } from 'jose';

/**
 * Plays the bank's backend: mints the short-lived launch token the bank app hands to the P2P web app.
 * Uses the demo key pair from the repository's .env (`pnpm dev:keys`).
 */
function bankBackend(privateKeyPem: string | undefined): Plugin {
  return {
    name: 'demo-bank-backend',
    configureServer(server) {
      server.middlewares.use('/bank/launch-token', async (req, res) => {
        if (!privateKeyPem) {
          res.statusCode = 500;
          return res.end('BANK_JWT_PRIVATE_KEY missing: run pnpm dev:keys');
        }
        const q = new URL(req.url ?? '', 'http://x').searchParams;
        const key = await importPKCS8(privateKeyPem.replace(/\\n/g, '\n'), 'RS256');
        const now = Math.floor(Date.now() / 1000);
        const token = await new SignJWT({ customer_ref: q.get('customer') ?? 'demo-ayse', segment: q.get('segment') ?? 'default', locale: q.get('locale') ?? 'tr-TR' })
          .setProtectedHeader({ alg: 'RS256' })
          .setAudience('p2pfx')
          .setIssuedAt(now)
          .setExpirationTime(now + 60)
          .setJti(randomUUID())
          .sign(key);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ launchToken: token }));
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', '');
  return {
    plugins: [bankBackend(env.BANK_JWT_PRIVATE_KEY)],
    define: { __WEB_APP_URL__: JSON.stringify(env.WEB_APP_URL ?? 'http://localhost:5173') },
    server: { port: 5174, host: true },
  };
});
