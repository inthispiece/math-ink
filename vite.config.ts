import { defineConfig } from 'vite';
import { resolve } from 'node:path';
export default defineConfig({
  base: './',
  optimizeDeps: {include:['pdfjs-dist/legacy/build/pdf.mjs','pdf-lib']},
  server: {
    // Mark forwarded requests so the private localhost bootstrap cannot be
    // reached through a LAN-exposed development proxy.
    proxy: { '/v1': { target: `http://127.0.0.1:${process.env.GATEWAY_PORT ?? '8787'}`, changeOrigin: true, xfwd: true } },
    host: '127.0.0.1',
    fs: { allow: [resolve('.')] }
  },
  build: { sourcemap: true }
});
