import { test, expect, type Page } from '@playwright/test';
import { unzipSync } from 'fflate';
import { mkdir } from 'node:fs/promises';
import type { Notebook } from '../../apps/web/src/notebook-domain.ts';
import { toolFixture, notes, settings } from './fixtures/notebook-tools';

const pluginRoot = '/plugins/math-ink/web/';
async function ready(page: Page) {
  await expect(page.locator('#butterfly-frame')).toBeVisible();
  await expect(page.locator('#butterfly-status')).toHaveText('', { timeout: 45000 });
  await expect(page.locator('#tool-pen')).toBeEnabled();
}
function savedPens(note: Notebook): unknown[] {
  if (!note.butterflyData) return [];
  const files = unzipSync(new Uint8Array(note.butterflyData));
  for (const [path, bytes] of Object.entries(files)) {
    if (!path.startsWith('BFLY/pages/') || !path.endsWith('.json')) continue;
    const page = JSON.parse(new TextDecoder().decode(bytes));
    const nativeId = page.extra?.mathinkPage?.id || path.slice('BFLY/pages/'.length, -5);
    if (nativeId === note.butterflyPage) return page.layers.flatMap((layer: any) => layer.content).filter((element: any) => element.type === 'pen');
  }
  return [];
}

test('the SiYuan nested web path loads real bundled Butterfly and restores editable pointer ink without root vendor resources', async ({ page, context }, testInfo) => {
  test.setTimeout(180000);
  const fixture = await toolFixture(page, context), origin = new URL(page.url()).origin;
  const unexpectedRoot: string[] = [], nestedFailures: string[] = [], errors: string[] = [];
  // Resolve the deployment prefix to the same Vite resources. The browser keeps
  // the real nested URL, baseURI and native iframe resource resolution.
  await page.route('**/plugins/math-ink/web/**', async route => {
    const url = new URL(route.request().url());
    url.pathname = '/' + url.pathname.slice(pluginRoot.length);
    const response = await route.fetch({ url: url.href });
    await route.fulfill({ response });
  });
  await page.route(url => url.origin === origin && url.pathname.startsWith('/vendor/butterfly/'), route => {
    unexpectedRoot.push(new URL(route.request().url()).pathname);
    return route.abort();
  });
  await page.route(url => ['http:', 'https:'].includes(url.protocol) && url.origin !== origin, route => route.abort());
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (new URL(response.url()).pathname.startsWith(pluginRoot) && response.status() >= 400) nestedFailures.push(response.url());
  });
  await page.goto(origin + pluginRoot + 'index.html?host=siyuan');
  await expect(page.locator('#library-view')).toBeVisible();
  expect(await page.evaluate(() => document.baseURI)).toBe(origin + pluginRoot + 'index.html?host=siyuan');
  await settings(page); await page.locator('#ink-mode').selectOption('butterfly');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.locator('#new-note').click(); await expect(page.locator('#editor-view')).toBeVisible();
  const title = '思源嵌套路径 · 真实原稿';
  await page.locator('#note-title').fill(title); await page.locator('#note-title').blur();
  await ready(page);
  await expect(page.locator('#butterfly-frame')).toHaveAttribute('src', /^\/plugins\/math-ink\/web\/vendor\/butterfly\/index\.html#/);
  const frameUrl = page.frames().find(frame => frame.url().includes('/vendor/butterfly/index.html'))?.url();
  expect(frameUrl).toBeTruthy(); expect(new URL(frameUrl!).pathname).toBe(pluginRoot + 'vendor/butterfly/index.html');
  await page.locator('#tool-pen').click();
  await page.evaluate(() => {
    const state = window as any;
    state.__nativeAutosaveEvents = [];
    window.addEventListener('message', event => {
      const frame = document.querySelector<HTMLIFrameElement>('#butterfly-frame');
      if (event.origin === location.origin && event.source === frame?.contentWindow && ['mathinkDirty', 'change'].includes(event.data?.type)) {
        state.__nativeAutosaveEvents.push({ type: event.data.type, saved: document.getElementById('save-state')?.textContent });
      }
    });
  });
  const box = (await page.locator('#butterfly-frame').boundingBox())!;
  await page.mouse.move(box.x + 150, box.y + 180); await page.mouse.down();
  await page.mouse.move(box.x + 190, box.y + 140, { steps: 8 });
  await page.mouse.move(box.x + 240, box.y + 200, { steps: 8 }); await page.mouse.up();
  await expect.poll(async () => {
    const note = (await notes(page)).find(note => note.title === title);
    return note ? savedPens(note).length : 0;
  }).toBe(1);
  const autosaveEvents = await page.evaluate(() => (window as any).__nativeAutosaveEvents as { type: string; saved: string }[]);
  expect(autosaveEvents.some(event => event.type === 'mathinkDirty' && event.saved === '正在保存…')).toBe(true);
  expect(autosaveEvents.some(event => event.type === 'change')).toBe(true);
  await mkdir('.local/frontend-states', { recursive: true });
  await testInfo.attach('nested-native-after-automatic-save', { body: await page.screenshot({ path: '.local/frontend-states/08-plugin.png' }), contentType: 'image/png' });
  const original = (await notes(page)).find(note => note.title === title)!, ink = savedPens(original);
  expect((ink[0] as any).points.length).toBeGreaterThan(3);
  await page.locator('#back-library').click(); await expect(page.locator('#library-view')).toBeVisible();
  await page.reload(); await expect(page.locator('#library-view')).toBeVisible();
  await page.getByRole('button', { name: '打开 ' + title, exact: true }).click(); await ready(page);
  await expect(page.locator('#butterfly-frame')).toHaveAttribute('src', /^\/plugins\/math-ink\/web\/vendor\/butterfly\/index\.html#/);
  await expect.poll(async () => savedPens((await notes(page)).find(note => note.id === original.id)!).length).toBe(1);
  expect(savedPens((await notes(page)).find(note => note.id === original.id)!)).toEqual(ink);
  expect((await notes(page)).find(note => note.id === original.id)!.inkEngine).toBe('butterfly');
  expect(unexpectedRoot).toEqual([]); expect(nestedFailures).toEqual([]); expect(errors).toEqual([]);
  expect(fixture.generated()).toHaveLength(0);
});
