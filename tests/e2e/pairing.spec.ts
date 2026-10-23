import { test, expect } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { Page } from '@playwright/test';
import type { Note, Settings } from '../../apps/web/src/model';

// This server uses fixed test secrets, a temporary database and an isolated provider fixture.
// It never loads .env, reuses the user's preview port, or calls a paid OCR provider.
const fixtureToken = 'mathink-browser-pairing-fixture-2026';
let server: ChildProcessWithoutNullStreams;
let temporary = '';
let origin = '';

test.use({ serviceWorkers: 'block' });

test.beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'mathink-browser-pairing-'));
  server = spawn(process.execPath, ['--import', './tests/e2e/fixtures/mathpix-provider.mjs', 'scripts/serve-preview.mjs'], {
    cwd: resolve('.'),
    env: {
      ...process.env, OCR_PROVIDER: 'mathpix', GATEWAY_HOST: '127.0.0.1', GATEWAY_PORT: '0',
      GATEWAY_PAIRING_TOKEN: fixtureToken, GATEWAY_DATABASE_PATH: join(temporary, 'quota.sqlite'),
      MATHINK_E2E_PROVIDER_FIXTURE: '1', MATHPIX_APP_ID: 'e2e-app-id', MATHPIX_APP_KEY: 'e2e-key-not-real', OCR_INSTALLATION_DAILY_LIMIT: '100',
      OCR_GLOBAL_DAILY_LIMIT: '1000', OCR_GLOBAL_MONTHLY_LIMIT: '1000',
    },
    stdio: 'pipe',
  });
  await new Promise<void>((done, reject) => {
    const timeout = setTimeout(() => reject(new Error('The isolated pairing preview did not start')), 20000);
    server.once('error', error => { clearTimeout(timeout); reject(error); });
    server.once('exit', code => { clearTimeout(timeout); reject(new Error(`The isolated pairing preview stopped (${code})`)); });
    server.stderr.resume();
    let stdout = '';
    server.stdout.on('data', chunk => {
      stdout += chunk;
      const match = stdout.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { origin = `http://127.0.0.1:${match[1]}`; clearTimeout(timeout); done(); }
    });
  });
  const status = await (await fetch(origin + '/v1/status')).json() as { provider: string; simulated: boolean };
  expect(status.provider).toBe('mathpix');
  expect(status.simulated).toBe(false);
});

test.afterAll(async () => {
  if (server && server.exitCode === null) { const exited = once(server, 'exit'); server.kill(); await exited; }
  if (temporary) {
    const checked = resolve(temporary);
    if (!checked.startsWith(resolve(tmpdir()) + sep) || !checked.includes('mathink-browser-pairing-')) throw new Error('Unexpected temporary directory');
    await rm(checked, { recursive: true, force: true });
  }
});

async function settings(page: Page): Promise<Settings> {
  return page.evaluate(() => JSON.parse(localStorage.getItem('math-ink-settings') || '{}'));
}

async function notes(page: Page): Promise<Note[]> {
  return page.evaluate(() => new Promise<Note[]>((done, reject) => {
    const request = indexedDB.open('math-ink-notebooks', 1);
    request.onerror = () => reject(new Error('Cannot read saved notebooks'));
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('notes', 'readonly');
      const read = transaction.objectStore('notes').getAll();
      read.onsuccess = () => done(read.result);
      read.onerror = () => reject(new Error('Cannot read saved notebooks'));
      transaction.oncomplete = () => database.close();
    };
  }));
}

async function openPreview(page: Page) {
  await page.goto(origin + '/');
  await expect(page.locator('#save-state')).toHaveText('已保存到本机');
  await expect.poll(async () => (await settings(page)).pairingToken).toBe(fixtureToken);
  expect((await settings(page)).gatewayUrl).toBe(origin);
}

async function canvasPath(page: Page, points: [number, number][]) {
  const canvas = page.locator('#ink-canvas');
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('The handwriting canvas is not visible');
  await page.mouse.move(box.x + points[0][0], box.y + points[0][1]);
  await page.mouse.down();
  for (const [x, y] of points.slice(1)) await page.mouse.move(box.x + x, box.y + y, { steps: 8 });
  await page.mouse.up();
}

async function writeAndSelect(page: Page) {
  await page.getByRole('button', { name: '钢笔', exact: true }).click();
  await canvasPath(page, [[90, 150], [125, 180], [160, 210]]);
  await canvasPath(page, [[90, 210], [125, 180], [160, 150]]);
  await page.getByRole('button', { name: '圈选笔迹', exact: true }).click();
  await canvasPath(page, [[70, 130], [185, 130], [185, 235], [70, 235], [70, 130]]);
  await expect(page.locator('#selection-label')).toHaveText('已圈选 2 笔');
  await expect.poll(async () => (await notes(page))[0].strokes.length).toBe(2);
}

async function recognizeWithConsent(page: Page) {
  await page.getByRole('button', { name: '识别圈选公式', exact: true }).click();
  await page.getByRole('button', { name: '同意并识别', exact: true }).click();
}

test('loopback preview pairs automatically and real handwriting submits the required Bearer token to the isolated provider gateway', async ({ page }, testInfo) => {
  const submissions: { authorization: string | undefined; body: Record<string, unknown> }[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/v1/recognize') submissions.push({ authorization: request.headers().authorization, body: request.postDataJSON() });
  });
  await openPreview(page);
  expect((await settings(page)).cloudConsent).toBe(false);
  await writeAndSelect(page);
  const original = (await notes(page))[0].strokes;
  await recognizeWithConsent(page);
  await expect(page.locator('#provider-badge')).toContainText('联网识别 · mathpix');
  await expect(page.locator('#latex-input')).not.toHaveValue('');
  expect(submissions).toHaveLength(1);
  expect(submissions[0].authorization).toBe(`Bearer ${fixtureToken}`);
  expect(Buffer.from(submissions[0].body.imageBase64 as string, 'base64').subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect((await notes(page))[0].strokes).toEqual(original);
  await expect(page.locator('#quota-summary')).toContainText('99 / 100');
  const notebookScreenshot = testInfo.outputPath('provider-and-real-quota.png');
  await page.screenshot({ path: notebookScreenshot, fullPage: true, animations: 'disabled' });
  await testInfo.attach('provider-and-real-quota', { path: notebookScreenshot, contentType: 'image/png' });
  await page.getByRole('button', { name: '识别与设备设置', exact: true }).click();
  await expect(page.locator('#service-details')).toContainText('已用 1 / 100');
  const settingsScreenshot = testInfo.outputPath('provider-quota-settings.png');
  await page.screenshot({ path: settingsScreenshot, fullPage: true, animations: 'disabled' });
  await testInfo.attach('provider-quota-settings', { path: settingsScreenshot, contentType: 'image/png' });
});

test('connection check rejects an incorrect token instead of treating public status metadata as successful pairing', async ({ page }) => {
  await openPreview(page);
  await page.getByRole('button', { name: '识别与设备设置', exact: true }).click();
  await page.locator('#pairing-token').fill('incorrect-pairing-fixture');
  const checked = page.waitForResponse(response => new URL(response.url()).pathname === '/v1/pairing');
  let recognitionCalls = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/v1/recognize') recognitionCalls++; });
  await page.getByRole('button', { name: '检查服务连接', exact: true }).click();
  expect((await checked).status()).toBe(401);
  await expect(page.locator('#service-status')).toContainText(/未连接|配对|令牌/);
  await expect(page.locator('#service-status')).not.toContainText(/服务可连接|服务已配对/);
  await expect(page.locator('#settings-dialog')).toBeVisible();
  await expect(page.locator('#pairing-token')).toBeFocused();
  expect(recognitionCalls).toBe(0);
  // Whitespace pasted around a valid token must not make authentication fail.
  await page.locator('#pairing-token').fill(`  ${fixtureToken}  `);
  await page.getByRole('button', { name: '检查服务连接', exact: true }).click();
  await expect(page.locator('#service-status')).toContainText(/服务已配对|服务可连接/);
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  expect((await settings(page)).pairingToken).toBe(fixtureToken);
});

test('a stale token opens repair settings; saving the correct token preserves the crop and waits for one explicit retry', async ({ page }) => {
  await openPreview(page);
  await writeAndSelect(page);
  const original = (await notes(page))[0].strokes;
  await page.getByRole('button', { name: '识别与设备设置', exact: true }).click();
  await page.locator('#pairing-token').fill('expired-pairing-fixture');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  const submissions: { authorization: string | undefined; body: unknown }[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/v1/recognize') submissions.push({ authorization: request.headers().authorization, body: request.postDataJSON() });
  });
  const failed = page.waitForResponse(response => new URL(response.url()).pathname === '/v1/recognize');
  await recognizeWithConsent(page);
  expect((await failed).status()).toBe(401);
  await expect(page.locator('#settings-dialog')).toBeVisible();
  await expect(page.locator('#pairing-token')).toBeFocused();
  await expect(page.locator('#math-preview')).toContainText('原稿已保留');
  await expect(page.locator('#math-preview')).not.toContainText('。。');
  expect(submissions).toHaveLength(1);
  expect((await notes(page))[0].strokes).toEqual(original);
  await page.locator('#pairing-token').fill(` ${fixtureToken} `);
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.locator('#settings-dialog')).not.toBeVisible();
  // Observe the absence of another OCR POST without waiting on unrelated assets.
  await page.waitForTimeout(500);
  expect(submissions).toHaveLength(1);
  await page.getByRole('button', { name: '重试当前选区', exact: true }).click();
  await expect(page.locator('#provider-badge')).toContainText('联网识别 · mathpix');
  expect(submissions).toHaveLength(2);
  expect(submissions[0].authorization).toBe('Bearer expired-pairing-fixture');
  expect(submissions[1].authorization).toBe(`Bearer ${fixtureToken}`);
  expect(submissions[1].body).toEqual(submissions[0].body);
  expect((await notes(page))[0].strokes).toEqual(original);
  expect((await settings(page)).cloudConsent).toBe(true);
});

test('a pairing link stores its token and current gateway, removes the fragment, and preserves existing notes and upload consent', async ({ page }) => {
  await openPreview(page);
  await page.getByLabel('笔记标题', { exact: true }).fill('配对前已有的数学原稿');
  await writeAndSelect(page);
  await page.getByRole('tab', { name: /整理笔记/ }).click();
  await page.getByLabel('Markdown 正文', { exact: true }).fill('## 证明\n\n配对不能修改原稿、笔记或上传同意。');
  await expect.poll(async () => (await notes(page))[0].markdown).toContain('配对不能修改');
  await page.getByRole('button', { name: '识别与设备设置', exact: true }).click();
  await page.locator('#gateway-url').fill('http://127.0.0.1:1');
  await page.locator('#pairing-token').fill('previous-server-fixture');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  const before = await notes(page);
  const settingsBefore = await settings(page);
  expect(settingsBefore.cloudConsent).toBe(false);
  // The explicit link must work without a local bootstrap (as it does on a LAN tablet).
  await page.route('**/v1/local-pairing', route => route.fulfill({ status: 403, json: { status: 'error' } }));
  await page.goto(`${origin}/#mathink-pair=${encodeURIComponent(fixtureToken)}`);
  await expect(page.locator('#save-state')).toHaveText('已保存到本机');
  await expect.poll(async () => (await settings(page)).pairingToken).toBe(fixtureToken);
  expect(new URL(page.url()).hash).toBe('');
  const settingsAfter = await settings(page);
  expect(settingsAfter.gatewayUrl).toBe(origin);
  expect(settingsAfter.installationId).toBe(settingsBefore.installationId);
  expect(settingsAfter.cloudConsent).toBe(false);
  expect(settingsAfter.inkMode).toBe(settingsBefore.inkMode);
  expect(await notes(page)).toEqual(before);
  await expect(page.getByLabel('笔记标题', { exact: true })).toHaveValue('配对前已有的数学原稿');
  await expect(page.locator('#stroke-count')).toHaveText('2 笔');
  await page.reload();
  await expect(page.locator('#save-state')).toHaveText('已保存到本机');
  expect((await settings(page)).pairingToken).toBe(fixtureToken);
  expect((await settings(page)).cloudConsent).toBe(false);
  expect(await notes(page)).toEqual(before);
});

test('the Vite development proxy cannot expose loopback-only pairing credentials', async ({ request }) => {
  const response = await request.get('/v1/local-pairing');
  expect(response.status()).toBe(403);
  const body = await response.json();
  expect(body.status).toBe('error');
  expect(body.error.code).toBe('LOCAL_PAIRING_NOT_ALLOWED');
  expect(body).not.toHaveProperty('pairingToken');
});
