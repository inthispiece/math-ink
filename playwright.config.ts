import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:5173', channel: 'msedge', headless: true, viewport: { width: 1365, height: 900 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: 'node scripts/dev.mjs --demo', url: 'http://127.0.0.1:5173', reuseExistingServer: !process.env.CI, timeout: 30000 },
});
