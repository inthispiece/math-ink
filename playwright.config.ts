import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:5175', channel: 'msedge', headless: true, viewport: { width: 1365, height: 900 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: 'node scripts/test-dev.mjs', url: 'http://127.0.0.1:5175', reuseExistingServer: false, timeout: 30000 },
});
