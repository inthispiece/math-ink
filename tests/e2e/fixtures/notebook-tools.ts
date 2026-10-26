import { expect, type BrowserContext, type Page, type Route } from '@playwright/test';
import type { Notebook } from '../../../apps/web/src/notebook-domain.ts';

export const toolToken = 'mathink-tool-browser-fixture-2026';
export const hostedToken = 'mathink-hosted-browser-fixture-session';
export interface Call { method: string; path: string; origin: string; provider: string; body?: Record<string, any>; authorization?: string }
interface Remote { id: string; provider: string; type: string; body: Record<string, any>; ready: boolean }
export async function toolFixture(page: Page, context: BrowserContext, options: { provider?: string; hosted?: boolean; legacyConsent?: boolean; gateway?: string; allowPartialOrigin?: string; holdSelection?: boolean } = {}) {
  const calls: Call[] = [], remotes: Remote[] = [], held: { route: Route; remote: Remote }[] = []; let sequence = 0, revoked = false;
  await context.addInitScript(({ options, toolToken, hostedToken }) => {
    if (!localStorage.getItem('tool-fixture-initialized')) {
      const gateway = options.gateway || location.origin;
      localStorage.setItem('math-ink-settings', JSON.stringify({ gatewayUrl: gateway, pairingToken: toolToken, installationId: 'tools-browser-fixture', provider: options.provider || 'deepseek', cloudConsent: !!options.legacyConsent, cloudConsentProviders: options.legacyConsent ? ['mathpix'] : [], inkMode: 'experimental' }));
      if (options.hosted) sessionStorage.setItem('mathink-session:' + gateway, hostedToken);
      localStorage.setItem('tool-fixture-initialized', 'true');
    }
  }, { options, toolToken, hostedToken });
  const fulfill = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }, body: JSON.stringify(body) });
  function result(remote: Remote): unknown {
    const input = remote.body.input || {}, blocks = input.blocks || [], first = blocks[0], firstText = first?.text ?? first?.latex ?? '';
    if (remote.type === 'formula') return { provider: remote.provider, simulated: false, latex: '\\int x^2\\,dx', uncertainSymbols: [], reviewRequired: true };
    if (remote.type === 'context-review') return { summary: '请核对当前条件', suggestions: first ? [{ id: 'fixture-suggestion', type: 'language', blockId: first.id, expectedVersion: first.version, before: firstText, after: firstText + '（已核对）', reason: '只修改本次勾选范围', evidence: [{ blockId: first.id, version: first.version, quote: firstText }] }] : [] };
    if (remote.type === 'organize') return { title: '整理后的数学草稿', outline: blocks.map((b: any) => ({ blockId: b.id, level: 1, category: b.kind === 'formula' ? 'theorem' : 'text' })), summary: '原始条件和公式完整保留', newExplanations: ['这是一条模型新增说明'] };
    if (remote.type === 'knowledge-links') { const candidate = input.candidates?.[0]; return { links: first && candidate ? [{ fromBlockId: first.id, toBlockId: candidate.id, relation: 'theorem', reason: '所选笔记提供了相关定理', evidence: [{ blockId: first.id, version: first.version, quote: firstText }, { blockId: candidate.id, version: candidate.version, quote: candidate.text || candidate.latex }] }] : [] }; }
    if (remote.type === 'proof-assist') return { domain: input.domain, goal: input.goal, assumptions: input.assumptions || [], existingSteps: input.steps || [], nextSteps: ['先核对假设，再对候选原函数求导'], unresolved: ['尚未核验全部步骤'], verification: 'unverified' };
    return { blocks: [{ id: 'fixture-page-block', kind: 'formula', latex: 'x^2', bbox: { x: 0, y: 0, width: 1, height: 1 }, uncertainties: [] }], warnings: [] };
  }
  const complete = (route: Route, remote: Remote) => fulfill(route, 200, { taskId: remote.id, provider: remote.provider, type: remote.type, status: 'ok', sourceRevision: remote.body.sourceRevision || 0, result: result(remote), usage: { inputTokens: 10, outputTokens: 12 }, cost: { status: 'unknown', amount: null, reserved: .5, currency: 'CNY' } });
  await context.route('**/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method(), body = request.postDataJSON() as Record<string, any> | null;
    const provider = String(body?.provider || url.searchParams.get('provider') || options.provider || 'deepseek');
    calls.push({ method, path, origin: url.origin, provider, body: body || undefined, authorization: request.headers().authorization });
    if (options.allowPartialOrigin === url.origin && method === 'GET' && path.startsWith('/v1/recognitions/')) return route.continue();
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' } });
    if (path === '/v1/status') return fulfill(route, 200, { status: 'ok', authMode: options.hosted ? 'hosted' : 'local', provider, simulated: false, configured: true, local: provider === 'ollama', model: 'fixture-not-real', requestTimeoutMs: provider === 'ollama' ? 180000 : 45000, protocolCapabilities: { recognitionTasks: true, recognitionLookup: true, taskLookup: true }, capabilities: { transcribe: true, review: provider !== 'mathpix' }, taskCapabilities: { 'page-transcribe': provider === 'deepseek', 'context-review': provider === 'deepseek', organize: provider === 'deepseek', 'knowledge-links': provider === 'deepseek', 'proof-assist': provider === 'deepseek' } });
    if (path === '/v1/local-pairing') return fulfill(route, 200, { status: 'ok', pairingToken: toolToken });
    if (path === '/v1/pairing') return fulfill(route, request.headers().authorization === 'Bearer ' + toolToken ? 200 : 401, { status: 'ok', paired: true });
    if (path === '/v1/provider-health') return fulfill(route, request.headers().authorization === 'Bearer ' + (options.hosted ? hostedToken : toolToken) ? 200 : 401, request.headers().authorization === 'Bearer ' + (options.hosted ? hostedToken : toolToken) ? { status: 'ok', ready: true, message: '当前后端连接通过，未生成内容', provider } : { status: 'error', error: { code: 'UNAUTHORIZED', message: '请填写正确的服务配对令牌' } });
    if (path === '/v1/usage') return fulfill(route, 200, { status: 'ok', provider, simulated: false });
    if (path === '/v1/auth/me') return fulfill(route, !revoked && request.headers().authorization === 'Bearer ' + hostedToken ? 200 : 401, !revoked ? { status: 'ok', user: { id: 'fixture-user', username: '测试用户' } } : { error: { code: 'UNAUTHORIZED', message: '会话已退出' } });
    if (path === '/v1/auth/logout') { revoked = true; return fulfill(route, 200, { status: 'ok' }); }
    if (path === '/v1/review' && method === 'POST') return fulfill(route, 200, { requestId: body?.clientRequestId, status: 'ok', provider, simulated: false, sourceRevision: body?.sourceRevision, originalLatex: body?.latex, review: { summary: '候选检查建议，尚待核对', issues: ['请核对积分常数与变量条件'], suggestedLatex: '\\frac{x^3}{3}+C' } });
    const base = path.startsWith('/v1/recognitions') ? '/v1/recognitions' : path.startsWith('/v1/tasks') ? '/v1/tasks' : '';
    if (base && path === base && method === 'POST') { const remote: Remote = { id: 'c0000000-0000-4000-8000-' + String(++sequence).padStart(12, '0'), provider, type: base === '/v1/recognitions' ? 'formula' : String(body?.type), body: body || {}, ready: true }; remotes.push(remote); return fulfill(route, 202, { taskId: remote.id, provider, status: 'running', sourceRevision: body?.sourceRevision || 0 }); }
    if (base && path.endsWith('/cancel') && method === 'POST') return fulfill(route, 200, { taskId: path.split('/').at(-2), provider, status: 'error', error: { code: 'RECOGNITION_CANCELLED', message: '已取消，费用仍需核对' } });
    if (base && method === 'GET') {
      const key = decodeURIComponent(path.slice(base.length + 1)); let remote = key.startsWith('by-request/') ? remotes.find(r => r.body.clientRequestId === key.slice(11)) : remotes.find(r => r.id === key);
      if (!remote && key === 'd0000000-0000-4000-8000-000000000001') remote = { id: key, provider, type: 'formula', body: { sourceRevision: 1 }, ready: true };
      if (!remote) return fulfill(route, 404, { error: { code: 'NOT_FOUND', message: '原任务未找到，不自动重发' } });
      if (options.holdSelection && remote.type === 'formula') { held.push({ route, remote }); return; }
      if (!remote.ready) return fulfill(route, 200, { taskId: remote.id, provider: remote.provider, status: 'running' });
      return complete(route, remote);
    }
    return fulfill(route, 500, { error: { code: 'FIXTURE_GUARD', message: '未允许此测试接口，禁止真实模型调用' } });
  });
  await page.goto('/'); await expect(page.locator('#library-view')).toBeVisible(); await expect(page.locator('#library-count')).not.toContainText('正在');
  return { calls, remotes, generated: () => calls.filter(c => c.method === 'POST' && ['/v1/recognize', '/v1/recognitions', '/v1/review', '/v1/tasks'].includes(c.path)), async releaseHeld() { for (const item of held.splice(0)) await complete(item.route, item.remote).catch(() => {}); } };
}
export async function notes(page: Page): Promise<Notebook[]> { return page.evaluate(() => new Promise((resolve, reject) => { const request = indexedDB.open('math-ink-notebooks'); request.onerror = () => reject(request.error); request.onsuccess = () => { const db = request.result, read = db.transaction('notes', 'readonly').objectStore('notes').getAll(); read.onsuccess = () => { db.close(); resolve(read.result); }; read.onerror = () => reject(read.error); }; })); }
export async function seedToolNotes(page: Page, options: { formulaDraft?: boolean; pendingTask?: boolean; hosted?: boolean; gateway?: string; formal?: boolean; candidates?: boolean } = {}) {
  return page.evaluate(async options => {
    const mp = '/src/model.ts', dp = '/src/notebook-domain.ts', rp = '/src/notebook-repository.ts', pp = '/src/page-model.ts', sp = '/src/source-copy.ts';
    const m = await import(mp), d = await import(dp), r = await import(rp), p = await import(pp), hash = await import(sp);
    const n = d.ensureNotebook(m.newNote()); n.title = '数学工具原笔记'; const sourcePage = d.currentPage(n); d.commitPageInk(n, [{ id: 'tool-ink', color: '#253d35', width: 3, points: [{ x: 50, y: 50, pressure: .5 }, { x: 130, y: 100, pressure: .5 }] }]);
    const source = p.createSourceRef(n, sourcePage.id, { x: 30, y: 30, width: 150, height: 100 }, ['tool-ink']); const canvas = document.createElement('canvas'); canvas.width = 200; canvas.height = 140; const ctx = canvas.getContext('2d')!; ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 200, 140); ctx.strokeStyle = '#253d35'; ctx.beginPath(); ctx.moveTo(50, 50); ctx.lineTo(130, 100); ctx.stroke(); const snapshot = d.addSnapshot(n, canvas.toDataURL('image/png'));
    let formalPageId = sourcePage.id, conditionId = '', formulaId = '', otherId = '';
    if (options.formal) {
      const page = d.addPage(n, { kind: 'typeset', paper: 'blank', title: '正式数学内容' }); formalPageId = page.id;
      const a = p.createParagraphBlock(n, '条件：x 为实数且 p > 1，不能遗漏。', page.id); conditionId = a.id;
      const b = p.createParagraphBlock(n, '这一段未被勾选时不可上传：PRIVATE_UNSELECTED_BLOCK', page.id); otherId = b.id;
      const f = { id: m.newId(), latex: '\\int x^2\\,dx', sourceStrokeIds: ['tool-ink'], sourceRevision: n.revision, sourceBounds: source.bounds, sourcePage: source.nativePageId, sourceRefId: source.id, inline: true, provider: 'manual', simulated: false, createdAt: new Date().toISOString() }; n.formulas.push(f); p.createFormulaBlock(n, f.id, page.id); formulaId = f.id; d.selectPage(n, page.id);
    }
    let draftId = '';
    if (options.formulaDraft || options.pendingTask) {
      const at = new Date().toISOString(), gateway = options.gateway || location.origin, principal = options.hosted ? 'user:fixture-user' : 'local:' + hash.manuscriptDigest('mathink-tool-browser-fixture-2026');
      const task = options.pendingTask ? { kind: 'formula', clientRequestId: 'tool-original-request', remoteId: 'd0000000-0000-4000-8000-000000000001', provider: 'deepseek', gateway, installationId: 'tools-browser-fixture', principal, phase: 'running', createdAt: at, updatedAt: at, sourceRevision: n.revision, request: {} } : undefined;
      if (task && !options.hosted) { const values = JSON.parse(localStorage.getItem('mathink-local-connections') || '{}'); values[gateway] = { [principal]: 'mathink-tool-browser-fixture-2026' }; localStorage.setItem('mathink-local-connections', JSON.stringify(values)); }
      const draft = d.createDraft(n, { type: 'formula', title: '原公式草稿', sourcePageId: sourcePage.id, sourceRevision: sourcePage.revision, source, snapshotIds: [snapshot], status: options.pendingTask ? 'running' : 'completed', version: options.pendingTask ? 0 : 1, ...(task ? { task, taskId: task.clientRequestId } : { latex: '\\int x^2\\,dx' }) }); draftId = draft.id;
    }
    await r.saveEditingNote(n);
    const candidates: { id: string; title: string; blockId: string }[] = [];
    if (options.candidates) for (const [title, text] of [['允许的定理笔记', 'ALLOWED_THEOREM_CONTENT'], ['不允许读取的笔记', 'PRIVATE_UNSELECTED_NOTE_SECRET']]) { const other = d.ensureNotebook(m.newNote()); other.title = title; const page = d.addPage(other, { kind: 'typeset', paper: 'blank' }); const block = p.createParagraphBlock(other, text, page.id); d.selectPage(other, page.id); await r.saveEditingNote(other); candidates.push({ id: other.id, title, blockId: block.id }); }
    return { noteId: n.id, title: n.title, draftId, sourcePageId: sourcePage.id, formalPageId, conditionId, formulaId, otherId, candidates };
  }, options);
}
export type ToolSeed = Awaited<ReturnType<typeof seedToolNotes>>;
export async function openToolOwner(page: Page, seed: ToolSeed) { await page.reload(); await expect(page.locator('#library-view')).toBeVisible(); await page.getByRole('button', { name: '打开 ' + seed.title, exact: true }).click(); await expect(page.locator('#editor-view')).toBeVisible(); }
export async function openToolDraft(page: Page, noteId: string, draftId: string) { if (!await page.locator('.draft-item[data-draft-id="' + draftId + '"]').isVisible()) await page.locator('#drafts-open').click(); await page.locator('.draft-item[data-draft-id="' + draftId + '"]').click(); await expect(page.locator('#draft-detail-dialog')).toBeVisible(); }
export async function settings(page: Page) { if (await page.locator('#editor-view').isVisible()) { await page.locator('#editor-more').click(); await page.getByRole('button', { name: '应用设置', exact: true }).click(); } else await page.locator('#library-settings').click(); await expect(page.locator('#settings-dialog')).toBeVisible(); await page.locator('#recognition-settings').evaluate((e: HTMLDetailsElement) => e.open = true); }
export async function chooseProvider(page: Page, provider: string, gateway?: string) { await settings(page); await page.locator('#ocr-provider').selectOption(provider); if (gateway) await page.locator('#gateway-url').fill(gateway); await page.getByRole('button', { name: '保存设置', exact: true }).click(); await expect(page.locator('#settings-dialog')).not.toBeVisible(); }
export async function advanced(page: Page, name: string) { await page.locator('#toolbox-open').click(); await page.locator('#panel-content').getByText('更多数学工具', { exact: true }).click(); await page.locator('#panel-content').getByRole('button', { name, exact: true }).click(); await expect(page.locator('#advanced-dialog')).toBeVisible(); }
export async function previewAdvanced(page: Page) { await page.locator('#advanced-dialog').getByRole('button', { name: '查看发送范围', exact: true }).click(); await expect(page.locator('#advanced-dialog .upload-scope-preview')).toBeVisible(); }
export async function sendAdvanced(page: Page, local = false) { await page.locator('#advanced-dialog').getByRole('button', { name: local ? '确认在本机检查' : '确认本次文字范围并发送', exact: true }).click(); await expect(page.locator('#advanced-dialog')).not.toBeVisible(); }
export async function completedDraft(page: Page, noteId: string, type: string) { await expect.poll(async () => (await notes(page)).find(n => n.id === noteId)!.drafts.filter(d => d.type === type && d.status === 'completed').length).toBeGreaterThan(0); return (await notes(page)).find(n => n.id === noteId)!.drafts.filter(d => d.type === type && d.status === 'completed').at(-1)!; }
