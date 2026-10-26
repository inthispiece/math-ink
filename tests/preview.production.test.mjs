import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import { symlinkSync } from 'node:fs';
import { join, resolve, dirname, sep, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { chromium } from '@playwright/test';
import { waitForLibrary, waitForSaved, savedNotebooks, createNotebook, openNotebook, manualFormulaDraft, isGenerationRequest } from './production-ui.mjs';

const root = resolve('.');

async function run(command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => output += chunk);
  child.stderr.on('data', chunk => output += chunk);
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, output);
  return output;
}

test('packaged schema-3 preview serves safely, keeps manual drafts separate without AI upload and restores original ink offline', { timeout: 120000 }, async t => {
  const stage = resolve('dist/preview-stage');
  assert.equal(relative(resolve('dist'), stage), 'preview-stage');
  await mkdir(stage, { recursive: true });
  await writeFile(join(stage, '.env'), 'STALE_PRIVATE_CREDENTIAL=never-package-this');
  await writeFile(join(stage, 'old-asset.js'), 'stale build');
  await run(process.execPath, ['scripts/package-preview.mjs']);

  const bytes = await readFile('dist/release/mathink-preview-0.1.0.zip');
  const files = unzipSync(bytes);
  const names = Object.keys(files);
  assert.ok(names.includes('mathink-preview/scripts/serve-preview.mjs'));
  assert.ok(names.includes('mathink-preview/apps/gateway/src/gateway.ts'));
  assert.ok(names.includes('mathink-preview/web/index.html'));
  assert.ok(names.includes('mathink-preview/web/sw.js'));
  assert.ok(names.includes('mathink-preview/LICENSE'));
  assert.ok(names.includes('mathink-preview/THIRD_PARTY_NOTICES.md'));
  assert.equal(JSON.parse(Buffer.from(files['mathink-preview/BUILD-INFO.json']).toString('utf8')).noteBackupSchema, 3);
  assert.equal(names.some(name => name.endsWith('/.env') || name.endsWith('/old-asset.js') || name.includes('node_modules/') || /\.(?:sqlite|keystore|p12)$/.test(name)), false);
  const sums = await readFile('dist/release/SHA256SUMS', 'utf8');
  assert.ok(sums.includes(`${createHash('sha256').update(bytes).digest('hex')}  mathink-preview-0.1.0.zip`));

  const temporary = await mkdtemp(join(tmpdir(), 'mathink-production-preview-'));
  const extraction = join(temporary, 'extracted');
  for (const [name, content] of Object.entries(files)) {
    assert.ok(name.startsWith('mathink-preview/'));
    const path = resolve(extraction, name.slice('mathink-preview/'.length));
    assert.ok(path.startsWith(extraction + sep));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  const outside = join(temporary, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'private.txt'), 'PRIVATE_TEST_SENTINEL');
  symlinkSync(outside, join(extraction, 'web', 'linked-outside'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(join(extraction, 'outside.txt'), 'PRIVATE_PARENT_SENTINEL');

  const port = Number(process.env.PREVIEW_TEST_PORT || '8790');
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['scripts/serve-preview.mjs', '--web-root', 'web'], {
    cwd: extraction,
    env: { ...process.env, OCR_PROVIDER: 'mock', GATEWAY_HOST: '127.0.0.1', GATEWAY_PORT: String(port), GATEWAY_PAIRING_TOKEN: '', GATEWAY_DATABASE_PATH: join(temporary, 'quota.sqlite'), DEEPSEEK_API_KEY: '', MATHPIX_APP_ID: '', MATHPIX_APP_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  server.stdout.on('data', chunk => serverOutput += chunk);
  server.stderr.on('data', chunk => serverOutput += chunk);
  let browser;
  t.after(async () => {
    await browser?.close();
    if (server.exitCode === null) { const exited = once(server, 'exit'); server.kill(); await exited; }
    const checked = resolve(temporary);
    assert.ok(checked.startsWith(resolve(tmpdir()) + sep) && checked.includes('mathink-production-preview-'));
    await rm(checked, { recursive: true, force: true });
  });
  for (let attempt = 0; ; attempt++) {
    if (server.exitCode !== null) throw new Error(`Preview stopped: ${serverOutput}`);
    try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
    if (attempt >= 100) throw new Error(`Preview did not start: ${serverOutput}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const status = await (await fetch(`${base}/v1/status`)).json();
  assert.equal(status.provider, 'mock');
  assert.equal(status.simulated, true);
  const html = await fetch(`${base}/`);
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-type'), /text\/html/);
  assert.match(await html.text(), /MathInk/);
  const fontName = names.find(name => /KaTeX_Main-Regular.*\.woff2$/.test(name));
  assert.ok(fontName);
  const font = await fetch(`${base}/${fontName.slice('mathink-preview/web/'.length)}`);
  assert.equal(font.status, 200);
  assert.equal(font.headers.get('content-type'), 'font/woff2');
  assert.equal((await font.arrayBuffer()).byteLength, files[fontName].byteLength);
  const head = await fetch(`${base}/index.html`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal((await fetch(`${base}/index.html`, { method: 'POST', body: 'invalid' })).status, 405);
  assert.equal((await fetch(`${base}/%2e%2e%2foutside.txt`)).status, 403);
  assert.equal((await fetch(`${base}/linked-outside/private.txt`)).status, 403);
  assert.equal((await fetch(`${base}/%ZZ`)).status, 400);
  assert.equal((await fetch(`${base}/.local/gateway.sqlite`)).status, 404);

  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
  let recognitionPosts = 0;
  context.on('request', request => { if (isGenerationRequest(request)) recognitionPosts++; });
  const page = await context.newPage();
  await page.goto(base + '/?production-preview=1');
  await waitForLibrary(page);
  assert.equal(await page.locator('#library-empty').isVisible(), true);
  assert.deepEqual(await savedNotebooks(page), [], 'First use must not create an automatic sample notebook');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
  });
  const title = '生产预览 · 原稿离线保留';
  await createNotebook(page, title);
  const box = await page.locator('#ink-canvas').boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + 90, box.y + 150);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + 200, { steps: 10 });
  await page.mouse.up();
  await waitForSaved(page);
  const latex = '\\int x^2\\,dx';
  await manualFormulaDraft(page, latex);
  const uninserted = (await savedNotebooks(page))[0];
  assert.equal(uninserted.drafts.length, 1); assert.equal(uninserted.drafts[0].latex, latex);
  assert.equal(uninserted.formulas.length, 0); assert.equal(uninserted.placements.length, 0);
  assert.equal(await page.locator('#recognition-dialog').isVisible(), false);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('math-ink-settings') || '{}').cloudConsent || false), false);
  assert.equal(recognitionPosts, 0, 'Writing and creating a manual draft must not submit any generation request');
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.evaluate(() => document.fonts.check('16px KaTeX_Main')), true);
  await page.getByRole('button', { name: '插入当前页', exact: true }).click();
  await page.locator('#placement-bar').waitFor({ state: 'visible' });
  await page.locator('#ink-canvas').click({ position: { x: 300, y: 260 } });
  await page.locator('.canvas-math').waitFor({ state: 'visible' });
  await waitForSaved(page);
  const inserted = (await savedNotebooks(page))[0];
  assert.equal(inserted.formulas.length, 1); assert.equal(inserted.placements.length, 1);
  assert.equal(inserted.drafts[0].uses.length, 1); assert.equal(inserted.drafts[0].latex, latex);
  await page.locator('#editor-more').click();
  const backupEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出此笔记完整备份', exact: true }).click();
  const backup = JSON.parse(await readFile(await (await backupEvent).path(), 'utf8'));
  assert.equal(backup.schemaVersion, 3); assert.equal(backup.notes[0].pageStrokes[inserted.currentPageId].length, 1);
  assert.equal(backup.notes[0].drafts[0].latex, latex);
  const cachesBefore = await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async name => ({ name, paths: (await (await caches.open(name)).keys()).map(request => new URL(request.url).pathname) })) )));
  assert.ok(cachesBefore.some(cache => cache.paths.includes('/index.html')));
  assert.equal(cachesBefore.some(cache => cache.paths.some(path => path.startsWith('/v1/'))), false);
  await context.setOffline(true);
  await page.reload();
  await waitForLibrary(page);
  assert.equal(await page.locator('#editor-view').isVisible(), false);
  await openNotebook(page, title);
  assert.equal(await page.getByLabel('笔记名称', { exact: true }).inputValue(), title);
  const offline = (await savedNotebooks(page))[0];
  assert.equal(offline.strokes.length, 1); assert.equal(offline.formulas.length, 1);
  assert.equal(offline.drafts.length, 1); assert.equal(offline.drafts[0].uses.length, 1);
  assert.equal(await page.locator('.canvas-math').count(), 1);
  assert.equal(recognitionPosts, 0);
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.evaluate(() => document.fonts.check('16px KaTeX_Main')), true);
  await mkdir(resolve('artifacts'), { recursive: true });
  await page.screenshot({ path: resolve('artifacts/production-preview-offline.png'), fullPage: true });
  console.log(`生产预览：解压后无需 node_modules；空书库、手工草稿与显式插入不上传笔迹，schema3备份、静态字体、目录越界保护、SW 离线重载均通过（${port}）。`);
});
