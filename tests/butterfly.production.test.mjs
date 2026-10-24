import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, stat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { unzipSync, zipSync } from 'fflate';
import { chromium } from '@playwright/test';

function unpackDocument(document) {
  const files = unzipSync(new Uint8Array(document.data));
  const path = `BFLY/pages/${document.page}.json`;
  assert.ok(files[path], `Missing saved page ${path}`);
  const page = JSON.parse(Buffer.from(files[path]).toString('utf8'));
  const elements = (page.layers || []).flatMap(layer => layer.content || []);
  return { files, path, page, elements, pens: elements.filter(element => element.type === 'pen') };
}

async function bridge(page, method, payload = {}) {
  return page.evaluate(({ method, payload }) => new Promise((resolve, reject) => {
    const frame = document.getElementById('butterfly-frame');
    const requestId = `test-butterfly-${crypto.randomUUID()}`;
    const timeout = setTimeout(() => { window.removeEventListener('message', receive); reject(new Error(`Butterfly bridge timeout: ${method}`)); }, 20000);
    function receive(event) {
      if (event.origin !== location.origin || event.source !== frame.contentWindow || event.data?.type !== 'mathink' || event.data.message?.requestId !== requestId) return;
      clearTimeout(timeout); window.removeEventListener('message', receive);
      if (event.data.message.ok) resolve(event.data.message.result);
      else reject(new Error(event.data.message.error || 'Butterfly bridge failed'));
    }
    window.addEventListener('message', receive);
    frame.contentWindow.postMessage({ type: 'mathink', message: { requestId, method, payload } }, location.origin);
  }), { method, payload });
}

async function poll(check, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let result;
  while (Date.now() < deadline) {
    result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out: ${description}`);
}

async function framePath(page, points) {
  const frame = page.locator('#butterfly-frame');
  await frame.scrollIntoViewIfNeeded();
  const box = await frame.boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + points[0][0], box.y + points[0][1]);
  await page.mouse.down();
  for (const [x, y] of points.slice(1)) await page.mouse.move(box.x + x, box.y + y, { steps: 12 });
  await page.mouse.up();
}

async function chooseFrameTool(page, tool) {
  // Real Flutter toolbar coordinates in the fixed 1500px desktop viewport.
  // Browser-native Ctrl+digit shortcuts do not reliably reach the embedded editor.
  const frame = page.locator('#butterfly-frame');
  const box = await frame.boundingBox();
  assert.ok(box);
  await frame.click({ position: { x: box.width - (tool === 'pen' ? 376 : 440), y: 40 } });
}

async function savedNotes(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('math-ink-notebooks');
    open.onerror = () => reject(new Error('Unable to open saved notes'));
    open.onsuccess = () => {
      const database = open.result;
      const transaction = database.transaction('notes', 'readonly');
      const request = transaction.objectStore('notes').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Unable to read saved notes'));
      transaction.oncomplete = () => database.close();
    };
  }));
}

test('real bundled Butterfly: pointer ink, selected PNG, math/source linkage, document restoration and offline reopen', { timeout: 240000 }, async t => {
  // A build must supply real Flutter output. This test never creates a manifest or substitutes a fake iframe.
  const manifest = JSON.parse(await readFile('apps/web/public/vendor/butterfly/manifest.json', 'utf8'));
  assert.equal(manifest.mathInkBridge, 1);
  assert.equal(manifest.version, '2.6.0');
  const servedManifest = JSON.parse(await readFile('dist/web/vendor/butterfly/manifest.json', 'utf8'));
  assert.deepEqual(servedManifest, manifest);
  assert.ok((await stat('dist/web/vendor/butterfly/main.dart.js')).size > 1_000_000);
  const temporary = await mkdtemp(join(tmpdir(), 'mathink-butterfly-preview-'));
  const port = Number(process.env.BUTTERFLY_TEST_PORT || 8791);
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['scripts/serve-preview.mjs'], {
    cwd: resolve('.'),
    env: { ...process.env, OCR_PROVIDER: 'mock', GATEWAY_HOST: '127.0.0.1', GATEWAY_PORT: String(port), GATEWAY_PAIRING_TOKEN: '', GATEWAY_DATABASE_PATH: join(temporary, 'quota.sqlite') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  server.stdout.on('data', chunk => serverOutput += chunk);
  server.stderr.on('data', chunk => serverOutput += chunk);
  let browser;
  let activePage;
  let complete = false;
  t.after(async () => {
    if (!complete && activePage && !activePage.isClosed()) {
      await mkdir('artifacts', { recursive: true });
      await activePage.screenshot({ path: resolve('artifacts/butterfly-test-failure.png'), fullPage: true }).catch(() => {});
    }
    await browser?.close();
    if (server.exitCode === null) { const exited = once(server, 'exit'); server.kill(); await exited; }
    const checked = resolve(temporary);
    assert.ok(checked.startsWith(resolve(tmpdir()) + sep) && checked.includes('mathink-butterfly-preview-'));
    await rm(checked, { recursive: true, force: true });
  });
  await poll(async () => {
    if (server.exitCode !== null) throw new Error(`Preview stopped: ${serverOutput}`);
    try { return (await fetch(base + '/health')).ok; } catch { return false; }
  }, 'localhost preview server');
  browser = await chromium.launch({ channel: 'msedge', headless: true,
    args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'] });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
  const remoteAttempts = [];
  const remoteRequests = [];
  const failedResponses = [];
  let recognitionPosts = 0;
  context.on('response', response => {
    if (response.status() >= 400) failedResponses.push({ status: response.status(), url: response.url() });
  });
  context.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/v1/recognize' && request.method() === 'POST') recognitionPosts++;
    if (['http:', 'https:'].includes(url.protocol) && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) remoteRequests.push(url.href);
  });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (['http:', 'https:'].includes(url.protocol) && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      remoteAttempts.push(url.href); return route.abort();
    }
    return route.continue();
  });
  const page = await context.newPage();
  activePage = page;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') console.log(`Browser: ${message.location().url || '(no source URL)'} ${message.text().slice(0, 500)}`); });
  await page.addInitScript(() => {
    window.__butterflyReadyCount = 0;
    window.addEventListener('message', event => {
      const frame = document.getElementById('butterfly-frame');
      if (event.origin === location.origin && event.source === frame?.contentWindow && event.data?.type === 'mathinkReady') window.__butterflyReadyCount++;
    });
  });
  await page.goto(base);
  await page.waitForFunction(() => document.getElementById('save-state')?.textContent === '已保存到本机');
  await page.getByLabel('笔记标题', { exact: true }).fill('真实 Butterfly 手写验证');
  // Keep one real experimental-canvas stroke to verify mode switching restores its actual count.
  const experimentalCanvas = page.locator('#ink-canvas');
  await experimentalCanvas.scrollIntoViewIfNeeded();
  const experimentalBox = await experimentalCanvas.boundingBox();
  assert.ok(experimentalBox);
  await page.mouse.move(experimentalBox.x + 120, experimentalBox.y + 150);
  await page.mouse.down();
  await page.mouse.move(experimentalBox.x + 180, experimentalBox.y + 180, { steps: 12 });
  await page.mouse.up();
  await page.waitForFunction(() => document.getElementById('stroke-count')?.textContent === '1 笔');
  await page.getByRole('button', { name: '识别与设备设置', exact: true }).click();
  await page.locator('#ink-mode').selectOption('butterfly');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  try {
    await page.waitForFunction(() => document.getElementById('butterfly-status')?.textContent?.includes('原稿已恢复'), undefined, { timeout: 60000 });
  } catch (error) {
    console.log(`Butterfly status: ${await page.locator('#butterfly-status').textContent()}`);
    console.log(`External resource attempts: ${JSON.stringify({ blocked: remoteAttempts, observed: remoteRequests })}`);
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: resolve('artifacts/butterfly-load-failure.png'), fullPage: true });
    throw error;
  }
  assert.match(await page.locator('#butterfly-frame').getAttribute('src'), /^\/vendor\/butterfly\/index\.html#/);
  assert.equal(await page.locator('.toolbar').isVisible(), false);
  assert.equal(await page.locator('#select-all').isVisible(), false);
  assert.equal(await page.locator('.paper-footer').isVisible(), false);
  assert.equal(await page.locator('#stroke-count').textContent(), 'Butterfly');
  assert.ok(await page.evaluate(() => window.__butterflyReadyCount) >= 1);
  const original = await bridge(page, 'getDocument');
  assert.match(original.revision, /^[a-f0-9]{64}$/);
  assert.equal(unpackDocument(original).pens.length, 0);
  await assert.rejects(bridge(page, 'getSelectedInk'), /EMPTY_SELECTION/);
  await assert.rejects(bridge(page, 'unsupportedTestMethod'), /UNKNOWN_METHOD/);

  // Actual browser mouse input enters Flutter's PenHandler. ZIP checks prove new editable pen elements.
  await chooseFrameTool(page, 'pen');
  await framePath(page, [[150, 180], [180, 150], [210, 180]]);
  await poll(async () => { const document = await bridge(page, 'getDocument'); return unpackDocument(document).pens.length === 1 ? document : false; }, 'first real pen stroke');
  await framePath(page, [[380, 180], [410, 190], [440, 220]]);
  const handwritten = await poll(async () => { const document = await bridge(page, 'getDocument'); return unpackDocument(document).pens.length === 2 ? document : false; }, 'second real pen stroke');
  const sourcePens = unpackDocument(handwritten).pens;
  assert.ok(sourcePens.every(pen => pen.points.length > 2));
  await poll(async () => {
    const note = (await savedNotes(page))[0];
    if (!note?.butterflyData?.length) return false;
    const persisted = unpackDocument({ data: note.butterflyData, page: note.butterflyPage });
    return JSON.stringify(persisted.pens) === JSON.stringify(sourcePens);
  }, 'actual handwriting automatically persisted before recognition');
  await chooseFrameTool(page, 'lasso');
  await framePath(page, [[120, 120], [250, 120], [250, 240], [120, 240], [120, 120]]);
  const selected = await bridge(page, 'getSelectedInk');
  assert.deepEqual(selected.strokeIds, [sourcePens[0].id]);
  const crop = await bridge(page, 'renderSelectedInk', { strokeIds: selected.strokeIds, revision: selected.revision });
  assert.deepEqual(crop.strokeIds, selected.strokeIds);
  const wholePage = await bridge(page, 'renderPage');
  assert.deepEqual(new Set(wholePage.strokeIds), new Set(sourcePens.map(pen => pen.id)));
  assert.equal(wholePage.page, selected.page);
  assert.equal(wholePage.inkRevision, selected.revision);
  assert.equal(wholePage.revision, handwritten.pageRevision);
  assert.ok(wholePage.bounds.width >= selected.bounds.width && wholePage.bounds.height >= selected.bounds.height);
  assert.ok(wholePage.transform.scaleX > 0 && wholePage.transform.scaleY > 0);
  await assert.rejects(bridge(page, 'renderPage', { page: 'missing-page' }), /SOURCE_PAGE_CHANGED/);
  const png = Buffer.from(crop.pngBase64, 'base64');
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.ok(png.readUInt32BE(16) > 0 && png.readUInt32BE(16) <= 2048);
  await assert.rejects(bridge(page, 'renderSelectedInk', { strokeIds: selected.strokeIds, revision: '0'.repeat(64) }), /STALE_SELECTION/);
  await assert.rejects(bridge(page, 'renderSelectedInk', { strokeIds: ['nonexistent-stroke'], revision: selected.revision }), /STALE_SELECTION/);

  // Explicit local demonstration uses real selected ink/bridge but never submits OCR or asks for upload consent.
  await page.getByRole('button', { name: '查看固定样例演示', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('provider-badge')?.textContent === '本地演示 · 固定样例，未读取笔迹');
  assert.equal(await page.locator('#consent-dialog').isVisible(), false);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('math-ink-settings')).cloudConsent), false);
  assert.equal(recognitionPosts, 0);
  const latex = 'x^2+y^2=1';
  await page.getByLabel('LaTeX · 可直接修改', { exact: true }).fill(latex);
  await page.getByRole('button', { name: '确认并整理', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('formula-count')?.textContent === '1 公式');
  assert.equal((await savedNotes(page))[0].formulas[0].simulated, true);
  const withMath = await bridge(page, 'getDocument');
  const parsed = unpackDocument(withMath);
  assert.deepEqual(parsed.pens, sourcePens);
  const math = parsed.elements.find(element => element.type === 'markdown' && element.extra?.mathink?.latex === latex);
  assert.ok(math, 'insertMath should create an editable Markdown math element');
  assert.equal(math.text, `$${latex}$`);
  assert.deepEqual(math.extra.mathink.strokeIds, selected.strokeIds);
  assert.equal(math.extra.mathink.page, selected.page);
  assert.equal(withMath.revision, handwritten.revision); // Added layout math does not modify source handwriting.
  await page.getByRole('tab', { name: /整理笔记/ }).click();
  await page.locator('#organized-formulas').getByRole('button', { name: '返回原稿', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('toast')?.textContent === '已定位来源页与原笔迹');
  assert.deepEqual((await bridge(page, 'getSelectedInk')).strokeIds, selected.strokeIds);

  // Explicit API-model fixture: overlapping red ink tests isolation, not handwriting recognition quality.
  const fixture = unpackDocument(withMath);
  const pen = (id, color, points) => ({ type: 'pen', id, points: points.map(([x, y]) => ({ x, y, pressure: 1 })), property: { type: 'pen', strokeWidth: 8, thinning: 0, paint: { type: 'solid', color } } });
  fixture.page.layers = [{ id: 'fixture-layer', name: 'API fixture: overlapping ink', content: [
    pen('fixture-black', 0xff000000, [[0, 30], [50, 0], [100, 30]]),
    pen('fixture-red', 0xffff0000, [[50, -10], [50, 50]]),
  ] }];
  fixture.files[fixture.path] = new Uint8Array(Buffer.from(JSON.stringify(fixture.page)));
  const fixtureBytes = Array.from(zipSync(fixture.files));
  let readyCount = await page.evaluate(() => window.__butterflyReadyCount);
  assert.equal((await bridge(page, 'setDocument', { data: fixtureBytes })).accepted, true);
  await page.waitForFunction(previous => window.__butterflyReadyCount > previous, readyCount);
  const fixtureDocument = await bridge(page, 'getDocument');
  assert.equal(unpackDocument(fixtureDocument).pens.length, 2);
  const fixtureSelection = await bridge(page, 'getSelectedInk', { strokeIds: ['fixture-black'], revision: fixtureDocument.revision });
  const isolated = await bridge(page, 'renderSelectedInk', { strokeIds: fixtureSelection.strokeIds, revision: fixtureSelection.revision });
  const pixels = await page.evaluate(async pngBase64 => {
    const image = new Image(); image.src = `data:image/png;base64,${pngBase64}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let red = 0, ink = 0;
    for (let index = 0; index < data.length; index += 4) if (data[index + 3] > 100) {
      if (data[index] > 150 && data[index + 1] < 100 && data[index + 2] < 100) red++;
      if (data[index] < 100 && data[index + 1] < 100 && data[index + 2] < 100) ink++;
    }
    return { red, ink };
  }, isolated.pngBase64);
  assert.equal(pixels.red, 0, 'Unselected overlapping red pen must not appear in PNG');
  assert.ok(pixels.ink > 20, 'Selected pen must be visible in PNG');

  // Restore actual pointer-created document, save it through the host, then reopen with network disabled.
  readyCount = await page.evaluate(() => window.__butterflyReadyCount);
  await bridge(page, 'setDocument', { data: withMath.data });
  await page.waitForFunction(previous => window.__butterflyReadyCount > previous, readyCount);
  assert.deepEqual(unpackDocument(await bridge(page, 'getDocument')).pens, sourcePens);
  await bridge(page, 'locateInk', { page: selected.page, strokeIds: selected.strokeIds, bounds: selected.bounds });
  await poll(async () => {
    const note = (await savedNotes(page))[0];
    if (!note.butterflyData) return false;
    const document = { data: note.butterflyData, page: note.butterflyPage };
    return unpackDocument(document).pens.every(pen => sourcePens.some(source => source.id === pen.id)) && unpackDocument(document).elements.some(element => element.id === math.id);
  }, 'host saving actual .bfly bytes');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  assert.deepEqual(remoteAttempts, [], 'Butterfly must not need remote engines or fonts');
  assert.deepEqual(remoteRequests, [], 'Service-worker requests must not need remote engines or fonts');
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: resolve('artifacts/butterfly-real-integrated.png'), fullPage: true });
  await context.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => document.getElementById('butterfly-status')?.textContent?.includes('原稿已恢复'), undefined, { timeout: 60000 });
  const offline = await poll(async () => {
    const document = await bridge(page, 'getDocument');
    const parsed = unpackDocument(document);
    return parsed.pens.length === 2 && parsed.elements.some(element => element.id === math.id) ? document : false;
  }, 'offline Butterfly original document restored');
  assert.deepEqual(unpackDocument(offline).pens, sourcePens);
  assert.equal(await page.locator('.toolbar').isVisible(), false);
  assert.equal(await page.locator('#select-all').isVisible(), false);
  assert.equal(await page.locator('.paper-footer').isVisible(), false);
  assert.equal(await page.locator('#stroke-count').textContent(), 'Butterfly');
  await page.screenshot({ path: resolve('artifacts/butterfly-offline-restored.png'), fullPage: true });
  await page.getByRole('button', { name: '识别与设备设置', exact: true }).click();
  await page.locator('#ink-mode').selectOption('experimental');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('butterfly-panel')?.hidden === true && document.getElementById('stroke-count')?.textContent === '1 笔');
  assert.equal(await page.locator('.toolbar').isVisible(), true);
  assert.equal(await page.locator('#select-all').isVisible(), true);
  assert.equal(await page.locator('.paper-footer').isVisible(), true);
  assert.equal((await savedNotes(page))[0].strokes.length, 1);
  assert.equal(recognitionPosts, 0, 'Local demonstrations must not submit any OCR request');
  assert.deepEqual(errors, []);
  console.log(`本地失败响应：${JSON.stringify(failedResponses)}`);
  assert.deepEqual(failedResponses.filter(response => new URL(response.url).pathname !== '/favicon.ico'), [], 'Bundled editor assets should load successfully');
  complete = true;
  console.log('真实 Butterfly：pointer 实际写入、套索选择、仅选中 PNG、公式插入及原稿关联、.bfly 恢复、离线重开均通过；渲染隔离另用明确标注的 API fixture。');
});
