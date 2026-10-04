import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = process.env.API_URL ?? 'http://localhost:4000';

// Which pages may embed the app in a frame, e.g. "https://bank.example". In production the bank's web server
// or CDN sends this header; here the dev and preview servers do.
const frameAncestors = process.env.FRAME_ANCESTORS;
const headers = frameAncestors ? { 'Content-Security-Policy': `frame-ancestors ${frameAncestors}` } : undefined;

// The web app talks to the API on its own origin; in development Vite proxies to the API server.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    headers,
    proxy: {
      '/v1/stream': { target: api.replace(/^http/, 'ws'), ws: true },
      '/v1': { target: api, changeOrigin: true },
    },
  },
  preview: { port: 5173, headers },
});
