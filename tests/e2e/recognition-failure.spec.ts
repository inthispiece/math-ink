import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { installReadyOcrMetadata } from './fixtures/ocr-state';

// Use real pointer input so recognition starts from the same editable ink as a user.
async function canvasPath(page: Page, points: [number, number][]) {
  const bounds = await page.locator('#ink-canvas').boundingBox();
  if (!bounds) throw new Error('Handwriting canvas is not visible');
  await page.mouse.move(bounds.x + points[0][0], bounds.y + points[0][1]);
  await page.mouse.down();
  for (const [x, y] of points.slice(1)) await page.mouse.move(bounds.x + x, bounds.y + y, { steps: 4 });
  await page.mouse.up();
}

async function writeAndSelect(page: Page) {
  await page.getByRole('button', { name: '钢笔', exact: true }).click();
  await canvasPath(page, [[90, 150], [125, 180], [160, 210]]);
  await canvasPath(page, [[90, 210], [125, 180], [160, 150]]);
  await page.getByRole('button', { name: '圈选笔迹', exact: true }).click();
  await canvasPath(page, [[70, 130], [185, 130], [185, 235], [70, 235], [70, 130]]);
  await expect(page.locator('#selection-label')).toHaveText('已圈选 2 笔');
}

async function startRecognition(page: Page) {
  await page.getByRole('button', { name: '转写为 LaTeX', exact: true }).click();
  await page.getByRole('button', { name: '同意并转写', exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  await installReadyOcrMetadata(page);
  await page.goto('/');
  await expect(page.locator('#save-state')).toHaveText('已保存到本机');
  await writeAndSelect(page);
});

for (const failure of ['network', 'missing-credentials', 'pairing-token', 'quota-exhausted', 'invalid-json'] as const) {
  test(`${failure} leaves the main preview in a recoverable error state and preserves ink`, async ({ page }, testInfo) => {
    let calls = 0;
    await page.route('**/v1/recognize', async route => {
      calls++;
      if (calls > 1) return route.fulfill({ json: { status: 'ok', simulated: false, provider: 'mathpix', latex: 'x^2', sourceRevision: route.request().postDataJSON().sourceRevision } });
      if (failure === 'network') return route.abort('failed');
      if (failure === 'invalid-json') return route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>服务代理尚未配置</body></html>' });
      const failureResponse = failure === 'pairing-token'
        ? { status: 401, code: 'UNAUTHORIZED', message: '配对令牌无效，请检查设置。' }
        : failure === 'quota-exhausted'
          ? { status: 429, code: 'QUOTA_EXCEEDED', message: '今日识别额度已用完，请稍后再试。' }
          : { status: 503, code: 'PROVIDER_NOT_CONFIGURED', message: 'Mathpix 识别服务尚未配置，请先配置凭据。' };
      return route.fulfill({ status: failureResponse.status, json: { status: 'error', provider: 'mathpix', simulated: false, error: { code: failureResponse.code, message: failureResponse.message, retryable: false } } });
    });
    await startRecognition(page);
    await expect(page.locator('#math-preview')).toContainText('识别失败');
    await expect(page.locator('#math-preview')).toContainText('原稿已保留');
    await expect(page.locator('#math-preview')).not.toContainText('等待识别结果');
    await expect(page.getByRole('button', { name: '确认并整理', exact: true })).toBeDisabled();
    await expect(page.locator('#retry')).toBeVisible();
    await expect(page.locator('#stroke-count')).toHaveText('2 笔');
    expect(calls).toBe(1);
    if (failure === 'pairing-token') {
      await expect(page.locator('#settings-dialog')).toBeVisible();
      await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    }
    if (failure === 'network') {
      const screenshot = testInfo.outputPath('recognition-error-with-original-ink.png');
      await page.screenshot({ path: screenshot, fullPage: true, animations: 'disabled' });
      await testInfo.attach('recognition-error-with-original-ink', { path: screenshot, contentType: 'image/png' });
    }
    await page.locator('#retry').click();
    await expect(page.locator('#latex-input')).toHaveValue('x^2');
    await page.getByRole('button', { name: '确认并整理', exact: true }).click();
    await expect(page.locator('#formula-count')).toHaveText('1 公式');
    await expect(page.locator('#stroke-count')).toHaveText('2 笔');
    expect(calls).toBe(2);
  });
}

test('a response that sends headers but never finishes the JSON body still times out', async ({ page }, testInfo) => {
  const sockets = new Set<Socket>();
  let recognitionCalls = 0;
  const server = createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
    recognitionCalls++;
    request.resume();
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.flushHeaders();
    // Real HTTP headers and partial body: fetch() resolves, response.json() never does.
    response.write('{"status":"ok","latex":');
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test recognition server did not start');
  const gateway = `http://127.0.0.1:${address.port}`;
  try {
    await page.getByRole('button', { name: '识别与设备设置', exact: true }).click();
    await page.locator('#gateway-url').fill(gateway);
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await page.clock.install();
    const headersReceived = page.waitForResponse(response => response.url() === `${gateway}/v1/recognize`);
    await startRecognition(page);
    await headersReceived;
    await expect(page.locator('#math-preview')).toContainText('等待识别结果');
    await page.clock.fastForward(36000);
    await expect(page.locator('#math-preview')).toContainText('识别超时');
    await expect(page.locator('#math-preview')).toContainText('原稿已保留');
    await expect(page.getByRole('button', { name: '确认并整理', exact: true })).toBeDisabled();
    await expect(page.locator('#retry')).toBeVisible();
    await expect(page.getByRole('button', { name: '转写为 LaTeX', exact: true })).toBeEnabled();
    expect(recognitionCalls).toBe(1);
    const screenshot = testInfo.outputPath('stalled-body-timeout-with-original-ink.png');
    await page.screenshot({ path: screenshot, fullPage: true, animations: 'disabled' });
    await testInfo.attach('stalled-body-timeout-with-original-ink', { path: screenshot, contentType: 'image/png' });
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.locator('#recognition-preview')).not.toBeVisible();
    await expect(page.locator('#stroke-count')).toHaveText('2 笔');
    await expect(page.locator('#formula-count')).toHaveText('0 公式');
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('cancelled recognition cannot overwrite or unlock a newer pending recognition', async ({ page }) => {
  const releases: (() => void)[] = [];
  let completedOld = false;
  await page.route('**/v1/recognize', async route => {
    const index = releases.length;
    await new Promise<void>(resolve => releases.push(resolve));
    await route.fulfill({ json: { status: 'ok', simulated: false, provider: 'mathpix', latex: index === 0 ? 'OLD_RESULT' : 'x^2', sourceRevision: route.request().postDataJSON().sourceRevision } });
    if (index === 0) completedOld = true;
  });
  await startRecognition(page);
  await expect.poll(() => releases.length).toBe(1);
  await expect(page.locator('#math-preview')).toContainText('等待识别结果');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('#recognition-preview')).not.toBeVisible();
  await expect(page.getByRole('button', { name: '转写为 LaTeX', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '转写为 LaTeX', exact: true }).click();
  await expect.poll(() => releases.length).toBe(2);
  releases[0]();
  await expect.poll(() => completedOld).toBe(true);
  await expect(page.locator('#latex-input')).toHaveValue('');
  await expect(page.locator('#math-preview')).toContainText('等待识别结果');
  await expect(page.locator('#recognize')).toBeDisabled();
  await expect(page.getByRole('button', { name: '确认并整理', exact: true })).toBeDisabled();
  releases[1]();
  await expect(page.locator('#latex-input')).toHaveValue('x^2');
  await page.getByRole('button', { name: '确认并整理', exact: true }).click();
  await expect(page.locator('#formula-count')).toHaveText('1 公式');
  await expect(page.locator('#stroke-count')).toHaveText('2 笔');
});

test('switching notebooks cancels the pending recognition and ignores its late result', async ({ page }) => {
  let release: (() => void) | undefined;
  let finished = false;
  await page.route('**/v1/recognize', async route => {
    await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ json: { status: 'ok', simulated: false, provider: 'mathpix', latex: 'OLD_NOTE', sourceRevision: route.request().postDataJSON().sourceRevision } });
    finished = true;
  });
  await page.getByLabel('笔记标题', { exact: true }).fill('含有原稿的笔记');
  await startRecognition(page);
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.getByRole('button', { name: '新建笔记', exact: false }).click();
  await expect(page.locator('#stroke-count')).toHaveText('0 笔');
  release!();
  await expect.poll(() => finished).toBe(true);
  await expect(page.locator('#recognition-preview')).not.toBeVisible();
  await expect(page.locator('#formula-count')).toHaveText('0 公式');
  await page.locator('#note-list').getByRole('button').filter({ hasText: '含有原稿的笔记' }).click();
  await expect(page.locator('#stroke-count')).toHaveText('2 笔');
  await expect(page.locator('#formula-count')).toHaveText('0 公式');
  await expect(page.locator('#recognition-preview')).not.toBeVisible();
});
