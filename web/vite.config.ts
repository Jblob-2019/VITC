import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: Vite on :5173, Express on :8080. Proxy WS + REST.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    host: true,
    proxy: {
      '/api': 'http://localhost:4000',
      '/ws':  { target: 'ws://localhost:4000', ws: true },
      '/positions.json': 'http://localhost:4000',
    },
  },
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
});