import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { Page, TestInfo } from '@playwright/test';
import type { Note } from '../../apps/web/src/model';

// All canvas input uses browser pointer events; no note or recognition state is injected.
async function canvasPath(page: Page, points: [number, number][]) {
  const canvas = page.locator('#ink-canvas');
  await canvas.scrollIntoViewIfNeeded();
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('Handwriting canvas is not visible');
  await page.mouse.move(bounds.x + points[0][0], bounds.y + points[0][1]);
  await page.mouse.down();
  for (const [x, y] of points.slice(1)) await page.mouse.move(bounds.x + x, bounds.y + y, { steps: 8 });
  await page.mouse.up();
}

async function writeAndSelect(page: Page, includeOutsideStroke = true) {
  await page.getByRole('button', { name: '钢笔', exact: true }).click();
  await canvasPath(page, [[90, 150], [125, 180], [160, 210]]);
  await canvasPath(page, [[90, 210], [125, 180], [160, 150]]);
  if (includeOutsideStroke) await canvasPath(page, [[330, 140], [370, 160], [410, 200]]);
  await expect(page.locator('#stroke-count')).toHaveText(`${includeOutsideStroke ? 3 : 2} 笔`);
  await page.getByRole('button', { name: '圈选笔迹', exact: true }).click();
  await canvasPath(page, [[70, 130], [185, 130], [185, 235], [70, 235], [70, 130]]);
  await expect(page.locator('#selection-label')).toHaveText('已圈选 2 笔');
  await expect(page.getByRole('button', { name: '识别圈选公式', exact: true })).toBeEnabled();
}

async function readNotes(page: Page): Promise<Note[]> {
  return page.evaluate(() => new Promise<Note[]>((resolve, reject) => {
    const request = indexedDB.open('math-ink-notebooks', 1);
    request.onerror = () => reject(new Error('Cannot read saved notebooks'));
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('notes', 'readonly');
      const read = transaction.objectStore('notes').getAll();
      read.onsuccess = () => resolve(read.result);
      read.onerror = () => reject(new Error('Cannot read saved notebooks'));
      transaction.oncomplete = () => database.close();
    };
  }));
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#save-state')).toHaveText('已保存到本机');
  await expect(page.locator('#canvas-mode')).toHaveText('实验画布');
});

test('actual handwriting → lasso → consent → gateway mock → corrected LaTeX → organized → source, with durable reload', async ({ page }, testInfo) => {
  const requests: Record<string, unknown>[] = [];
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/v1/recognize') requests.push(request.postDataJSON());
  });
  await page.getByLabel('笔记标题', { exact: true }).fill('积分：手写到 LaTeX');
  await page.getByLabel('笔记标签，逗号分隔').fill('分析,积分');
  await page.getByLabel('笔记标签，逗号分隔').blur();
  await writeAndSelect(page);
  await expect.poll(async () => (await readNotes(page))[0].strokes.length).toBe(3);
  const sourceBefore = (await readNotes(page))[0].strokes;
  await page.getByRole('button', { name: '识别圈选公式', exact: true }).click();
  await expect(page.getByRole('dialog').filter({ hasText: '上传本次圈选的公式？' })).toBeVisible();
  expect(requests).toHaveLength(0);
  await page.getByRole('button', { name: '同意并识别', exact: true }).click();
  await expect(page.locator('#provider-badge')).toHaveText('模拟识别 · 固定样例，未识别真实笔迹');
  expect(requests).toHaveLength(1);
  expect(Object.keys(requests[0]).sort()).toEqual(['clientRequestId', 'imageBase64', 'installationId', 'sourceRevision']);
  expect(requests[0].sourceRevision).toBe(3);
  const png = Buffer.from(requests[0].imageBase64 as string, 'base64');
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  // Selected formula is 70px wide; the unselected third stroke is 250px away.
  // A full-page or bounding box containing that stroke would exceed this limit.
  expect(png.readUInt32BE(16)).toBeLessThan(260);
  expect(png.readUInt32BE(20)).toBeLessThan(240);
  await expect(page.locator('#latex-input')).not.toHaveValue('');
  const corrected = '\\int_0^\\infty e^{-x}\\,dx=1';
  await page.getByLabel('LaTeX · 可直接修改', { exact: true }).fill(corrected);
  await expect(page.locator('#math-preview .katex')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.fonts.check('16px KaTeX_Main'))).toBe(true);
  await capture(page, testInfo, 'handwriting-and-recognition');
  await page.getByRole('button', { name: '确认并整理', exact: true }).click();
  await expect(page.locator('#formula-count')).toHaveText('1 公式');
  await expect(page.locator('#stroke-count')).toHaveText('3 笔');
  await expect(page.locator('#confirmed-list')).toContainText('已关联原稿');
  await expect.poll(async () => (await readNotes(page))[0].formulas.length).toBe(1);
  const saved = (await readNotes(page))[0];
  expect(saved.strokes).toEqual(sourceBefore);
  expect(saved.formulas[0].latex).toBe(corrected);
  expect(saved.formulas[0].sourceStrokeIds).toHaveLength(2);
  expect(saved.formulas[0].sourceRevision).toBe(3);
  expect(saved.formulas[0].simulated).toBe(true);
  await page.getByRole('tab', { name: /整理笔记/ }).click();
  await page.getByRole('button', { name: '＋ 定理', exact: true }).click();
  await expect(page.locator('#markdown-input')).toHaveValue(/## 定理/);
  await capture(page, testInfo, 'organized-notebook');
  await page.locator('#organized-formulas').getByRole('button', { name: '返回原稿', exact: true }).click();
  await expect(page.getByRole('tab', { name: /手写原稿/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#selection-label')).toHaveText('已圈选 2 笔');
  await expect.poll(async () => (await readNotes(page))[0].markdown).toContain('## 定理');
  await page.reload();
  await expect(page.getByLabel('笔记标题', { exact: true })).toHaveValue('积分：手写到 LaTeX');
  await expect(page.locator('#stroke-count')).toHaveText('3 笔');
  await expect(page.locator('#formula-count')).toHaveText('1 公式');
  await page.getByRole('tab', { name: /整理笔记/ }).click();
  await expect(page.locator('#markdown-input')).toHaveValue(/## 定理/);
  await page.locator('#organized-formulas').getByRole('button', { name: '编辑 LaTeX', exact: true }).click();
  await expect(page.getByLabel('编辑已保存公式', { exact: true })).toHaveValue(corrected);
  expect(pageErrors).toEqual([]);
});

test('empty selection submits nothing; refusing cloud consent leaves original notes editable', async ({ page }) => {
  let requests = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/v1/recognize') requests++; });
  await expect(page.getByRole('button', { name: '识别圈选公式', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '圈选笔迹', exact: true }).click();
  await canvasPath(page, [[70, 130], [180, 130], [180, 235], [70, 235], [70, 130]]);
  await expect(page.locator('#selection-label')).toHaveText('未圈选');
  await expect(page.locator('#toast')).toContainText('这次圈选没有笔迹');
  expect(requests).toBe(0);
  await writeAndSelect(page, false);
  await page.getByRole('button', { name: '识别圈选公式', exact: true }).click();
  await page.getByRole('button', { name: '继续离线书写', exact: true }).click();
  await expect(page.locator('#consent-dialog')).not.toBeVisible();
  await expect(page.locator('#stroke-count')).toHaveText('2 笔');
  await page.getByRole('button', { name: '钢笔', exact: true }).click();
  await canvasPath(page, [[240, 260], [300, 285]]);
  await expect(page.locator('#stroke-count')).toHaveText('3 笔');
  await expect.poll(async () => (await readNotes(page))[0].strokes.length).toBe(3);
  expect(requests).toBe(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('math-ink-settings') || '{}').cloudConsent)).not.toBe(true);
});

test('already opened notebook remains writable and saves offline; reloading later keeps the original strokes and prose', async ({ page, context }) => {
  await context.setOffline(true);
  await page.getByLabel('笔记标题', { exact: true }).fill('断网时的推导');
  await writeAndSelect(page, false);
  await page.getByRole('tab', { name: /整理笔记/ }).click();
  const prose = '## 证明\n\n即使当前没有网络，原稿和推导仍保存到本机。';
  await page.getByLabel('Markdown 正文', { exact: true }).fill(prose);
  await expect.poll(async () => (await readNotes(page))[0].markdown).toBe(prose);
  await expect(page.locator('#save-state')).toHaveText('已保存到本机');
  await context.setOffline(false);
  await page.reload();
  await expect(page.getByLabel('笔记标题', { exact: true })).toHaveValue('断网时的推导');
  await expect(page.locator('#stroke-count')).toHaveText('2 笔');
  await page.getByRole('tab', { name: /整理笔记/ }).click();
  await expect(page.getByLabel('Markdown 正文', { exact: true })).toHaveValue(prose);
});

test('a failed recognition preserves ink; explicit retry reuses the same idempotency key', async ({ page }) => {
  const requests: Record<string, unknown>[] = [];
  await page.route('**/v1/recognize', async route => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) {
      await route.fulfill({ status: 503, json: { status: 'error', simulated: true, provider: 'mock', error: { code: 'PROVIDER_UNAVAILABLE', message: '测试：服务暂时不可用，原稿已保留。', retryable: true } } });
    } else {
      await route.fulfill({ status: 200, json: { status: 'ok', simulated: true, provider: 'mock', latex: 'x^2', sourceRevision: requests[0].sourceRevision } });
    }
  });
  await writeAndSelect(page, false);
  await page.getByRole('button', { name: '识别圈选公式', exact: true }).click();
  await page.getByRole('button', { name: '同意并识别', exact: true }).click();
  await expect(page.locator('#service-status')).toContainText('服务暂时不可用');
  await expect(page.getByRole('button', { name: '确认并整理', exact: true })).toBeDisabled();
  await expect(page.locator('#stroke-count')).toHaveText('2 笔');
  expect(requests).toHaveLength(1);
  await page.getByRole('button', { name: '重试当前选区', exact: true }).click();
  await expect(page.locator('#latex-input')).toHaveValue('x^2');
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('#formula-count')).toHaveText('0 公式');
  await expect(page.locator('#stroke-count')).toHaveText('2 笔');
});

test('changing source during recognition displays an old-source warning, preserves the result and marks the confirmed formula stale', async ({ page }) => {
  let release: (() => void) | undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  await page.route('**/v1/recognize', async route => {
    entered = true;
    const payload = route.request().postDataJSON();
    await held;
    await route.fulfill({ status: 200, json: { status: 'ok', simulated: true, provider: 'mock', latex: 'x^2', sourceRevision: payload.sourceRevision } });
  });
  await writeAndSelect(page, false);
  await page.getByRole('button', { name: '识别圈选公式', exact: true }).click();
  await page.getByRole('button', { name: '同意并识别', exact: true }).click();
  await expect.poll(() => entered).toBe(true);
  await page.getByRole('button', { name: '钢笔', exact: true }).click();
  await canvasPath(page, [[250, 265], [300, 285]]);
  await expect(page.locator('#stroke-count')).toHaveText('3 笔');
  release!();
  await expect(page.locator('#recognition-warning')).toContainText('原稿在识别期间已变化');
  await page.getByRole('button', { name: '确认并整理', exact: true }).click();
  await expect(page.locator('#confirmed-list')).toContainText('原稿已变化');
  await expect.poll(async () => (await readNotes(page))[0].formulas.length).toBe(1);
  const saved = (await readNotes(page))[0];
  expect(saved.revision).toBe(3);
  expect(saved.formulas[0].sourceRevision).toBe(2);
  expect(saved.formulas[0].latex).toBe('x^2');
  expect(saved.strokes).toHaveLength(3);
});

test('tablet viewport keeps the handwriting and recognition controls reachable', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 820, height: 1180 });
  await writeAndSelect(page, false);
  await expect(page.getByRole('button', { name: '识别圈选公式', exact: true })).toBeVisible();
  const width = await page.evaluate(() => ({ inner: innerWidth, content: document.documentElement.scrollWidth }));
  expect(width.content).toBeLessThanOrEqual(width.inner + 1);
  await capture(page, testInfo, 'tablet-handwriting');
});

test('phone controls remain accessible; exported backup restores editable strokes without overwriting the original', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '打开识别与设备设置', exact: true }).click();
  await expect(page.locator('#settings-dialog')).toBeVisible();
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await page.getByLabel('笔记标题', { exact: true }).fill('手机备份实验');
  await writeAndSelect(page, false);
  await expect.poll(async () => (await readNotes(page))[0].strokes.length).toBe(2);
  const original = (await readNotes(page))[0];
  await page.getByRole('button', { name: '导出', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '所有笔记 · 完整 JSON', exact: true }).click();
  const download = await downloadPromise;
  const path = await download.path();
  if (!path) throw new Error('Backup file was not downloaded');
  const buffer = readFileSync(path);
  const backup = JSON.parse(buffer.toString('utf8'));
  expect(backup.format).toBe('math-ink');
  expect(backup.notes[0].strokes).toEqual(original.strokes);
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '恢复已有 JSON 备份', exact: true }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name: 'mathink-backup.json', mimeType: 'application/json', buffer });
  await expect(page.locator('#toast')).toContainText('已恢复 1 篇笔记，现有笔记已保留');
  await expect(page.getByLabel('笔记标题', { exact: true })).toHaveValue('手机备份实验（恢复副本）');
  await expect(page.locator('#stroke-count')).toHaveText('2 笔');
  await expect.poll(async () => (await readNotes(page)).length).toBe(2);
  const notes = await readNotes(page);
  expect(notes.find(note => note.id === original.id)).toEqual(original);
  expect(notes.find(note => note.id !== original.id)?.strokes).toEqual(original.strokes);
  await page.getByRole('button', { name: '钢笔', exact: true }).click();
  await canvasPath(page, [[200, 270], [250, 295]]);
  await expect(page.locator('#stroke-count')).toHaveText('3 笔');
  const widths = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: innerWidth }));
  expect(widths.content).toBeLessThanOrEqual(widths.viewport + 1);
  await capture(page, testInfo, 'phone-backup-and-ink');
});
