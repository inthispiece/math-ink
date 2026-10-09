import { defineConfig } from 'vite';
import { resolve } from 'node:path';
export default defineConfig({
  base: './',
  server: {
    proxy: { '/v1': { target: `http://127.0.0.1:${process.env.GATEWAY_PORT ?? '8787'}`, changeOrigin: true } },
    host: '127.0.0.1',
    fs: { allow: [resolve('.')] }
  },
  build: { sourcemap: true }
});
