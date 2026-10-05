import { randomUUID } from 'node:crypto';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { SignJWT, importPKCS8 } from 'jose';

/**
 * Plays the bank's backend: mints the short-lived launch token the bank app hands to the P2P web app.
 * Uses the demo key pair from the repository's .env (`pnpm dev:keys`).
 */
function bankBackend(privateKeyPem: string | undefined, apiUrl: string, opsToken: string | undefined): Plugin {
  return {
    name: 'demo-bank-backend',
    configureServer(server) {
      // Back office and dealer screen. A signed-in operator's own session is passed through, so the audit log
      // names them. Without one, the bank's service token may only read (the dealer screen's live view).
      server.middlewares.use('/bank/ops', async (req, res) => {
        if (!opsToken) {
          res.statusCode = 500;
          return res.end('OPS_TOKEN missing: run pnpm dev:keys');
        }
        const operator = req.headers.authorization;
        const isLogin = req.url === '/login';
        // Without an operator login only the dealer screen's read-only view goes through with the service token.
        if (!operator && !isLogin && !(req.method === 'GET' && req.url === '/dealing')) {
          res.statusCode = 401;
          res.setHeader('content-type', 'application/json');
          return res.end(JSON.stringify({ error: 'UNAUTHORIZED', message: 'ops login required' }));
        }
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        try {
          const upstream = await fetch(`${apiUrl}/ops${req.url ?? ''}`, {
            method: req.method,
            headers: {
              ...(isLogin ? {} : operator ? { authorization: operator } : { authorization: `Bearer ${opsToken}`, 'x-ops-actor': 'dealer-screen' }),
              ...(chunks.length ? { 'content-type': 'application/json' } : {}),
            },
            body: chunks.length ? Buffer.concat(chunks) : undefined,
          });
          res.statusCode = upstream.status;
          res.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json');
          res.end(Buffer.from(await upstream.arrayBuffer()));
        } catch (e) {
          res.statusCode = 502;
          res.end(JSON.stringify({ message: (e as Error).message }));
        }
      });
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
    plugins: [bankBackend(env.BANK_JWT_PRIVATE_KEY, env.API_URL ?? 'http://localhost:4000', env.OPS_TOKEN)],
    define: { __WEB_APP_URL__: JSON.stringify(env.WEB_APP_URL ?? 'http://localhost:5173') },
    server: { port: 5174, host: true },
    build: { rollupOptions: { input: { main: 'index.html', dealer: 'dealer.html', backoffice: 'backoffice.html' } } },
  };
});
