import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = process.env.API_URL ?? 'http://localhost:4000';

// The web app talks to the API on its own origin; in development Vite proxies to the API server.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/v1/stream': { target: api.replace(/^http/, 'ws'), ws: true },
      '/v1': { target: api, changeOrigin: true },
    },
  },
  preview: { port: 5173 },
});
