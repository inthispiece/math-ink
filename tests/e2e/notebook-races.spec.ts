import { test, expect, type Page, type Route } from '@playwright/test';
import { unzipSync } from 'fflate';
import { toolFixture, notes, settings } from './fixtures/notebook-tools';

async function create(page: Page, title: string) {
  await page.locator('#new-note').click();
  await expect(page.locator('#editor-view')).toBeVisible();
  await page.locator('#note-title').fill(title);
  await page.locator('#note-title').blur();
  await expect.poll(async () => (await notes(page)).find(note => note.title === title)?.id).toBeTruthy();
  return (await notes(page)).find(note => note.title === title)!;
}
async function ready(page: Page) {
  await expect(page.locator('#butterfly-frame')).toBeVisible();
  await expect(page.locator('#butterfly-status')).toHaveText('', { timeout: 45000 });
  await expect(page.locator('#tool-pen')).toBeEnabled();
  await expect(page.locator('#add-page')).toBeEnabled();
}
async function useButterflyForNewNotes(page: Page) {
  await settings(page);
  await page.locator('#ink-mode').selectOption('butterfly');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
}
async function native(page: Page, method: string, payload: unknown = {}): Promise<any> {
  return page.evaluate(({ method, payload }) => new Promise((resolve, reject) => {
    const frame = document.querySelector<HTMLIFrameElement>('#butterfly-frame')!, requestId = crypto.randomUUID();
    const timer = setTimeout(() => { window.removeEventListener('message', receive); reject(new Error('Native bridge: ' + method)); }, 15000);
    function receive(event: MessageEvent) {
      if (event.origin !== location.origin || event.source !== frame.contentWindow || event.data?.type !== 'mathink' || event.data.message?.requestId !== requestId) return;
      clearTimeout(timer); window.removeEventListener('message', receive);
      event.data.message.ok === false ? reject(new Error(event.data.message.error)) : resolve(event.data.message.result);
    }
    window.addEventListener('message', receive);
    frame.contentWindow!.postMessage({ type: 'mathink', message: { requestId, method, payload } }, location.origin);
  }), { method, payload });
}

test('an abandoned pending Butterfly manifest cannot attach its old engine to another notebook', async ({ page, context }) => {
  const fixture = await toolFixture(page, context);
  const other = await create(page, 'B · 独立实验画布');
  const canvas = page.locator('#ink-canvas'), box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 100, box.y + 120); await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + 150, { steps: 8 }); await page.mouse.up();
  await expect.poll(async () => (await notes(page)).find(note => note.id === other.id)!.strokes.length).toBe(1);
  await page.locator('#back-library').click();
  await expect(page.locator('#library-view')).toBeVisible();
  await useButterflyForNewNotes(page);
  let held: Route | undefined;
  await page.route('**/vendor/butterfly/manifest.json', route => { held = route; });
  const owner = await create(page, 'A · 等待原生资源');
  await expect.poll(() => !!held).toBe(true);
  expect(await page.locator('#butterfly-frame').count()).toBe(0);
  await page.locator('#back-library').click();
  await expect(page.locator('#library-view')).toBeVisible();
  await page.getByRole('button', { name: '打开 ' + other.title, exact: true }).click();
  await expect(page.locator('#note-title')).toHaveValue(other.title);
  await expect(page.locator('#experimental-canvas')).toBeVisible();
  const before = (await notes(page)).find(note => note.id === other.id)!;
  const completed = page.waitForEvent('requestfinished', request => new URL(request.url()).pathname === '/vendor/butterfly/manifest.json');
  await held!.continue(); await completed;
  // Drain rendering turns after fetch/json continuation; an immediate zero-frame
  // assertion alone could pass before the abandoned continuation runs.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator('#note-title')).toHaveValue(other.title);
  await expect(page.locator('#experimental-canvas')).toBeVisible();
  await expect(page.locator('#butterfly-panel')).not.toBeVisible();
  await expect(page.locator('#butterfly-frame')).toHaveCount(0);
  const after = (await notes(page)).find(note => note.id === other.id)!;
  expect(after.inkEngine).toBe('experimental'); expect(after.butterflyData).toBeUndefined();
  expect(after.pageStrokes).toEqual(before.pageStrokes); expect(after.currentPageId).toBe(before.currentPageId);
  expect((await notes(page)).find(note => note.id === owner.id)!.inkEngine).toBe('butterfly');
  expect(fixture.generated()).toHaveLength(0);
});

test('a pending native formula placement keeps its original page and blocks page or library navigation until saved', async ({ page, context }) => {
  test.setTimeout(180000);
  const fixture = await toolFixture(page, context);
  await useButterflyForNewNotes(page);
  const owner = await create(page, '公式提交中的页面归属'); await ready(page);
  const first = (await notes(page)).find(note => note.id === owner.id)!.currentPageId!;
  await page.locator('#add-page').click(); await expect(page.locator('#page-number')).toHaveText('2 / 2');
  const second = (await notes(page)).find(note => note.id === owner.id)!.currentPageId!;
  await page.locator('#prev-page').click(); await expect(page.locator('#page-number')).toHaveText('1 / 2');
  await page.locator('#toolbox-open').click(); await page.getByText('手工创建草稿', { exact: true }).click();
  page.once('dialog', dialog => void dialog.accept('\\int x^2\\,dx'));
  await page.getByRole('button', { name: '输入 LaTeX 公式', exact: true }).click();
  await expect(page.locator('#draft-detail-dialog')).toBeVisible();
  await page.getByRole('button', { name: '插入当前页', exact: true }).click();
  await expect(page.locator('#native-placement-preview .katex')).toBeVisible();
  // Hold one host→native packet, rather than substitute the Flutter engine or
  // its result. Releasing forwards the exact packet to the real native bridge.
  await page.evaluate(() => {
    const target = document.querySelector<HTMLIFrameElement>('#butterfly-frame')!.contentWindow!, original = target.postMessage;
    const state = window as any;
    let held: [unknown, string, Transferable[]?] | undefined;
    state.__heldNativePlacement = false;
    (target as any).postMessage = (packet: any, origin: string, transfer?: Transferable[]) => {
      if (!held && packet?.type === 'mathink' && packet.message?.method === 'insertMath') {
        held = [packet, origin, transfer]; state.__heldNativePlacement = true; return;
      }
      Reflect.apply(original, target, transfer ? [packet, origin, transfer] : [packet, origin]);
    };
    state.__releaseNativePlacement = () => {
      target.postMessage = original;
      if (held) { const [packet, origin, transfer] = held; Reflect.apply(original, target, transfer ? [packet, origin, transfer] : [packet, origin]); held = undefined; }
      state.__heldNativePlacement = false;
    };
  });
  const frame = (await page.locator('#butterfly-frame').boundingBox())!;
  await page.mouse.click(frame.x + 280, frame.y + 180);
  await page.waitForFunction(() => (window as any).__heldNativePlacement === true);
  try {
    await page.locator('#next-page').click();
    await expect(page.locator('#toast')).toContainText('正在放置公式，请稍候再切换页面');
    await expect(page.locator('#page-number')).toHaveText('1 / 2');
    await page.locator('#back-library').click();
    await expect(page.locator('#toast')).toContainText('正在放置公式，请稍候再切换页面');
    await expect(page.locator('#editor-view')).toBeVisible();
    expect((await notes(page)).find(note => note.id === owner.id)!.currentPageId).toBe(first);
    expect((await notes(page)).find(note => note.id === owner.id)!.placements).toHaveLength(0);
  } finally { await page.evaluate(() => (window as any).__releaseNativePlacement?.()); }
  await expect.poll(async () => (await notes(page)).find(note => note.id === owner.id)!.placements.filter(placement => !placement.deletedAt).length).toBe(1);
  const saved = (await notes(page)).find(note => note.id === owner.id)!, placement = saved.placements[0];
  expect(placement.pageId).toBe(first); expect(placement.elementId).toBeTruthy(); expect(saved.currentPageId).toBe(first);
  expect(saved.drafts).toHaveLength(1); expect(saved.drafts[0].latex).toBe('\\int x^2\\,dx'); expect(saved.drafts[0].uses).toHaveLength(1);
  const nativeDocument = await native(page, 'getDocument'), files = unzipSync(new Uint8Array(nativeDocument.data));
  for (const hostId of [first, second]) {
    const host = saved.pages.find(row => row.id === hostId)!, row = nativeDocument.pages.find((row: any) => row.id === host.nativePageId);
    expect(row).toBeTruthy();
    const nativePage = JSON.parse(new TextDecoder().decode(files['BFLY/pages/' + row.name + '.json']));
    const math = nativePage.layers.flatMap((layer: any) => layer.content).filter((element: any) => element.type === 'markdown' && element.extra?.mathink);
    expect(math).toHaveLength(hostId === first ? 1 : 0);
    if (hostId === first) expect(math[0].id).toBe(placement.elementId);
  }
  await page.locator('#next-page').click(); await expect(page.locator('#page-number')).toHaveText('2 / 2');
  await page.locator('#back-library').click(); await expect(page.locator('#library-view')).toBeVisible();
  await page.getByRole('button', { name: '打开 ' + owner.title, exact: true }).click(); await ready(page);
  const reopened = (await notes(page)).find(note => note.id === owner.id)!;
  expect(reopened.currentPageId).toBe(second); expect(reopened.placements[0].pageId).toBe(first);
  expect(reopened.placements[0].elementId).toBe(placement.elementId); expect(fixture.generated()).toHaveLength(0);
});

test('moving pages forward and backward crosses a deleted middle page according to visible order', async ({ page, context }) => {
  const fixture = await toolFixture(page, context), owner = await create(page, '可见页顺序');
  const first = owner.currentPageId!;
  await page.locator('#add-page').click(); await expect(page.locator('#page-number')).toHaveText('2 / 2');
  const middle = (await notes(page)).find(note => note.id === owner.id)!.currentPageId!;
  await page.locator('#add-page').click(); await expect(page.locator('#page-number')).toHaveText('3 / 3');
  const last = (await notes(page)).find(note => note.id === owner.id)!.currentPageId!;
  await page.locator('#pages-open').click();
  await page.locator('.page-item').nth(1).getByRole('button', { name: '页菜单', exact: true }).click();
  await page.getByRole('button', { name: '删除这一页', exact: true }).click();
  await expect(page.locator('.page-item')).toHaveCount(2);
  const visibleOrder = async () => {
    const current = (await notes(page)).find(note => note.id === owner.id)!;
    return current.pageOrder.filter(id => current.pages.some(row => row.id === id && !row.deletedAt && !row.nativeMissing));
  };
  expect(await visibleOrder()).toEqual([first, last]);
  const deletedAt = (await notes(page)).find(note => note.id === owner.id)!.pages.find(row => row.id === middle)!.deletedAt;
  expect(deletedAt).toBeTruthy();
  await page.locator('.page-item.active').getByRole('button', { name: '页菜单', exact: true }).click();
  await page.getByRole('button', { name: '向前移一页', exact: true }).click();
  await expect.poll(visibleOrder).toEqual([last, first]); await expect(page.locator('#page-number')).toHaveText('1 / 2');
  await page.locator('.page-item.active').getByRole('button', { name: '页菜单', exact: true }).click();
  await page.getByRole('button', { name: '向后移一页', exact: true }).click();
  await expect.poll(visibleOrder).toEqual([first, last]); await expect(page.locator('#page-number')).toHaveText('2 / 2');
  expect((await notes(page)).find(note => note.id === owner.id)!.pages.find(row => row.id === middle)!.deletedAt).toBe(deletedAt);
  await page.locator('#back-library').click(); await page.reload();
  await expect(page.locator('#library-view')).toBeVisible();
  await page.getByRole('button', { name: '打开 ' + owner.title, exact: true }).click();
  await expect(page.locator('#page-number')).toHaveText('2 / 2'); expect(await visibleOrder()).toEqual([first, last]);
  expect(fixture.generated()).toHaveLength(0);
});
