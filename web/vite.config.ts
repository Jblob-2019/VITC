import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: Vite on :3000, Express on :4000. Proxy WS + REST.
// In production the backend serves the built SPA from /public on the same port.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    host: true,
    proxy: {
      '/api':           { target: 'http://localhost:4000', changeOrigin: true },
      '/healthz':       { target: 'http://localhost:4000', changeOrigin: true },
      '/ws':            { target: 'ws://localhost:4000',  ws: true, changeOrigin: true },
      '/positions.json':{ target: 'http://localhost:4000', changeOrigin: true },
    },
  },
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
});