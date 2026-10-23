import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { quotaState } from './fixtures/ocr-state';

const original = '\\int x^2\\,dx';
const suggestion = '\\frac{x^3}{3}+C';
function metadata(provider: string) {
  return { status: 'ok', provider, simulated: false, configured: true, local: provider === 'ollama',
    capabilities: { transcribe: true, review: provider !== 'mathpix' }, requestTimeoutMs: provider === 'ollama' ? 180000 : 45000,
    providers: ['deepseek', 'ollama', 'mathpix'].map(id => ({ id, label: id, configured: true, local: id === 'ollama', model: id === 'ollama' ? 'qwen-fixture' : 'fixture', transcribe: true, review: id !== 'mathpix' })) };
}
async function ready(page: Page) {
  await page.route('**/v1/status**', route => route.fulfill({ json: metadata(new URL(route.request().url()).searchParams.get('provider') || 'deepseek') }));
  await page.route('**/v1/usage?**', route => {
    const provider = new URL(route.request().url()).searchParams.get('provider');
    const state = quotaState(); state.provider = provider || 'deepseek'; state.quota.enforced = provider !== 'ollama';
    return route.fulfill({ json: state });
  });
  await page.route('**/v1/provider-health?**', route => route.fulfill({ json: { status: 'ok', ready: true, provider: new URL(route.request().url()).searchParams.get('provider') } }));
  await page.route('**/v1/recognize', route => {
    const body = route.request().postDataJSON();
    return route.fulfill({ json: { status: 'ok', provider: body.provider, simulated: false, latex: original, sourceRevision: body.sourceRevision, uncertainSymbols: ['x'], reviewRequired: true } });
  });
  await page.route('**/v1/review', route => {
    const body = route.request().postDataJSON();
    return route.fulfill({ json: { status: 'ok', provider: body.provider, simulated: false, originalLatex: body.latex, review: { summary: '这是候选检查建议，请人工确认。', issues: ['不定积分应检查积分常数与适用条件。'], suggestedLatex: suggestion } } });
  });
}
async function open(page: Page) { await page.goto('/'); await expect(page.locator('#save-state')).toHaveText('已保存到本机'); }
async function choose(page: Page, provider: string) {
  await page.getByRole('button', { name: '识别与设备设置', exact: true }).click();
  await page.locator('#ocr-provider').selectOption(provider);
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
}
async function ink(page: Page) {
  const canvas = page.locator('#ink-canvas'); await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox(); if (!box) throw new Error('No canvas');
  await page.mouse.move(box.x + 90, box.y + 140); await page.mouse.down(); await page.mouse.move(box.x + 160, box.y + 190, { steps: 10 }); await page.mouse.up();
  await page.getByRole('button', { name: '全选笔迹', exact: true }).click();
  await expect(page.locator('#selection-label')).toHaveText('已圈选 1 笔');
}
async function transcribe(page: Page, local = false) {
  await ink(page); await page.locator('#recognize').click();
  if (!local) await page.getByRole('button', { name: '同意并转写', exact: true }).click();
  await expect(page.locator('#latex-input')).toHaveValue(original);
}
test.beforeEach(async ({ page }) => { await ready(page); });

test('new settings default to DeepSeek; provider selection and health checks use the selected backend without automatic generation', async ({ page }) => {
  let calls = 0; page.on('request', request => { if (/\/v1\/(recognize|review)$/.test(new URL(request.url()).pathname)) calls++; });
  await open(page);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('math-ink-settings')!).provider)).toBe('deepseek');
  await choose(page, 'ollama');
  await expect(page.locator('#recognition-mode')).toContainText('本地');
  await expect(page.locator('#quota-summary')).toContainText('不设云服务额度');
  await page.getByRole('button', { name: '识别与设备设置', exact: true }).click();
  await expect(page.locator('#ocr-provider option[value="ollama"]')).toContainText('实验');
  await expect(page.locator('#local-model-quality')).toBeVisible();
  await expect(page.locator('#local-model-quality')).toContainText('小模型实测复杂公式和数学检查可能失准，请逐项核对');
  const checked = page.waitForRequest(request => new URL(request.url()).pathname === '/v1/provider-health');
  await page.getByRole('button', { name: '检查服务连接', exact: true }).click();
  expect(new URL((await checked).url()).searchParams.get('provider')).toBe('ollama');
  await expect(page.locator('#service-status')).toContainText('后端连接检查通过');
  await page.route('**/v1/provider-health?**', route => route.fulfill({ json: { status: 'ok', ready: false, message: '本地模型尚未下载' } }));
  await page.getByRole('button', { name: '检查服务连接', exact: true }).click();
  await expect(page.locator('#service-status')).toHaveText('本地模型尚未下载');
  expect(calls).toBe(0);
});

test('legacy Mathpix image consent never silently authorizes DeepSeek', async ({ page }) => {
  await page.addInitScript(() => { if (window === window.top) localStorage.setItem('math-ink-settings', JSON.stringify({ cloudConsent: true })); });
  await open(page);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('math-ink-settings')!));
  expect(stored.provider).toBe('deepseek'); expect(stored.cloudConsentProviders).toEqual(['mathpix']); expect(stored.cloudConsent).toBe(false);
  await ink(page); await page.locator('#recognize').click();
  await expect(page.locator('#consent-dialog')).toBeVisible();
  await expect(page.locator('#transcription-consent-description')).toContainText('DeepSeek');
});

test('local Qwen transcribes and reviews without cloud permission while preserving the handwritten source', async ({ page }) => {
  const requests: Record<string, unknown>[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/v1/recognize') requests.push(request.postDataJSON()); });
  await open(page); await choose(page, 'ollama'); await transcribe(page, true);
  await expect(page.locator('#provider-badge')).toContainText('本地转写 · ollama');
  await expect(page.locator('#consent-dialog')).not.toBeVisible();
  expect(requests[0].provider).toBe('ollama');
  await page.locator('#review-formula').click();
  await expect(page.locator('#review-result')).toBeVisible();
  await expect(page.locator('#review-consent-dialog')).not.toBeVisible();
  await expect(page.locator('#latex-input')).toHaveValue(original);
  await expect(page.locator('#stroke-count')).toHaveText('1 笔');
});

test('cloud review sends only the explicit formula and conditions; adoption and note saving require separate actions', async ({ page }, testInfo) => {
  const reviews: Record<string, unknown>[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/v1/review') reviews.push(request.postDataJSON()); });
  await open(page); await page.getByLabel('笔记标题', { exact: true }).fill('PRIVATE_NOTE_TITLE'); await transcribe(page);
  await page.locator('#review-context').fill('x 是实数；只检查本次公式。');
  await page.locator('#review-formula').click();
  await expect(page.locator('#review-consent-dialog')).toBeVisible();
  await expect(page.locator('#review-consent-payload')).toContainText(original);
  expect(reviews).toHaveLength(0);
  await page.locator('#review-consent-allow').click();
  await expect(page.locator('#review-result')).toBeVisible();
  expect(reviews).toHaveLength(1); expect(reviews[0].provider).toBe('deepseek'); expect(reviews[0].latex).toBe(original);
  expect(reviews[0].context).toBe('x 是实数；只检查本次公式。'); expect(JSON.stringify(reviews[0])).not.toContain('PRIVATE_NOTE_TITLE');
  expect(reviews[0]).not.toHaveProperty('imageBase64');
  await expect(page.locator('#latex-input')).toHaveValue(original); await expect(page.locator('#formula-count')).toHaveText('0 公式');
  const path = testInfo.outputPath('cloud-review-before-adoption.png'); await page.screenshot({ path, fullPage: true, animations: 'disabled' }); await testInfo.attach('cloud-review-before-adoption', { path, contentType: 'image/png' });
  await page.locator('#apply-review').click(); await expect(page.locator('#latex-input')).toHaveValue(suggestion);
  await expect(page.locator('#formula-count')).toHaveText('0 公式');
  await page.locator('#confirm-formula').click(); await expect(page.locator('#formula-count')).toHaveText('1 公式');
});

test('failed local reviews preserve transcription and retry only when clicked, using a new request identity', async ({ page }) => {
  const bodies: Record<string, unknown>[] = [];
  await page.route('**/v1/review', route => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill(bodies.length === 1 ? { status: 503, json: { status: 'error', error: { message: '测试模型暂时不可用' } } } : { json: { status: 'ok', provider: 'ollama', simulated: false, originalLatex: bodies[0].latex, review: { summary: '人工核对', issues: [], suggestedLatex: null } } });
  });
  await open(page); await choose(page, 'ollama'); await transcribe(page, true);
  await page.locator('#review-formula').click(); await expect(page.locator('#review-status')).toContainText('测试模型暂时不可用');
  await expect(page.locator('#latex-input')).toHaveValue(original); expect(bodies).toHaveLength(1);
  await page.locator('#review-retry').click(); await expect(page.locator('#review-result')).toBeVisible();
  expect(bodies).toHaveLength(2); expect(bodies[1].clientRequestId).not.toBe(bodies[0].clientRequestId);
  expect({ ...bodies[1], clientRequestId: bodies[0].clientRequestId }).toEqual(bodies[0]); await expect(page.locator('#apply-review')).toBeDisabled();
});

test('editing the input or changing the provider cancels stale reviews and cannot apply their late suggestions', async ({ page }) => {
  const releases: (() => void)[] = []; let completed = 0;
  await page.route('**/v1/review', async route => {
    const body = route.request().postDataJSON(); await new Promise<void>(done => releases.push(done));
    await route.fulfill({ json: { status: 'ok', provider: body.provider, simulated: false, originalLatex: body.latex, review: { summary: 'OLD', issues: [], suggestedLatex: 'OLD_SUGGESTION' } } }); completed++;
  });
  await open(page); await choose(page, 'ollama'); await transcribe(page, true);
  await page.locator('#review-formula').click(); await expect.poll(() => releases.length).toBe(1);
  await page.locator('#latex-input').fill('y^2'); releases[0](); await expect.poll(() => completed).toBe(1);
  await expect(page.locator('#review-result')).not.toBeVisible(); await expect(page.locator('#latex-input')).toHaveValue('y^2');
  await page.locator('#review-formula').click(); await expect.poll(() => releases.length).toBe(2);
  await choose(page, 'deepseek'); releases[1](); await expect.poll(() => completed).toBe(2);
  await expect(page.locator('#review-result')).not.toBeVisible(); await expect(page.locator('#latex-input')).toHaveValue('y^2');
  await expect(page.locator('#stroke-count')).toHaveText('1 笔');
});

test('Ollama cold-start timeout follows the 180-second status budget and remains cancellable', async ({ page }) => {
  let release: (() => void) | undefined;
  await page.route('**/v1/recognize', async route => { await new Promise<void>(done => { release = done; }); await route.fulfill({ json: { status: 'ok', provider: 'ollama', simulated: false, latex: 'LATE' } }); });
  await open(page); await choose(page, 'ollama'); await ink(page); await page.clock.install(); await page.locator('#recognize').click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.clock.fastForward(184000); await expect(page.locator('#recognize')).toBeDisabled();
  await page.clock.fastForward(2000); await expect(page.locator('#math-preview')).toContainText('超时');
  await expect(page.locator('#latex-input')).toHaveValue(''); await expect(page.locator('#stroke-count')).toHaveText('1 笔');
  release!();
});

test('a failed cloud formula check requires an explicitly billable new request and separate text consent', async ({ page }) => {
  const bodies: Record<string, unknown>[] = [];
  await page.route('**/v1/review', route => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill(bodies.length === 1 ? { status: 503, json: { status: 'error', error: { message: '云服务暂时不可用' } } } : { json: { status: 'ok', provider: 'deepseek', simulated: false, originalLatex: bodies[0].latex, review: { summary: '已检查，请人工确认。', issues: [], suggestedLatex: null } } });
  });
  await open(page); await page.locator('#manual-formula').click(); await page.locator('#latex-input').fill(original);
  await page.locator('#review-formula').click(); await page.locator('#review-consent-allow').click();
  await expect(page.locator('#review-status')).toContainText('云服务暂时不可用');
  await expect(page.locator('#review-retry')).toContainText('可能再次计费');
  await page.waitForTimeout(500); expect(bodies).toHaveLength(1);
  await page.locator('#review-retry').click(); await expect(page.locator('#review-consent-dialog')).toBeVisible();
  expect(bodies).toHaveLength(1); await page.locator('#review-consent-allow').click();
  await expect(page.locator('#review-result')).toBeVisible(); expect(bodies).toHaveLength(2);
  expect(bodies[1].clientRequestId).not.toBe(bodies[0].clientRequestId); await expect(page.locator('#latex-input')).toHaveValue(original);
});

test('cancel or notebook switching invalidates pending review suggestions without overwriting transcription', async ({ page }) => {
  const releases: (() => void)[] = []; let completed = 0;
  await page.route('**/v1/review', async route => { const body = route.request().postDataJSON(); await new Promise<void>(done => releases.push(done)); await route.fulfill({ json: { status: 'ok', provider: body.provider, simulated: false, originalLatex: body.latex, review: { summary: 'OLD', issues: [], suggestedLatex: 'STALE' } } }); completed++; });
  await open(page); await choose(page, 'ollama'); await transcribe(page, true);
  await page.locator('#review-formula').click(); await expect.poll(() => releases.length).toBe(1);
  await page.locator('#review-cancel').click(); releases[0](); await expect.poll(() => completed).toBe(1);
  await expect(page.locator('#latex-input')).toHaveValue(original); await expect(page.locator('#review-result')).not.toBeVisible();
  await page.locator('#review-formula').click(); await expect.poll(() => releases.length).toBe(2);
  await page.getByRole('button', { name: '新建笔记', exact: false }).click(); releases[1](); await expect.poll(() => completed).toBe(2);
  await expect(page.locator('#review-result')).not.toBeVisible(); await expect(page.locator('#latex-input')).toHaveValue(''); await expect(page.locator('#formula-count')).toHaveText('0 公式');
});

test('review suggestions from another provider or without an explicit non-simulated marker are rejected', async ({ page }) => {
  let calls = 0;
  await page.route('**/v1/review', route => {
    const body = route.request().postDataJSON(); const index = calls++;
    return route.fulfill({ json: { status: 'ok', provider: index === 0 ? 'deepseek' : 'ollama', ...(index === 0 ? { simulated: false } : {}), originalLatex: body.latex, review: { summary: 'UNTRUSTED', issues: [], suggestedLatex: 'UNTRUSTED_SUGGESTION' } } });
  });
  await open(page); await choose(page, 'ollama'); await transcribe(page, true);
  for (let index = 0; index < 2; index++) {
    await page.locator('#review-formula').click();
    await expect(page.locator('#review-status')).toContainText('检查结果无效');
    await expect(page.locator('#review-result')).not.toBeVisible(); await expect(page.locator('#apply-review')).toBeDisabled();
    await expect(page.locator('#latex-input')).toHaveValue(original);
  }
  expect(calls).toBe(2); await expect(page.locator('#formula-count')).toHaveText('0 公式');
});
