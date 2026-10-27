import { test, expect, type Page, type BrowserContext, type Route } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { Notebook } from '../../apps/web/src/notebook-domain.ts';

const token = 'draft-editor-fixture-token-2026';
interface Seed { noteId: string; draftId: string; title: string; paragraphId: string; formulaIds: string[]; sourceId: string; sourcePageId: string; imageUrl: string; listId: string; imageId: string; headingId: string }
interface Call { method: string; path: string; body?: Record<string, unknown>; authorization?: string }
async function fixture(page: Page, context: BrowserContext) {
  const calls: Call[] = []; let recoveryStatus: 'running' | 'result-unavailable' | 'error' = 'result-unavailable', sequence = 0;
  await context.addInitScript(({ token }) => {
    localStorage.setItem('math-ink-settings', JSON.stringify({ gatewayUrl: location.origin, pairingToken: token, installationId: 'draft-editor-browser-fixture', provider: 'deepseek', cloudConsent: false, cloudConsentProviders: [], inkMode: 'experimental' }));
  }, { token });
  const fulfill = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  // No /v1 call can leave this context. Even unknown endpoints fail inside the fixture.
  await context.route('**/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    const body = request.postDataJSON() as Record<string, unknown> | null;
    calls.push({ method, path, body: body || undefined, authorization: request.headers().authorization });
    if (path === '/v1/status') return fulfill(route, 200, { status: 'ok', authMode: 'local', provider: url.searchParams.get('provider') || 'deepseek', configured: true, simulated: false, local: false, model: 'fixture-not-real', protocolCapabilities: { recognitionTasks: true, recognitionLookup: true, taskLookup: true }, taskCapabilities: { 'page-transcribe': true, 'context-review': true, organize: true, 'knowledge-links': true, 'proof-assist': true } });
    if (path === '/v1/pairing') return fulfill(route, 200, { status: 'ok', paired: true });
    if (path === '/v1/local-pairing') return fulfill(route, 200, { status: 'ok', pairingToken: token });
    if (path === '/v1/provider-health') return fulfill(route, 200, { status: 'ok', ready: true, message: '隔离测试，不调用模型' });
    if (path === '/v1/usage') return fulfill(route, 200, { status: 'ok', provider: 'deepseek', simulated: false });
    if ((path === '/v1/recognitions' || path === '/v1/tasks') && method === 'POST') return fulfill(route, 202, { taskId: 'b0000000-0000-4000-8000-' + String(++sequence).padStart(12, '0'), provider: body?.provider || 'deepseek', status: 'running', sourceRevision: body?.sourceRevision || 1 });
    if (method === 'GET' && (path.startsWith('/v1/recognitions/') || path.startsWith('/v1/tasks/'))) return fulfill(route, 200, { taskId: path.includes('by-request/') ? 'a0000000-0000-4000-8000-000000000001' : path.split('/').at(-1), provider: url.searchParams.get('provider') || 'deepseek', status: recoveryStatus, sourceRevision: 1, ...(recoveryStatus === 'running' ? {} : { error: { code: recoveryStatus === 'error' ? 'PROVIDER_TIMEOUT' : 'RECOGNITION_RESULT_UNAVAILABLE', message: '原任务结果暂不可用，不会自动重新生成', retryable: false } }) });
    if (method === 'POST' && path.endsWith('/cancel')) return fulfill(route, 200, { status: 'error', error: { code: 'RECOGNITION_CANCELLED', message: '已取消收取，费用仍需核对' } });
    return fulfill(route, 500, { error: { code: 'FIXTURE_GUARD', message: '禁止测试访问真实模型接口' } });
  });
  await page.goto('/'); await expect(page.locator('#library-view')).toBeVisible(); await expect(page.locator('#library-count')).not.toContainText('正在');
  return { calls, generated: () => calls.filter(call => call.method === 'POST' && ['/v1/recognitions', '/v1/tasks', '/v1/recognize', '/v1/review'].includes(call.path)), setRecoveryStatus(value: typeof recoveryStatus) { recoveryStatus = value; } };
}
async function stored(page: Page): Promise<Notebook[]> { return page.evaluate(() => new Promise((resolve, reject) => { const request = indexedDB.open('math-ink-notebooks'); request.onerror = () => reject(request.error); request.onsuccess = () => { const db = request.result, read = db.transaction('notes', 'readonly').objectStore('notes').getAll(); read.onsuccess = () => { db.close(); resolve(read.result); }; read.onerror = () => reject(read.error); }; })); }
async function seed(page: Page, options: { type?: 'formula' | 'page' | 'review' | 'proof'; suggestions?: 'math' | 'conflict'; partial?: boolean; reviewed?: boolean; extraPage?: boolean } = {}): Promise<Seed> {
  return page.evaluate(async options => {
    const modelPath = '/src/model.ts', domainPath = '/src/notebook-domain.ts', repositoryPath = '/src/notebook-repository.ts', pagePath = '/src/page-model.ts', contentPath = '/src/draft-content.ts', digestPath = '/src/source-copy.ts';
    const model = await import(modelPath), domain = await import(domainPath), repository = await import(repositoryPath), pm = await import(pagePath), contentHelpers = await import(contentPath), digest = await import(digestPath);
    const n = domain.ensureNotebook(model.newNote()); n.title = '草稿详情测试'; const sourcePage = domain.currentPage(n);
    domain.commitPageInk(n, [{ id: 'seed-ink', color: '#253d35', width: 3, points: [{ x: 60, y: 50, pressure: .5 }, { x: 150, y: 70, pressure: .7 }] }]);
    const source = pm.createSourceRef(n, sourcePage.id, { x: 40, y: 30, width: 180, height: 80 }, ['seed-ink']);
    const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 110; const context = canvas.getContext('2d')!; context.fillStyle = 'white'; context.fillRect(0, 0, 240, 110); context.strokeStyle = '#253d35'; context.lineWidth = 3; context.beginPath(); context.moveTo(30, 50); context.lineTo(200, 70); context.stroke(); const imageUrl = canvas.toDataURL('image/png'), snapshotId = domain.addSnapshot(n, imageUrl);
    let documentContent: any, paragraphId = '', listId = '', imageId = '', headingId = '', formulaIds: string[] = [];
    if (options.type && options.type !== 'formula') {
      documentContent = pm.ensurePageModel(model.newNote()); documentContent.title = '独立排版草稿'; const pageId = documentContent.pages[0].id;
      documentContent.sources.push(structuredClone(source)); const f = contentHelpers.formulaFor(documentContent, 'x^2', source, true), g = contentHelpers.formulaFor(documentContent, 'y^2', source, true); formulaIds = [f.id, g.id];
      const heading = pm.createParagraphBlock(documentContent, 'Hölder 不等式', pageId); headingId = heading.id; pm.updateBlock(documentContent, heading.id, { content: { runs: [{ type: 'text', text: 'Hölder 不等式' }], role: 'heading', level: 2 }, sourceRefIds: [source.id] });
      const paragraph = pm.createParagraphBlock(documentContent, '', pageId); paragraphId = paragraph.id;
      pm.updateBlock(documentContent, paragraph.id, { content: { runs: [{ type: 'text', text: '设 ' }, { type: 'formula', formulaId: f.id }, { type: 'text', text: ' 与 ' }, { type: 'formula', formulaId: g.id }, { type: 'text', text: ' 非负。' }] }, sourceRefIds: [source.id], needsReview: true });
      const list = pm.createParagraphBlock(documentContent, '条件 p > 1', pageId); listId = list.id; pm.updateBlock(documentContent, list.id, { content: { runs: [{ type: 'text', text: '条件 p > 1' }], role: 'list-item' }, sourceRefIds: [source.id] });
      const image = pm.createParagraphBlock(documentContent, '', pageId); imageId = image.id; pm.updateBlock(documentContent, image.id, { type: 'image', content: { imageDataUrl: imageUrl, caption: '图形保留原图，请核对' }, sourceRefIds: [source.id], needsReview: true });
      const integral = contentHelpers.formulaFor(documentContent, '\\int x^2\\,dx', source, true), equation = pm.createFormulaBlock(documentContent, integral.id, pageId); pm.updateBlock(documentContent, equation.id, { type: 'derivation', sourceRefIds: [source.id], needsReview: true });
      if (options.suggestions) {
        const first = structuredClone(paragraph.content); first.runs[0].text = '核对后设 ';
        pm.createSuggestion(documentContent, { targetBlockId: paragraph.id, proposed: first, inlineFormulaChanges: [{ formulaId: f.id, originalLatex: 'x^2', proposedLatex: 'x^3' }], category: 'mathematics', reason: '测试建议：上标需要核对', evidence: ['原段落的指数'], contextBlockIds: documentContent.blocks.map((b: any) => b.id) });
        if (options.suggestions === 'conflict') {
          const shared = pm.createParagraphBlock(documentContent, '', pageId); pm.updateBlock(documentContent, shared.id, { content: { runs: [{ type: 'text', text: '另一处 ' }, { type: 'formula', formulaId: f.id }] }, sourceRefIds: [source.id] });
          // Freeze both snapshots only after every initial content block exists.
          documentContent.suggestions = [];
          pm.createSuggestion(documentContent, { targetBlockId: paragraph.id, proposed: first, inlineFormulaChanges: [{ formulaId: f.id, originalLatex: 'x^2', proposedLatex: 'x^3' }], reason: '第一条共享公式建议', contextBlockIds: documentContent.blocks.map((b: any) => b.id) });
          pm.createSuggestion(documentContent, { targetBlockId: shared.id, proposed: structuredClone(shared.content), inlineFormulaChanges: [{ formulaId: f.id, originalLatex: 'x^2', proposedLatex: 'x^4' }], reason: '与第一条冲突的共享公式建议', contextBlockIds: documentContent.blocks.map((b: any) => b.id) });
          pm.createSuggestion(documentContent, { targetBlockId: list.id, proposed: { ...structuredClone(list.content), runs: [{ type: 'text', text: '未勾选条件不得改变' }] }, category: 'language', reason: '未勾选建议', contextBlockIds: documentContent.blocks.map((b: any) => b.id) });
        } else pm.createSuggestion(documentContent, { targetBlockId: list.id, proposed: { ...structuredClone(list.content), runs: [{ type: 'text', text: '条件 p > 2' }] }, reason: '上下文变化后必须重新检查', contextBlockIds: documentContent.blocks.map((b: any) => b.id) });
      }
    }
    const at = new Date().toISOString(), type = options.type || 'formula', task = options.partial ? { kind: type, clientRequestId: 'draft-editor-original-request', remoteId: 'a0000000-0000-4000-8000-000000000001', provider: 'deepseek', gateway: location.origin, installationId: 'draft-editor-browser-fixture', principal: 'local:' + digest.manuscriptDigest('draft-editor-fixture-token-2026'), phase: 'partial', request: {}, createdAt: at, updatedAt: at, sourceRevision: n.revision } : undefined;
    if (task) { const connections = JSON.parse(localStorage.getItem('mathink-local-connections') || '{}'); connections[location.origin] = { [task.principal]: 'draft-editor-fixture-token-2026' }; localStorage.setItem('mathink-local-connections', JSON.stringify(connections)); }
    const draft = domain.createDraft(n, { type, title: type === 'formula' ? '不定积分草稿' : '中英数学草稿', sourcePageId: sourcePage.id, sourceRevision: sourcePage.revision, source, snapshotIds: [snapshotId], version: 1, status: options.partial ? 'partial' : 'completed', reviewed: !!options.reviewed, ...(type === 'formula' ? { latex: '\\int x^2\\,dx' } : { content: documentContent }), ...(task ? { task, taskId: task.clientRequestId } : {}), ...(type === 'proof' ? { result: { goal: '核对原函数', assumptions: ['x 为实数'], existingSteps: [], nextSteps: ['先对候选原函数求导'], unresolved: ['尚需核对计算'], verification: 'unverified' } } : {}) });
    if (options.extraPage) domain.addPage(n, { afterPageId: sourcePage.id });
    await repository.saveEditingNote(n);
    return { noteId: n.id, draftId: draft.id, title: n.title, paragraphId, formulaIds, sourceId: source.id, sourcePageId: sourcePage.id, imageUrl, listId, imageId, headingId };
  }, options);
}
async function openOwner(page: Page, ids: Seed) { await page.reload(); await expect(page.locator('#library-view')).toBeVisible(); await page.getByRole('button', { name: '打开 ' + ids.title, exact: true }).click(); await expect(page.locator('#editor-view')).toBeVisible(); }
async function openDraft(page: Page, ids: Seed) { if (!await page.locator('.draft-item[data-draft-id="' + ids.draftId + '"]').isVisible()) await page.locator('#drafts-open').click(); await page.locator('.draft-item[data-draft-id="' + ids.draftId + '"]').click(); await expect(page.locator('#draft-detail-dialog')).toBeVisible(); }
async function current(page: Page, ids: Seed) { return (await stored(page)).find(n => n.id === ids.noteId)!; }
async function draft(page: Page, ids: Seed) { return (await current(page, ids)).drafts.find(d => d.id === ids.draftId)!; }
const card = (page: Page, id: string) => page.locator('#draft-block-list .dd-block[data-block-id="' + id + '"]');
async function closeDraft(page: Page) { await page.locator('#draft-detail-dialog').getByRole('button', { name: '关闭', exact: true }).click(); await expect(page.locator('#draft-detail-dialog')).not.toBeVisible(); }
async function place(page: Page, ids: Seed, x: number, y: number, twice = false) { await openDraft(page, ids); const consent = (dialog: import('@playwright/test').Dialog) => dialog.message().startsWith('原稿已变化') ? dialog.accept() : dialog.dismiss(); page.on('dialog', consent); await page.locator('#draft-detail-dialog').getByRole('button', { name: '插入当前页', exact: true }).click(); await expect(page.locator('#placement-bar')).toBeVisible(); page.off('dialog', consent); const box = (await page.locator('#ink-canvas').boundingBox())!; expect(await page.evaluate(({x,y}) => document.elementFromPoint(x,y)?.id, {x:box.x+x,y:box.y+y})).toBe('ink-canvas'); if (twice) await page.mouse.dblclick(box.x + x, box.y + y); else await page.mouse.click(box.x + x, box.y + y); await expect(page.locator('#placement-bar')).not.toBeVisible(); await expect(page.locator('#save-state')).toHaveText('已保存'); }

test('formula detail defaults to typeset preview; consecutive automatic saves and immediate review persist without changing formal pages', async ({ page, context }) => {
  const service = await fixture(page, context), ids = await seed(page); await openOwner(page, ids); await openDraft(page, ids);
  await expect(page.locator('#draft-formula-preview .katex')).toBeVisible(); await expect(page.locator('#draft-latex-input')).not.toBeVisible();
  await page.locator('.dd-formula-edit summary').click(); const input = page.locator('#draft-latex-input');
  await input.fill('\\int x^3\\,dx'); await expect.poll(async () => (await draft(page, ids)).latex).toBe('\\int x^3\\,dx');
  await input.fill('\\int x^4\\,dx'); await page.locator('#draft-reviewed').check();
  await expect.poll(async () => ({ latex: (await draft(page, ids)).latex, reviewed: (await draft(page, ids)).reviewed })).toEqual({ latex: '\\int x^4\\,dx', reviewed: true });
  await closeDraft(page); await openDraft(page, ids); await expect(page.locator('#draft-reviewed')).toBeChecked(); await expect(input).toBeVisible(); await expect(input).toHaveValue('\\int x^4\\,dx');
  const note = await current(page, ids); expect(note.formulas).toHaveLength(0); expect(note.blocks).toHaveLength(0); expect(note.placements).toHaveLength(0); expect(note.drafts).toHaveLength(1); expect(service.generated()).toHaveLength(0);
});

test('inline editing never duplicates canonical formulas or sources and unchanged input does not create another version', async ({ page, context }) => {
  await fixture(page, context); const ids = await seed(page, { type: 'page', reviewed: true }); await openOwner(page, ids); await openDraft(page, ids);
  const input = card(page, ids.paragraphId).locator('textarea'), initial = await draft(page, ids), text = await input.inputValue();
  await input.fill(text); await page.waitForTimeout(600); expect((await draft(page, ids)).version).toBe(initial.version);
  await input.fill('若 $x^2$ 与 $y^2$ 非负。'); await expect.poll(async () => JSON.stringify((await draft(page, ids)).content)).toContain('若 ');
  await input.fill('若 $x^3$ 与 $y^2$ 非负。'); await expect.poll(async () => (await draft(page, ids)).content!.formulas.find(f => f.id === ids.formulaIds[0])?.latex).toBe('x^3');
  const saved = await draft(page, ids), block = saved.content!.blocks!.find(b => b.id === ids.paragraphId)!;
  expect(saved.content!.formulas).toHaveLength(initial.content!.formulas.length); expect(block.content.runs!.filter(r => r.type === 'formula').map(r => r.formulaId)).toEqual(ids.formulaIds); expect(block.sourceRefIds).toEqual([ids.sourceId]); expect(saved.reviewed).toBe(false); expect((await current(page, ids)).formulas).toHaveLength(0);
});

test('splitting and merging paragraphs preserve inline identities and source; splitting inside a formula is refused', async ({ page, context }) => {
  await fixture(page, context); const ids = await seed(page, { type: 'page' }); await openOwner(page, ids); await openDraft(page, ids);
  let input = card(page, ids.paragraphId).locator('textarea'); const text = await input.inputValue(), count = await page.locator('#draft-block-list .dd-block').count();
  await input.evaluate((e: HTMLTextAreaElement) => { e.focus(); const at = e.value.indexOf('x^2') + 1; e.setSelectionRange(at, at); }); await card(page, ids.paragraphId).getByRole('button', { name: '在光标处分段', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('公式之外'); await expect(page.locator('#draft-block-list .dd-block')).toHaveCount(count);
  await input.evaluate((e: HTMLTextAreaElement) => { const at = e.value.indexOf(' 与 ') + 1; e.setSelectionRange(at, at); }); await card(page, ids.paragraphId).getByRole('button', { name: '在光标处分段', exact: true }).click(); await expect(page.locator('#draft-block-list .dd-block')).toHaveCount(count + 1);
  await card(page, ids.paragraphId).getByRole('button', { name: '合并下一段', exact: true }).click(); await expect(page.locator('#draft-block-list .dd-block')).toHaveCount(count);
  await closeDraft(page); const saved = await draft(page, ids), block = saved.content!.blocks!.find(b => b.id === ids.paragraphId)!;
  expect(saved.content!.formulas).toHaveLength(3); expect(block.content.runs!.filter(r => r.type === 'formula').map(r => r.formulaId)).toEqual(ids.formulaIds); expect(block.sourceRefIds).toEqual([ids.sourceId]); expect(text).toContain('$x^2$');
});

test('mixed heading, list, image and derivation remain editable isolated draft content and keep original source pixels', async ({ page, context }) => {
  await fixture(page, context); const ids = await seed(page, { type: 'page' }); await openOwner(page, ids); await openDraft(page, ids);
  await expect(card(page, ids.headingId).locator('.dd-heading-preview')).toContainText('Hölder');
  await expect(card(page, ids.imageId).locator('img')).toHaveAttribute('src', ids.imageUrl);
  await card(page, ids.listId).locator('textarea').fill('条件 p > 1，不得遗漏'); await card(page, ids.paragraphId).locator('select').selectOption('list-item'); await closeDraft(page);
  const saved = await draft(page, ids), blocks = saved.content!.blocks!;
  expect(blocks.find(b => b.id === ids.listId)!.content.role).toBe('list-item'); expect(blocks.find(b => b.id === ids.paragraphId)!.content.role).toBe('list-item');
  expect(blocks.find(b => b.id === ids.imageId)!.content.imageDataUrl).toBe(ids.imageUrl); expect(blocks.some(b => b.type === 'derivation')).toBe(true); expect((await current(page, ids)).blocks).toHaveLength(0);
});

test('text and inline-math suggestions preview without mutation, apply and undo explicitly; edits invalidate remaining suggestions', async ({ page, context }) => {
  await fixture(page, context); const ids = await seed(page, { type: 'review', suggestions: 'math' }); await openOwner(page, ids); await openDraft(page, ids);
  const first = page.locator('.dd-suggestion').first(); await expect(first.locator('.dd-comparison .katex')).not.toHaveCount(0);
  expect((await draft(page, ids)).content!.formulas.find(f => f.id === ids.formulaIds[0])!.latex).toBe('x^2');
  await first.getByRole('button', { name: '采用这条建议', exact: true }).click();
  await expect.poll(async () => (await draft(page, ids)).content!.formulas.find(f => f.id === ids.formulaIds[0])!.latex).toBe('x^3');
  await page.locator('.dd-suggestion').first().getByRole('button', { name: '撤销采用', exact: true }).click();
  await expect.poll(async () => (await draft(page, ids)).content!.formulas.find(f => f.id === ids.formulaIds[0])!.latex).toBe('x^2');
  await card(page, ids.paragraphId).locator('textarea').fill('新的上下文 $x^2$ 与 $y^2$ 非负。');
  await expect(page.locator('.dd-suggestion').nth(1).getByRole('button', { name: '已过期，请重新检查', exact: true })).toBeDisabled();
  expect((await current(page, ids)).formulas).toHaveLength(0);
});

test('batch applies only checked compatible suggestions and skips shared-canonical conflicts while preserving unselected content', async ({ page, context }) => {
  await fixture(page, context); const ids = await seed(page, { type: 'review', suggestions: 'conflict' }); await openOwner(page, ids); await openDraft(page, ids);
  await page.getByLabel('勾选建议 1', { exact: true }).check(); await page.getByLabel('勾选建议 2', { exact: true }).check(); await page.locator('#draft-apply-checked').click();
  await expect.poll(async () => (await draft(page, ids)).content!.suggestions!.filter(s => s.status === 'accepted').length).toBe(1);
  const saved = await draft(page, ids), suggestions = saved.content!.suggestions!;
  expect(suggestions[0].status).toBe('accepted'); expect(suggestions[1].status).toBe('pending'); expect(suggestions[2].status).toBe('pending');
  expect(saved.content!.formulas.find(f => f.id === ids.formulaIds[0])!.latex).toBe('x^3'); expect(JSON.stringify(saved.content!.blocks!.find(b => b.id === ids.listId)!.content)).toContain('条件 p > 1');
});

test('partial content survives unavailable task recovery, query remains GET-only and explicit redo uses one confirmation and a new identity', async ({ page, context }) => {
  const service = await fixture(page, context), ids = await seed(page, { partial: true }); await openOwner(page, ids); await openDraft(page, ids);
  await expect.poll(async () => (await draft(page, ids)).status).toBe('unknown'); await expect(page.locator('#draft-formula-preview .katex')).toBeVisible();
  const before = service.calls.filter(c => c.method === 'GET' && c.path.startsWith('/v1/recognitions/')).length;
  await page.locator('#draft-detail-dialog').getByRole('button', { name: '查询原任务', exact: true }).click(); await expect.poll(() => service.calls.filter(c => c.method === 'GET' && c.path.startsWith('/v1/recognitions/')).length).toBeGreaterThan(before); expect(service.generated()).toHaveLength(0);
  let confirmations = 0; page.on('dialog', async dialog => { confirmations++; await dialog.accept(); });
  await page.locator('#draft-detail-dialog').getByRole('button', { name: '重新识别', exact: true }).click(); await expect.poll(() => service.generated().length).toBe(1);
  expect(confirmations).toBe(1); expect(service.generated()[0].body?.clientRequestId).not.toBe('draft-editor-original-request'); expect((await current(page, ids)).drafts).toHaveLength(2); expect((await draft(page, ids)).latex).toBe('\\int x^2\\,dx');
});

test('clipboard failure shows selectable text and never reports a fake successful copy', async ({ page, context }) => {
  await fixture(page, context); const ids = await seed(page); await openOwner(page, ids); await openDraft(page, ids);
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new DOMException('clipboard unavailable', 'NotAllowedError'); } } }));
  await page.locator('#draft-detail-dialog').getByRole('button', { name: '复制 LaTeX', exact: true }).click(); await expect(page.locator('#draft-copy-fallback')).toBeVisible();
  await expect(page.getByLabel('可复制草稿内容', { exact: true })).toHaveValue('\\int x^2\\,dx'); await expect(page.locator('#draft-copy-fallback')).toContainText('未写入系统剪贴板');
  await expect(page.locator('#toast')).not.toContainText('已复制');
});

test('soft-delete, restore and permanent draft deletion retain already inserted independent content and its snapshot references', async ({ page, context }) => {
  await fixture(page, context); const ids = await seed(page); await openOwner(page, ids); await place(page, ids, 160, 140);
  await expect.poll(async () => (await current(page, ids)).placements.length).toBe(1); await openDraft(page, ids);
  await page.locator('#draft-detail-dialog').getByRole('button', { name: '移入回收区', exact: true }).click(); await expect(page.locator('#draft-detail-dialog')).not.toBeVisible();
  await page.getByRole('button', { name: '草稿回收区', exact: true }).click(); await page.locator('.draft-item[data-draft-id="' + ids.draftId + '"]').click();
  await expect(page.locator('#draft-detail-dialog').getByRole('button', { name: '插入当前页', exact: true })).not.toBeVisible();
  await page.locator('#draft-detail-dialog').getByRole('button', { name: '恢复草稿', exact: true }).click(); await expect.poll(async () => (await draft(page, ids)).deletedAt).toBeUndefined();
  await page.locator('#draft-detail-dialog').getByRole('button', { name: '移入回收区', exact: true }).click();
  await page.locator('.draft-item[data-draft-id="' + ids.draftId + '"]').click(); page.once('dialog', dialog => dialog.accept()); await page.locator('#draft-detail-dialog').getByRole('button', { name: '永久删除', exact: true }).click();
  await expect.poll(async () => (await current(page, ids)).drafts.length).toBe(0); const saved = await current(page, ids);
  expect(saved.placements).toHaveLength(1); expect(saved.placements[0].latex).toBe('\\int x^2\\,dx'); expect(saved.formulas).toHaveLength(1); expect(Object.keys(saved.resources)).toHaveLength(1);
});

test('repeated insertion uses independent versions, double placement is idempotent and undo removes only one instance', async ({ page, context }) => {
  await fixture(page, context); const ids = await seed(page); await openOwner(page, ids); await place(page, ids, 130, 100, true);
  await expect.poll(async () => (await current(page, ids)).placements.length).toBe(1); await openDraft(page, ids); await page.locator('.dd-formula-edit summary').click(); await page.locator('#draft-latex-input').fill('x^3'); await closeDraft(page);
  await place(page, ids, 600, 350); await expect.poll(async () => (await current(page, ids)).placements.length).toBe(2);
  let saved = await current(page, ids); expect(saved.placements.map(p => p.latex)).toEqual(['\\int x^2\\,dx', 'x^3']); expect(new Set(saved.placements.map(p => p.operationId)).size).toBe(2);
  await openDraft(page, ids); await page.locator('#draft-latex-input').fill('x^4'); await closeDraft(page); saved = await current(page, ids); expect(saved.placements.map(p => p.latex)).toEqual(['\\int x^2\\,dx', 'x^3']);
  await page.locator('#undo').click(); await expect.poll(async () => (await current(page, ids)).placements.filter(p => !p.deletedAt).length).toBe(1);
  saved = await current(page, ids); expect(saved.drafts).toHaveLength(1); expect(saved.drafts[0].latex).toBe('x^4'); expect(saved.drafts[0].uses).toHaveLength(2); expect(saved.drafts[0].uses.filter(u => u.undoneAt)).toHaveLength(1);
});

test('storage failure keeps edited detail open, exports memory recovery and retries saving without requesting recognition', async ({ page, context }) => {
  const service = await fixture(page, context), ids = await seed(page); await openOwner(page, ids); await openDraft(page, ids); await page.locator('.dd-formula-edit summary').click();
  await page.evaluate(({ draftId }) => { const state = window as unknown as { failDraftPut?: boolean }; state.failDraftPut = true; const original = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function (value: any, ...args: any[]) { if (state.failDraftPut && this.name === 'notes' && value?.drafts?.some((d: any) => d.id === draftId && d.latex === 'x^{999}')) throw new DOMException('fixture storage full', 'QuotaExceededError'); return original.apply(this, [value, ...args] as [any, IDBValidKey?]); }; }, { draftId: ids.draftId });
  await page.locator('#draft-latex-input').fill('x^{999}'); await page.locator('#draft-detail-dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.locator('#draft-detail-dialog')).toBeVisible(); await expect(page.locator('#draft-save-state')).toContainText('尚未保存'); await expect(page.locator('#draft-latex-input')).toHaveValue('x^{999}'); expect((await draft(page, ids)).latex).toBe('\\int x^2\\,dx');
  const downloading = page.waitForEvent('download'); await page.getByRole('button', { name: '导出未保存修改', exact: true }).click(); const download = await downloading, recovery = JSON.parse(await readFile((await download.path())!, 'utf8')); expect(recovery.draft.latex).toBe('x^{999}');
  await page.evaluate(() => { (window as unknown as { failDraftPut?: boolean }).failDraftPut = false; }); await page.getByRole('button', { name: '重试保存修改', exact: true }).click(); await expect.poll(async () => (await draft(page, ids)).latex).toBe('x^{999}'); await closeDraft(page); expect(service.generated()).toHaveLength(0);
});

test('changed or deleted source keeps its historical snapshot and never jumps to another page with the same page number', async ({ page, context }) => {
  await fixture(page, context); const ids = await seed(page, { extraPage: true });
  await page.evaluate(async ({ noteId, sourcePageId }) => { const path = '/src/notebook-repository.ts', { updateNote } = await import(path); await updateNote(noteId, (n: any) => { n.pages.find((p: any) => p.id === sourcePageId).revision++; }); }, ids);
  await openOwner(page, ids); await openDraft(page, ids); await expect(page.locator('.dd-source')).toContainText('原稿已修改'); await expect(page.locator('.dd-source img')).toHaveAttribute('src', ids.imageUrl);
  page.once('dialog', dialog => dialog.dismiss()); await page.locator('#draft-detail-dialog').getByRole('button', { name: '插入当前页', exact: true }).click(); await expect(page.locator('#placement-bar')).not.toBeVisible(); expect((await current(page, ids)).placements).toHaveLength(0);
  await page.locator('#pages-open').click(); await page.locator('.page-item').first().getByRole('button', { name: '页菜单', exact: true }).click(); await page.getByRole('button', { name: '删除这一页', exact: true }).click();
  await openDraft(page, ids); await expect(page.locator('.dd-source')).toContainText('来源页已删除'); await expect(page.locator('.dd-source').getByRole('button', { name: '返回原稿', exact: true })).toBeDisabled(); await expect(page.locator('.dd-source img')).toHaveAttribute('src', ids.imageUrl);
  const saved = await current(page, ids); expect(saved.currentPageId).not.toBe(ids.sourcePageId); expect(saved.drafts[0].sourcePageId).toBe(ids.sourcePageId); expect(Object.keys(saved.resources)).toHaveLength(1);
});
