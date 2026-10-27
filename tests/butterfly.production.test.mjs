import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, stat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { unzipSync, zipSync } from 'fflate';
import { chromium } from '@playwright/test';
import { createBackup } from '../apps/web/src/model.ts';
import { ensureNotebook, addSnapshot, createDraft } from '../apps/web/src/notebook-domain.ts';
import { waitForLibrary, waitForSaved, createNotebook, openNotebook, waitForButterfly, isGenerationRequest } from './production-ui.mjs';

function unpackDocument(document) {
  const files = unzipSync(new Uint8Array(document.data));
  const rawName = document.pages?.find(page => page.id === document.page)?.name || document.nativeName || document.page;
  let path = `BFLY/pages/${rawName}.json`;
  if (!files[path]) path = Object.keys(files).find(name => name.startsWith('BFLY/pages/') && name.endsWith('.json') && JSON.parse(Buffer.from(files[name]).toString('utf8')).extra?.mathinkPage?.id === document.page) || path;
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
  // Native fullscreen uses the actual host toolbar instead of pixel shortcuts.
  if (tool === 'lasso') {
    await page.locator('#toolbox-open').click();
    await page.getByRole('button', { name: '识别公式', exact: true }).click();
    await page.locator('#selection-bar').waitFor({ state: 'visible' });
  } else await page.locator('#tool-' + tool).click();
}

async function savedNotes(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('math-ink-notebooks');
    open.onerror = () => reject(new Error('Unable to open saved notes'));
    open.onsuccess = () => {
      const database = open.result;
      if(database.version!==4){database.close();reject(new Error('Production Butterfly host did not upgrade notebook database to schema4'));return;}
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
    env: { ...process.env, OCR_PROVIDER: 'mock', GATEWAY_HOST: '127.0.0.1', GATEWAY_PORT: String(port), GATEWAY_PAIRING_TOKEN: '', GATEWAY_DATABASE_PATH: join(temporary, 'quota.sqlite'), DEEPSEEK_API_KEY: '', MATHPIX_APP_ID: '', MATHPIX_APP_KEY: '' },
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
    if (isGenerationRequest(request)) recognitionPosts++;
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
  page.on('pageerror', error => {errors.push(error.message);console.log('Browser page error: '+(error.stack||error.message));});
  page.on('console', message => { if (message.type() === 'error') console.log(`Browser: ${message.location().url || '(no source URL)'} ${message.text().slice(0, 500)}`); });
  await page.addInitScript(() => {
    window.__butterflyReadyCount = 0;
    window.addEventListener('message', event => {
      const frame = document.getElementById('butterfly-frame');
      if (event.origin === location.origin && event.source === frame?.contentWindow && event.data?.type === 'mathinkReady') window.__butterflyReadyCount++;
    });
  });
  await page.goto(base);
  await waitForLibrary(page);
  assert.deepEqual(await savedNotes(page), []);
  await createNotebook(page, '原有独立手写笔记');
  // Settings affect new notebooks; existing ink retains its original engine.
  const experimentalCanvas = page.locator('#ink-canvas');
  await experimentalCanvas.scrollIntoViewIfNeeded();
  const experimentalBox = await experimentalCanvas.boundingBox();
  assert.ok(experimentalBox);
  await page.mouse.move(experimentalBox.x + 120, experimentalBox.y + 150);
  await page.mouse.down();
  await page.mouse.move(experimentalBox.x + 180, experimentalBox.y + 180, { steps: 12 });
  await page.mouse.up();
  await waitForSaved(page);
  const experimentalNoteId = (await savedNotes(page))[0].id;
  assert.equal((await savedNotes(page))[0].strokes.length, 1);
  await page.locator('#editor-more').click();
  await page.getByRole('button', { name: '应用设置', exact: true }).click();
  await page.locator('#ink-mode').selectOption('butterfly');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  assert.equal(await experimentalCanvas.isVisible(), true);
  assert.equal((await savedNotes(page)).find(note => note.id === experimentalNoteId).inkEngine, 'experimental');
  await page.locator('#back-library').click();
  const title = '真实 Butterfly 手写验证';
  await createNotebook(page, title);
  try {
    await waitForButterfly(page);
  } catch (error) {
    console.log(`Butterfly status: ${await page.locator('#butterfly-status').textContent()}`);
    console.log(`External resource attempts: ${JSON.stringify({ blocked: remoteAttempts, observed: remoteRequests })}`);
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: resolve('artifacts/butterfly-load-failure.png'), fullPage: true });
    throw error;
  }
  assert.match(await page.locator('#butterfly-frame').getAttribute('src'), /^\/vendor\/butterfly\/index\.html#/);
  assert.match(await page.locator('#butterfly-frame').getAttribute('src'), /fullScreen=forced/);
  assert.equal(await page.locator('#experimental-canvas').isVisible(), false);
  assert.equal(await page.locator('.ink-toolbar').isVisible(), true);
  assert.equal(await page.locator('#select-all').isVisible(), false);
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
    const note = (await savedNotes(page)).find(note => note.title === title);
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
  await assert.rejects(bridge(page, 'renderPage', { page: 'missing-page' }), /SOURCE_PAGE_CHANGED|SOURCE_PAGE_MISSING/);
  const png = Buffer.from(crop.pngBase64, 'base64');
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.ok(png.readUInt32BE(16) > 0 && png.readUInt32BE(16) <= 2048);
  await assert.rejects(bridge(page, 'renderSelectedInk', { strokeIds: selected.strokeIds, revision: '0'.repeat(64) }), /STALE_SELECTION/);
  await assert.rejects(bridge(page, 'renderSelectedInk', { strokeIds: ['nonexistent-stroke'], revision: selected.revision }), /STALE_SELECTION/);

  // This is an explicitly hand-transcribed API fixture, never an OCR quality
  // claim. Import the actual selected PNG and source IDs through schema-4 UI.
  await page.locator('#selection-cancel').click();
  await page.locator('#back-library').click();
  await waitForLibrary(page);
  const manualNote = ensureNotebook((await savedNotes(page)).find(note => note.title === title));
  const sourcePage = manualNote.pages.find(row => row.id === manualNote.currentPageId);
  const snapshotId = addSnapshot(manualNote, 'data:image/png;base64,' + crop.pngBase64);
  const transcription = createDraft(manualNote, {
    type: 'formula', title: 'API fixture · 手工转写，未经 OCR', status: 'completed', version: 1,
    sourcePageId: sourcePage.id, sourceRevision: sourcePage.revision || 0,
    sourceNativeRevision: manualNote.butterflyContentRevisions[selected.page],
    snapshotIds: [snapshotId], latex: '\\int x^2\\,dx',
    source: { id: 'api_fixture_source', noteId: manualNote.id, pageId: sourcePage.id, nativePageId: selected.page,
      sourceRevision: manualNote.revision, nativeRevision: handwritten.pageRevision, nativeInkRevision: selected.revision,
      strokeIds: selected.strokeIds, bounds: selected.bounds, kind: 'ink' },
  });
  await page.locator('#restore-file').setInputFiles({ name: 'manual-source-fixture.mathink.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(createBackup([manualNote]))) });
  await page.locator('#import-conflict-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#import-conflict-apply').isDisabled(), true);
  const preservedBackup = page.waitForEvent('download'); await page.locator('#import-conflict-backup').click(); await preservedBackup;
  await page.locator('#import-conflict-confirm').check(); await page.locator('#import-conflict-apply').click();
  await page.locator('#import-conflict-dialog').waitFor({ state: 'hidden' });
  await openNotebook(page, title); await waitForButterfly(page);
  await page.locator('#drafts-open').click();
  await page.locator('[data-draft-id="' + transcription.id + '"]').click();
  await page.locator('#draft-detail-dialog').waitFor({ state: 'visible' });
  assert.equal((await savedNotes(page)).find(note => note.title === title).formulas.length, 0, 'A returned draft is not automatically formal content');
  assert.equal(await page.locator('#recognition-dialog').isVisible(), false);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('math-ink-settings')).cloudConsent), false);
  assert.equal(recognitionPosts, 0);
  const latex = 'x^2+y^2=1';
  await page.getByText('编辑公式', { exact: true }).click();
  await page.getByLabel('草稿 LaTeX', { exact: true }).fill(latex);
  await page.getByRole('button', { name: '插入当前页', exact: true }).click();
  await page.locator('#butterfly-placement').waitFor({ state: 'visible' });
  await page.locator('#butterfly-placement').click({ position: { x: 300, y: 350 } });
  await poll(async () => (await savedNotes(page)).find(note => note.title === title).placements?.length === 1, 'explicit host insertion of one independent native math object');
  const savedWithMath = (await savedNotes(page)).find(note => note.title === title);
  assert.equal(savedWithMath.formulas[0].provider, 'manual');
  assert.equal(savedWithMath.formulas[0].simulated, false);
  assert.deepEqual(savedWithMath.formulas[0].sourceStrokeIds, selected.strokeIds);
  assert.equal(savedWithMath.formulas[0].sourceButterflyRevision, selected.revision);
  assert.equal(savedWithMath.drafts[0].uses.length, 1);
  const withMath = await bridge(page, 'getDocument');
  const parsed = unpackDocument(withMath);
  assert.deepEqual(parsed.pens, sourcePens);
  const math = parsed.elements.find(element => element.type === 'markdown' && element.extra?.mathink?.latex === latex);
  assert.ok(math, 'insertMath should create an editable Markdown math element');
  assert.equal(math.text, `$${latex}$`);
  assert.equal(savedWithMath.placements[0].elementId, math.id);
  assert.equal(savedWithMath.drafts[0].source.nativePageId, selected.page);
  assert.equal(savedWithMath.resources[snapshotId].dataUrl, 'data:image/png;base64,' + crop.pngBase64);
  assert.equal(withMath.revision, handwritten.revision); // Added layout math does not modify source handwriting.
  await page.locator('#drafts-open').click();
  await page.locator('[data-draft-id="' + transcription.id + '"]').click();
  await page.locator('#draft-detail-dialog').getByRole('button', { name: '返回原稿', exact: true }).click();
  await page.locator('#draft-detail-dialog').waitFor({state:'hidden'});
  await poll(async () => {
    // The click starts asynchronous draft persistence/source navigation. An
    // empty selection before locateInk finishes is a pending state, not its
    // final result; every other bridge error must still fail this regression.
    let current;try{current=await bridge(page,'getSelectedInk');}catch(error){if(error.message==='EMPTY_SELECTION')return false;throw error;}
    return JSON.stringify(current.strokeIds) === JSON.stringify(selected.strokeIds);
  }, 'draft source navigation to original native ink');
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
    const note = (await savedNotes(page)).find(note => note.title === title);
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
  await waitForLibrary(page);
  assert.equal(await page.locator('#editor-view').isVisible(), false);
  await openNotebook(page, title);
  await waitForButterfly(page);
  const offline = await poll(async () => {
    const document = await bridge(page, 'getDocument');
    const parsed = unpackDocument(document);
    return parsed.pens.length === 2 && parsed.elements.some(element => element.id === math.id) ? document : false;
  }, 'offline Butterfly original document restored');
  assert.deepEqual(unpackDocument(offline).pens, sourcePens);
  assert.equal(await page.locator('#experimental-canvas').isVisible(), false);
  assert.equal(await page.locator('.ink-toolbar').isVisible(), true);
  assert.equal(await page.locator('#select-all').isVisible(), false);
  await page.screenshot({ path: resolve('artifacts/butterfly-offline-restored.png'), fullPage: true });
  const offlineNote = (await savedNotes(page)).find(note => note.title === title);
  assert.equal(offlineNote.drafts[0].source.nativePageId, selected.page);
  assert.equal(offlineNote.placements[0].elementId, math.id);
  await page.locator('#editor-more').click();
  await page.getByRole('button', { name: '应用设置', exact: true }).click();
  await page.locator('#ink-mode').selectOption('experimental');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  assert.equal(await page.locator('#butterfly-frame').isVisible(), true, 'Changing new-note defaults must preserve an existing native notebook');
  await page.locator('#back-library').click();
  await openNotebook(page, '原有独立手写笔记');
  assert.equal(await page.locator('#experimental-canvas').isVisible(), true);
  assert.equal(await page.locator('#butterfly-panel').isVisible(), false);
  assert.equal((await savedNotes(page)).find(note => note.id === experimentalNoteId).strokes.length, 1);
  assert.equal((await savedNotes(page)).find(note => note.id === experimentalNoteId).inkEngine, 'experimental');
  assert.equal(recognitionPosts, 0, 'Local writing, source fixtures and manual drafts must not submit any generation request');
  assert.deepEqual(errors, []);
  console.log(`本地失败响应：${JSON.stringify(failedResponses)}`);
  assert.deepEqual(failedResponses.filter(response => new URL(response.url).pathname !== '/favicon.ico'), [], 'Bundled editor assets should load successfully');
  complete = true;
  console.log('真实 Butterfly：pointer 写入、宿主套索、仅选中 PNG、显式草稿插入及来源关联、schema4 恢复、离线书库重开、笔记引擎隔离均通过；转写内容与渲染隔离均明确标注为手工/API fixture。');
});
