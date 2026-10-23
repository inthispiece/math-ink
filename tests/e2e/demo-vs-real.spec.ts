import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { Note } from '../../apps/web/src/model';
import { installReadyOcrMetadata, readyOcrStatus } from './fixtures/ocr-state';

async function openNotebook(page: Page) {
  await page.goto('/');
  await expect(page.locator('#save-state')).toHaveText('已保存到本机');
}

async function notes(page: Page): Promise<Note[]> {
  return page.evaluate(() => new Promise<Note[]>((done, reject) => {
    const request = indexedDB.open('math-ink-notebooks', 1);
    request.onerror = () => reject(new Error('Unable to open saved notebook'));
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('notes', 'readonly');
      const read = transaction.objectStore('notes').getAll();
      read.onsuccess = () => done(read.result);
      read.onerror = () => reject(new Error('Unable to read saved notebook'));
      transaction.oncomplete = () => database.close();
    };
  }));
}

async function writeAndSelect(page: Page) {
  const canvas = page.locator('#ink-canvas');
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('The handwriting canvas is not visible');
  await page.mouse.move(box.x + 90, box.y + 130);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + 190, { steps: 10 });
  await page.mouse.up();
  await page.getByRole('button', { name: '全选笔迹', exact: true }).click();
  await expect(page.locator('#selection-label')).toHaveText('已圈选 1 笔');
  await expect.poll(async () => (await notes(page))[0].strokes.length).toBe(1);
}

function countOcrPosts(page: Page) {
  const calls: unknown[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/v1/recognize' && request.method() === 'POST') calls.push(request.postDataJSON());
  });
  return calls;
}

async function consent(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('math-ink-settings') || '{}').cloudConsent);
}

test('the demo gateway never supplies its fixed integral through the real-recognition button', async ({ page }) => {
  const calls = countOcrPosts(page);
  await openNotebook(page);
  await writeAndSelect(page);
  const source = (await notes(page))[0].strokes;
  await page.locator('#recognize').click();
  await expect(page.locator('#settings-dialog')).toBeVisible();
  await expect(page.locator('#service-status')).toContainText(/真实识别|演示|配置/);
  await expect(page.locator('#recognition-mode')).toContainText(/演示|未配置/);
  await expect(page.locator('#consent-dialog')).not.toBeVisible();
  expect(await consent(page)).toBe(false);
  expect(calls).toHaveLength(0);
  await expect(page.locator('#latex-input')).toHaveValue('');
  expect((await notes(page))[0].strokes).toEqual(source);
  expect((await notes(page))[0].formulas).toHaveLength(0);
});

test('the explicit local sample works offline with zero real quota, asks for no upload consent and stays visibly marked as a demo', async ({ page, context }) => {
  await installReadyOcrMetadata(page, 0);
  const calls = countOcrPosts(page);
  await openNotebook(page);
  await writeAndSelect(page);
  await expect(page.locator('#quota-summary')).toContainText('0');
  const summary = await page.locator('#quota-summary').textContent();
  const source = (await notes(page))[0].strokes;
  await expect(page.getByRole('button', { name: '查看固定样例演示', exact: true })).toBeVisible();
  await context.setOffline(true);
  await page.getByRole('button', { name: '查看固定样例演示', exact: true }).click();
  await expect(page.locator('#provider-badge')).toHaveText('本地演示 · 固定样例，未读取笔迹');
  await expect(page.locator('#latex-input')).toHaveValue(/\\int/);
  await expect(page.locator('#consent-dialog')).not.toBeVisible();
  expect(await consent(page)).toBe(false);
  expect(calls).toHaveLength(0);
  await page.locator('#confirm-formula').click();
  await expect(page.locator('#formula-count')).toHaveText('1 公式');
  await expect(page.locator('#confirmed-list')).toContainText(/演示|模拟/);
  await expect.poll(async () => (await notes(page))[0].formulas.length).toBe(1);
  const saved = (await notes(page))[0];
  expect(saved.formulas[0].simulated).toBe(true);
  expect(saved.strokes).toEqual(source);
  expect(await page.locator('#quota-summary').textContent()).toBe(summary);
  expect(calls).toHaveLength(0);
});

test('provider and remaining real-service quota are visible both in the notebook and settings', async ({ page }) => {
  await installReadyOcrMetadata(page, 8);
  await openNotebook(page);
  await expect(page.locator('#recognition-mode')).toContainText(/mathpix/i);
  await expect(page.locator('#quota-summary')).toContainText('8');
  await page.getByRole('button', { name: '识别与设备设置', exact: true }).click();
  await page.getByRole('button', { name: '检查服务连接', exact: true }).click();
  await expect(page.locator('#service-details')).toContainText(/mathpix/i);
  await expect(page.locator('#service-details')).toContainText('8');
  await expect(page.locator('#service-details')).toContainText('10');
  await expect(page.locator('#service-details')).toContainText(/本地|自有服务|服务端|本服务/);
  await expect(page.locator('#service-details')).toContainText('不代表 Mathpix 账户余额');
  await expect(page.locator('#service-details')).toContainText('每月额度重置');
});

test('Mathpix without credentials stops before consent or image upload and retains editable ink', async ({ page }) => {
  await page.route('**/v1/status', route => route.fulfill({ json: readyOcrStatus(false) }));
  const calls = countOcrPosts(page);
  await openNotebook(page);
  await writeAndSelect(page);
  const source = (await notes(page))[0].strokes;
  await page.locator('#recognize').click();
  await expect(page.locator('#settings-dialog')).toBeVisible();
  await expect(page.locator('#service-status')).toContainText(/凭据|尚未配置|配置/);
  await expect(page.locator('#consent-dialog')).not.toBeVisible();
  expect(await consent(page)).toBe(false);
  expect(calls).toHaveLength(0);
  expect((await notes(page))[0].strokes).toEqual(source);
});

test('a server that incorrectly returns a simulated success cannot populate the real OCR result', async ({ page }) => {
  await installReadyOcrMetadata(page);
  await page.route('**/v1/recognize', route => route.fulfill({ json: { status: 'ok', provider: 'mock', simulated: true, latex: '\\int_0^1 x^2\\,dx=\\frac{1}{3}', sourceRevision: route.request().postDataJSON().sourceRevision } }));
  const calls = countOcrPosts(page);
  await openNotebook(page);
  await writeAndSelect(page);
  await page.locator('#recognize').click();
  await page.getByRole('button', { name: '同意并识别', exact: true }).click();
  await expect(page.locator('#math-preview')).toContainText('识别失败');
  await expect(page.locator('#latex-input')).toHaveValue('');
  await expect(page.locator('#confirm-formula')).toBeDisabled();
  expect(calls).toHaveLength(1);
  await expect(page.locator('#stroke-count')).toHaveText('1 笔');
});

test('an exhausted real quota keeps the source and still permits an explicit local sample without another OCR request', async ({ page }) => {
  await installReadyOcrMetadata(page, 0);
  await page.route('**/v1/recognize', route => route.fulfill({ status: 429, json: { status: 'error', provider: 'mathpix', simulated: false, error: { code: 'QUOTA_EXCEEDED', message: '今日真实识别额度已用完，请稍后再试。', retryable: false } } }));
  const calls = countOcrPosts(page);
  await openNotebook(page);
  await writeAndSelect(page);
  const source = (await notes(page))[0].strokes;
  await page.locator('#recognize').click();
  await page.getByRole('button', { name: '同意并识别', exact: true }).click();
  await expect(page.locator('#math-preview')).toContainText('额度已用完');
  await expect(page.locator('#math-preview')).toContainText('原稿已保留');
  await expect(page.locator('#quota-summary')).toContainText('0');
  expect(calls).toHaveLength(1);
  await page.getByRole('button', { name: '查看固定样例演示', exact: true }).click();
  await expect(page.locator('#provider-badge')).toHaveText('本地演示 · 固定样例，未读取笔迹');
  expect(calls).toHaveLength(1);
  expect((await notes(page))[0].strokes).toEqual(source);
});

test('reviewRequired warns even without a confidence score or with 0.99, and preserves indefinite-integral and Holder candidates verbatim', async ({ page }) => {
  await installReadyOcrMetadata(page);
  const candidates = [
    { latex: '\\int x^2\\,dx' },
    { latex: '\\|fg\\|_1\\leq\\|f\\|_p\\|g\\|_q', confidence: 0.99 },
  ];
  let calls = 0;
  await page.route('**/v1/recognize', route => {
    const candidate = candidates[calls++];
    if (!candidate) throw new Error('The review flow submitted an unexpected extra request');
    return route.fulfill({ json: { status: 'ok', provider: 'mathpix', simulated: false, ...candidate, reviewRequired: true, sourceRevision: route.request().postDataJSON().sourceRevision } });
  });
  await openNotebook(page);
  await writeAndSelect(page);
  const source = (await notes(page))[0].strokes;
  for (const [index, candidate] of candidates.entries()) {
    await page.locator('#recognize').click();
    if (index === 0) await page.getByRole('button', { name: '同意并识别', exact: true }).click();
    await expect(page.locator('#latex-input')).toHaveValue(candidate.latex);
    await expect(page.locator('#recognition-warning')).toBeVisible();
    await expect(page.locator('#recognition-warning')).toContainText('低置信度');
    await expect(page.locator('#recognition-warning')).toContainText('对照原稿');
    await page.locator('#confirm-formula').click();
    await expect(page.locator('#formula-count')).toHaveText(`${index + 1} 公式`);
    await expect.poll(async () => (await notes(page))[0].formulas.length).toBe(index + 1);
  }
  const saved = (await notes(page))[0];
  expect(saved.formulas.map(formula => formula.latex)).toEqual(candidates.map(candidate => candidate.latex));
  expect(saved.strokes).toEqual(source);
  expect(calls).toBe(2);
});
