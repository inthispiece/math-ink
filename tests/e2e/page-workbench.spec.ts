import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { quotaState } from './fixtures/ocr-state';
import type { Note } from '../../apps/web/src/model';
type Input = {
    blocks?: {
        id: string;
        version: number;
        kind: string;
        text?: string;
        latex?: string;
    }[];
    pageId: string;
    contentRevision: number;
};
type Request = {
    clientRequestId: string;
    provider: string;
    sourceRevision: number;
    type: string;
    input: Input;
};
async function fixtures(page: Page, result: (body: Request) => unknown) {
    const bodies: Request[] = [];
    const tasks = new Map<string, Request>();
    await page.route('**/v1/status**', route => { const provider = new URL(route.request().url()).searchParams.get('provider') || 'deepseek'; return route.fulfill({ json: { status: 'ok', provider, simulated: false, configured: true, local: provider === 'ollama', authMode: 'local', capabilities: { transcribe: true, review: true }, taskCapabilities: Object.fromEntries(['page-transcribe', 'context-review', 'organize', 'knowledge-links', 'proof-assist'].map(x => [x, provider === 'deepseek'])) } }); });
    await page.route('**/v1/usage?**', route => route.fulfill({ json: quotaState() }));
    await page.route('**/v1/tasks', route => { const body = route.request().postDataJSON() as Request; bodies.push(body); const taskId = `fixture-${bodies.length}`; tasks.set(taskId, body); return route.fulfill({ status: 202, json: { status: 'pending', taskId, provider: body.provider, model: 'fixture-not-a-model', type: body.type, sourceRevision: body.sourceRevision } }); });
    await page.route('**/v1/tasks/*?**', route => { const taskId = new URL(route.request().url()).pathname.split('/').pop()!; const body = tasks.get(taskId); return route.fulfill({ json: { status: 'ok', taskId, type: body?.type, provider: 'deepseek', model: 'fixture-not-a-model', sourceRevision: body?.sourceRevision, contentRevision: body?.input.contentRevision, result: body ? result(body) : null, usage: { inputTokens: 10, outputTokens: 20 } } }); });
    return bodies;
}
const pageResult = { blocks: [{ id: 'b1', kind: 'paragraph', segments: [{ type: 'text', text: '设实数 ' }, { type: 'math', latex: 'x>0' }, { type: 'text', text: '，考虑积分。' }], bbox: { x: 0, y: 0, width: 1, height: .4 }, uncertainties: [] }, { id: 'b2', kind: 'formula', latex: '\\int x^2\\,dx', bbox: { x: 0, y: .5, width: 1, height: .5 }, uncertainties: ['上标需人工核对'] }], warnings: [] };
async function open(page: Page) { await page.goto('/'); await expect(page.locator('#save-state')).toHaveText('已保存到本机'); }
async function ink(page: Page) { const box = await page.locator('#ink-canvas').boundingBox(); if (!box)
    throw new Error('canvas'); await page.mouse.move(box.x + 80, box.y + 100); await page.mouse.down(); await page.mouse.move(box.x + 200, box.y + 160, { steps: 12 }); await page.mouse.up(); await expect(page.locator('#stroke-count')).toHaveText('1 笔'); }
async function workbench(page: Page) { await page.locator('#page-workbench-open').click(); await expect(page.locator('#page-workbench')).toBeVisible(); }
async function submit(page: Page, id: string) { await page.locator(`#${id}`).click(); await expect(page.locator('#page-consent-dialog')).toBeVisible(); await page.locator('#page-consent-allow').click(); await expect(page.locator('#page-task-list')).toContainText('completed'); }
async function addParagraph(page: Page, text: string) { await page.locator('#add-paragraph').click(); const card = page.locator('.content-block').last(); await card.locator('textarea').fill(text); await card.getByRole('button', { name: '保存内容', exact: true }).click(); }
async function savedNote(page:Page):Promise<Note>{return page.evaluate(()=>new Promise<Note>((resolve,reject)=>{const open=indexedDB.open('math-ink-notebooks');open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result,read=db.transaction('notes','readonly').objectStore('notes').getAll();read.onerror=()=>reject(read.error);read.onsuccess=()=>{db.close();resolve(read.result[0]);};};}));}
const inlinePage={blocks:[{id:'inline',kind:'paragraph',segments:[{type:'text',text:'条件 '},{type:'math',latex:'x>0'},{type:'text',text:'，以及 '},{type:'math',latex:'y^2'},{type:'text',text:'。'}],bbox:{x:0,y:0,width:1,height:1},uncertainties:[]}],warnings:[]};
async function inlineDraft(page:Page){await open(page);await ink(page);await workbench(page);await submit(page,'page-transcribe');await expect(page.locator('.content-block')).toHaveCount(1);await expect(page.locator('.content-block .katex')).toHaveCount(2);await expect.poll(async()=>(await savedNote(page)).tasks![0].status).toBe('completed');return savedNote(page);}
test('whole-page draft needs independent consent, preserves ordered inline math and source, and survives reload and export', async ({ page }) => {
    const bodies = await fixtures(page, () => pageResult);
    await open(page);
    await ink(page);
    const canvasBox = await page.locator('#ink-canvas').boundingBox();
    if (!canvasBox)
        throw new Error('canvas');
    await page.mouse.move(canvasBox.x + 100, canvasBox.y + 100);
    await page.mouse.wheel(1700, 0);
    await page.mouse.down();
    await page.mouse.move(canvasBox.x + 220, canvasBox.y + 150, { steps: 10 });
    await page.mouse.up();
    await expect(page.locator('#stroke-count')).toHaveText('2 笔');
    await workbench(page);
    await page.locator('#page-transcribe').click();
    await expect(page.locator('#page-consent-description')).toContainText('当前完整页');
    expect(bodies).toHaveLength(0);
    await page.locator('#page-consent-allow').click();
    await expect(page.locator('.content-block')).toHaveCount(2);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].type).toBe('page-transcribe');
    expect(bodies[0].input).toHaveProperty('imageBase64');
    expect(bodies[0].input).not.toHaveProperty('blocks');
    const png = Buffer.from((bodies[0].input as unknown as {
        imageBase64: string;
    }).imageBase64, 'base64');
    expect(png.readUInt32BE(16)).toBeGreaterThan(canvasBox.width);
    await expect(page.locator('.content-block').first()).toContainText('设实数');
    await expect(page.locator('.content-block').first().locator('.katex')).toHaveCount(1);
    await expect(page.locator('#page-source-image')).toBeVisible();
    await expect(page.locator('.content-block').first()).toContainText('待核对');
    await page.reload();
    await workbench(page);
    await expect(page.locator('.content-block')).toHaveCount(2);
    expect(bodies).toHaveLength(1);
    await page.locator('#export-open').click();
    const download = page.waitForEvent('download');
    await page.locator('#export-markdown').click();
    const path = await (await download).path();
    const text = await readFile(path!, 'utf8');
    expect(text.indexOf('设实数')).toBeLessThan(text.indexOf('\\int'));
    expect(text).toContain('$x>0$');
    expect(text).toContain('来源');
    await page.locator('[data-close="export-dialog"]').click();
    await page.locator('.content-block').first().getByRole('button', { name: '返回此块原稿' }).click();
    await expect(page.locator('#ink-editor')).toBeVisible();
    await expect(page.locator('#stroke-count')).toHaveText('2 笔');
});
test('context suggestions are scoped, explicit, undoable and stale after target editing', async ({ page }) => {
    const bodies = await fixtures(page, body => { const b = body.input.blocks![0]; return { summary: '检查建议', suggestions: [{ id: 's1', type: 'missing-condition', blockId: b.id, expectedVersion: b.version, before: b.text, after: '补充条件待核对', reason: '原稿可能缺少条件，不能直接认定结论成立。', evidence: [{ blockId: b.id, version: b.version, quote: b.text }] }] }; });
    await open(page);
    await workbench(page);
    await addParagraph(page, '原命题条件');
    await submit(page, 'context-check');
    expect(bodies[0].input.blocks).toHaveLength(1);
    await expect(page.locator('.suggestion-card')).toContainText('缺少条件');
    await expect(page.locator('.content-block textarea')).toHaveValue('原命题条件');
    await page.getByRole('button', { name: '采用此建议', exact: true }).click();
    await expect(page.locator('.content-block textarea')).toHaveValue('补充条件待核对');
    await page.getByRole('button', { name: '撤销采用', exact: true }).click();
    await expect(page.locator('.content-block textarea')).toHaveValue('原命题条件');
    await submit(page, 'context-check');
    await page.locator('.content-block textarea').fill('人工新编辑');
    await page.locator('.content-block').getByRole('button', { name: '保存内容', exact: true }).click();
    await expect(page.getByRole('button', { name: '采用此建议', exact: true })).toBeDisabled();
    await expect(page.locator('#suggestion-list')).toContainText('已过期');
    await expect(page.locator('.content-block textarea')).toHaveValue('人工新编辑');
});
test('failed task recovery never automatically creates another paid request; redo needs a separate confirmation and identity', async ({ page }) => {
    const bodies = await fixtures(page, () => pageResult);
    await page.route('**/v1/tasks/*?**', route => { const taskId = new URL(route.request().url()).pathname.split('/').pop(); return route.fulfill({ json: { taskId, provider: 'deepseek', model: 'fixture', type: 'page-transcribe', status: 'result-unavailable', error: { message: '服务重启后结果正文不可用' } } }); });
    await open(page);
    await ink(page);
    await workbench(page);
    await page.locator('#page-transcribe').click();
    await page.locator('#page-consent-allow').click();
    await expect(page.locator('#page-task-list')).toContainText('unknown');
    expect(bodies).toHaveLength(1);
    await page.reload();
    await workbench(page);
    await page.waitForTimeout(350);
    expect(bodies).toHaveLength(1);
    await page.getByRole('button', { name: '查询原任务（不重新生成）' }).click();
    await expect(page.locator('#page-task-list')).toContainText('正文不可用');
    expect(bodies).toHaveLength(1);
    await page.getByRole('button', { name: '明确重做（可能再次计费）' }).click();
    await expect(page.locator('#page-consent-dialog')).toContainText('可能再次计费');
    expect(bodies).toHaveLength(1);
    await page.locator('#page-consent-allow').click();
    await expect.poll(() => bodies.length).toBe(2);
    expect(bodies[0].clientRequestId).not.toBe(bodies[1].clientRequestId);
});
test('local Qwen extra tasks stay disabled while manual blocks, inline math, split and merge remain available', async ({ page }) => {
    const bodies = await fixtures(page, () => pageResult);
    await open(page);
    await page.locator('#settings-open').click();
    await page.locator('#ocr-provider').selectOption('ollama');
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await workbench(page);
    await expect(page.locator('#page-transcribe')).toBeDisabled();
    await expect(page.locator('#context-check')).toBeDisabled();
    await expect(page.locator('#page-capability')).toContainText('不会自动切换云端');
    await addParagraph(page, '条件 $p>1$，由 Hölder 不等式得到结论。');
    await expect(page.locator('.content-block')).toHaveCount(1);
    await expect(page.locator('.content-block .katex')).toHaveCount(1);
    const input = page.locator('.content-block textarea');
    await input.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(9, 9));
    await page.getByRole('button', { name: '在光标处分块' }).click();
    await expect(page.locator('.content-block')).toHaveCount(2);
    await page.getByRole('button', { name: '与下一段合并' }).click();
    await expect(page.locator('.content-block')).toHaveCount(1);
    expect(bodies).toHaveLength(0);
});
test('organization creates a separate draft while preserving formulas and original conditions', async ({ page }) => {
    await fixtures(page, () => ({ title: '积分笔记', outline: [], summary: '简要摘要', newExplanations: ['这是新增解释，需核对。'] }));
    await open(page);
    await workbench(page);
    await addParagraph(page, '原始假设：x > 0 且 p > 1');
    await submit(page, 'organize-page');
    await expect(page.locator('#page-task-list')).toContainText('简要摘要');
    await expect(page.locator('#note-count')).toHaveText('1');
    await page.getByRole('button', { name: '采用为新整理草稿（保留本篇）' }).click();
    await expect(page.locator('#note-count')).toHaveText('2');
    await expect(page.locator('#note-title')).toHaveValue('积分笔记（整理草稿）');
    await expect(page.locator('#page-block-list')).toContainText('原始假设：x > 0 且 p > 1');
    await expect(page.locator('#page-block-list')).toContainText('AI 摘要建议，不替代原文');
});
test('manual links use live local search and mark changed targets; proof assistance stays explicitly unverified', async ({ page }) => {
    await fixtures(page, () => ({ domain: 'calculus', goal: '求下一步', assumptions: ['x>0'], existingSteps: [], nextSteps: ['考虑导数的符号'], unresolved: ['需验证定义域'], verification: 'unverified' }));
    await open(page);
    await workbench(page);
    await addParagraph(page, '引用起点');
    await addParagraph(page, 'Hölder 条件 p>1');
    await page.locator('.content-block').first().getByRole('button', { name: /1\. 段落/ }).click();
    await page.locator('#knowledge-search').fill('Hölder');
    await page.getByRole('button', { name: '将当前块手工链接到此处' }).click();
    await expect(page.locator('#knowledge-links')).toContainText('来源有效');
    await page.locator('.content-block').nth(1).locator('textarea').fill('Hölder 条件 p>1 已修改');
    await page.locator('.content-block').nth(1).getByRole('button', { name: '保存内容', exact: true }).click();
    await expect(page.locator('#knowledge-links')).toContainText('目标已变化');
    await page.locator('#proof-goal').fill('求下一步');
    await submit(page, 'proof-assist');
    await expect(page.locator('#page-task-list')).toContainText('未验证的步骤建议');
    await expect(page.locator('#page-block-list')).not.toContainText('考虑导数的符号');
    await page.getByRole('button', { name: '采用步骤 1 为草稿（未验证）' }).click();
    await expect(page.locator('#page-block-list')).toContainText('AI 步骤建议，未验证');
});
test('hosted login uses a tab-scoped session, account requests and an explicit origin migration guide', async ({ page }) => {
    const bodies = await fixtures(page, body => ({ summary: '无修改', suggestions: [] }));
    await page.route('**/v1/status**', route => route.fulfill({ json: { status: 'ok', provider: 'deepseek', simulated: false, configured: true, authMode: 'hosted', capabilities: { transcribe: true, review: true }, taskCapabilities: { 'page-transcribe': true, 'context-review': true, organize: true, 'knowledge-links': true, 'proof-assist': true } } }));
    await page.route('**/v1/auth/login', route => route.fulfill({ json: { status: 'ok', sessionToken: 'fixture-session-secret', expiresAt: '2099-01-01', user: { id: 'u1', username: 'student' } } }));
    await page.route('**/v1/auth/me', route => route.fulfill({ json: { status: 'ok', user: { id: 'u1', username: 'student' } } }));
    let revoked = 0;
    await page.route('**/v1/auth/logout', route => { expect(route.request().headers().authorization).toBe('Bearer fixture-session-secret'); revoked++; return route.fulfill({ json: { status: 'ok' } }); });
    await open(page);
    await page.locator('#settings-open').click();
    await expect(page.locator('#hosted-login')).toBeVisible();
    await page.locator('#account-username').fill('student');
    await page.locator('#account-password').fill('fixture-password');
    await page.locator('#account-login').click();
    await expect(page.locator('#hosted-state')).toContainText('已登录 student');
    expect(await page.evaluate(() => localStorage.getItem('math-ink-settings'))).not.toContain('fixture-session-secret');
    await page.locator('#migration-open').click();
    await expect(page.locator('#migration-dialog')).toContainText('各自保存笔记');
    await page.locator('#migration-close').click();
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await workbench(page);
    await addParagraph(page, '账号范围内待检查内容');
    const posted = page.waitForRequest(r => new URL(r.url()).pathname === '/v1/tasks');
    await submit(page, 'context-check');
    expect((await posted).headers().authorization).toBe('Bearer fixture-session-secret');
    expect(bodies).toHaveLength(1);
    await page.locator('#settings-open').click();
    await page.locator('#account-logout').click();
    await expect.poll(() => revoked).toBe(1);
    await expect(page.locator('#hosted-state')).toContainText('请登录');
});
test('cancelled page tasks preserve ink, keep task identity and never restart on reload', async ({ page }) => {
    const bodies = await fixtures(page, () => pageResult);
    let cancelled = 0;
    await page.route('**/v1/tasks/*/cancel?**', route => { cancelled++; return route.fulfill({ json: { status: 'ok' } }); });
    await page.route('**/v1/tasks/*?**', route => { const url = new URL(route.request().url()); if (url.pathname.endsWith('/cancel')) {
        cancelled++;
        return route.fulfill({ json: { status: 'ok' } });
    } return route.fulfill({ json: { status: 'running', taskId: url.pathname.split('/').pop(), provider: 'deepseek', model: 'fixture', type: 'page-transcribe' } }); });
    await open(page);
    await ink(page);
    await workbench(page);
    await page.locator('#page-transcribe').click();
    await page.locator('#page-consent-allow').click();
    await expect(page.locator('#page-task-list')).toContainText('running');
    await page.getByRole('button', { name: '取消等待并尝试停止任务' }).click();
    await expect.poll(() => cancelled).toBe(1);
    await expect(page.locator('#page-task-list')).toContainText('cancelled');
    expect(bodies).toHaveLength(1);
    await page.reload();
    await expect(page.locator('#stroke-count')).toHaveText('1 笔');
    await workbench(page);
    await expect(page.locator('#page-task-list')).toContainText('cancelled');
    expect(bodies).toHaveLength(1);
    await expect(page.locator('.content-block')).toHaveCount(0);
});
test('polynomial verification is a separate exact local tool and never relabels AI proof suggestions', async ({ page }) => {
    const bodies = await fixtures(page, () => pageResult);
    await open(page);
    await workbench(page);
    await page.locator('#polynomial-check').click();
    await expect(page.locator('#polynomial-result')).toContainText('disproved');
    await page.locator('#polynomial-right').fill('x^3/3+C');
    await page.locator('#polynomial-check').click();
    await expect(page.locator('#polynomial-result')).toContainText('verified');
    await expect(page.locator('#polynomial-result')).toContainText('不验证其他 AI 建议');
    await page.locator('#polynomial-kind').selectOption('identity');
    await page.locator('#polynomial-left').fill('(x+1)^2');
    await page.locator('#polynomial-right').fill('x^2+2*x+1');
    await page.locator('#polynomial-check').click();
    await expect(page.locator('#polynomial-result')).toContainText('verified');
    expect(bodies).toHaveLength(0);
    await expect(page.locator('.content-block')).toHaveCount(0);
});

test('mixed-page heading, list and image regions preserve structure, uncertainty and original pixels',async({page},testInfo)=>{
  await fixtures(page,()=>({blocks:[{id:'h',kind:'heading',segments:[{type:'text',text:'Hölder 不等式'}],bbox:{x:0,y:0,width:1,height:.2},uncertainties:[]},{id:'l',kind:'list-item',segments:[{type:'text',text:'条件 p>1'}],bbox:{x:0,y:.2,width:1,height:.3},uncertainties:['条件可能缺漏']},{id:'im',kind:'image-region',bbox:{x:0,y:.5,width:.25,height:.5},uncertainties:['图形证明需手工处理']}],warnings:['复杂图形已保留原图区域']}));await open(page);await ink(page);await workbench(page);await submit(page,'page-transcribe');await expect(page.locator('.content-block')).toHaveCount(3);await expect(page.locator('.content-block').nth(1)).toContainText('条件可能缺漏');await expect(page.locator('#page-task-list')).toContainText('复杂图形已保留原图区域');const originalWidth=await page.locator('#page-source-image').evaluate((im:HTMLImageElement)=>im.naturalWidth);const region=page.locator('.content-block').last().locator('img');await expect(region).toBeVisible();const croppedWidth=await region.evaluate((im:HTMLImageElement)=>im.naturalWidth);expect(croppedWidth).toBeLessThan(originalWidth/2);await expect(page.locator('.content-block').first().getByRole('combobox',{name:'内容块 1 段落结构'})).toHaveValue('heading');await expect(page.locator('.content-block').nth(1).getByRole('combobox',{name:'内容块 2 段落结构'})).toHaveValue('list-item');await page.screenshot({path:testInfo.outputPath('mixed-page-workbench.png'),fullPage:true,animations:'disabled'});
});

test('shared-context suggestions batch only checked valid targets and preserve unselected content',async({page})=>{
  await fixtures(page,body=>({summary:'fixture 检查',suggestions:body.input.blocks!.map((b,i)=>({id:`s${i}`,type:'language',blockId:b.id,expectedVersion:b.version,before:b.text,after:`建议 ${i+1}`,reason:'fixture 用于验收显式应用流程',evidence:[{blockId:b.id,version:b.version,quote:b.text}]}))}));await open(page);await workbench(page);await addParagraph(page,'段落一');await addParagraph(page,'段落二');await page.locator('#context-scope').selectOption('page');await submit(page,'context-check');await expect(page.locator('.suggestion-card')).toHaveCount(2);await page.getByRole('checkbox',{name:'勾选此修改建议'}).nth(0).check();await page.getByRole('checkbox',{name:'勾选此修改建议'}).nth(1).check();await page.locator('#apply-checked').click();await expect(page.locator('.content-block').nth(0).locator('textarea')).toHaveValue('建议 1');await expect(page.locator('.content-block').nth(1).locator('textarea')).toHaveValue('建议 2');
});

test('conflicting backup IDs require a current backup and explicit overwrite; cancelling keeps the edited note',async({page})=>{
  await fixtures(page,()=>pageResult);await open(page);await page.locator('#note-title').fill('备份中的旧标题');await page.locator('#export-open').click();const download=page.waitForEvent('download');await page.locator('#export-backup').click();const path=await(await download).path();await page.locator('[data-close="export-dialog"]').click();await page.locator('#note-title').fill('设备上的新标题');await expect(page.locator('#save-state')).toHaveText('已保存到本机');await page.locator('#restore-file').setInputFiles(path!);await expect(page.locator('#restore-conflict-dialog')).toBeVisible();await expect(page.locator('#restore-conflict-apply')).toBeDisabled();await page.locator('#restore-conflict-cancel').click();await expect(page.locator('#note-title')).toHaveValue('设备上的新标题');await page.locator('#restore-file').setInputFiles(path!);await page.locator('#restore-conflict-backup').click();await page.locator('#restore-conflict-confirm').check();await page.locator('#restore-conflict-apply').click();await expect(page.locator('#note-title')).toHaveValue('备份中的旧标题');await expect(page.locator('#note-count')).toHaveText('1');
});

test('unchanged inline formula saves preserve canonical identities, sources and revisions; text edits reuse both formulas',async({page})=>{
  await fixtures(page,()=>inlinePage);const before=await inlineDraft(page);expect(before.formulas).toHaveLength(2);expect(before.formulas.every(f=>!!f.sourceRefId)).toBe(true);
  for(let i=0;i<3;i++)await page.locator('.content-block').getByRole('button',{name:'保存内容',exact:true}).click();
  const unchanged=await savedNote(page);expect(unchanged.formulas).toEqual(before.formulas);expect(unchanged.contentRevision).toBe(before.contentRevision);expect(unchanged.blocks![0].revision).toBe(before.blocks![0].revision);expect(unchanged.blocks![0].sourceRefIds).toEqual(before.blocks![0].sourceRefIds);
  const edit=page.locator('.content-block textarea');await edit.fill('补充条件：'+await edit.inputValue());await page.locator('.content-block').getByRole('button',{name:'保存内容',exact:true}).click();await expect.poll(async()=>(await savedNote(page)).contentRevision).toBeGreaterThan(before.contentRevision!);const after=await savedNote(page);expect(after.formulas).toEqual(before.formulas);expect(after.blocks![0].content.runs!.filter(r=>r.type==='formula')).toEqual(before.blocks![0].content.runs!.filter(r=>r.type==='formula'));await expect(page.locator('#formula-count')).toHaveText('2 公式');
});

test('splitting between inline formulas and merging keeps both identities and sources, and splitting inside math is refused',async({page})=>{
  await fixtures(page,()=>inlinePage);const before=await inlineDraft(page);const first=page.locator('.content-block').first();const editor=first.locator('textarea');await editor.evaluate((el:HTMLTextAreaElement)=>el.setSelectionRange(el.value.indexOf('x>0')+1,el.value.indexOf('x>0')+1));await first.getByRole('button',{name:'在光标处分块'}).click();await expect(page.locator('#toast')).toContainText('公式之外');await expect(page.locator('.content-block')).toHaveCount(1);expect((await savedNote(page)).contentRevision).toBe(before.contentRevision);
  await editor.evaluate((el:HTMLTextAreaElement)=>el.setSelectionRange(el.value.indexOf('以及'),el.value.indexOf('以及')));await first.getByRole('button',{name:'在光标处分块'}).click();await expect(page.locator('.content-block')).toHaveCount(2);await expect(page.locator('.content-block').nth(0).locator('.katex')).toHaveCount(1);await expect(page.locator('.content-block').nth(1).locator('.katex')).toHaveCount(1);await expect.poll(async()=>(await savedNote(page)).blocks!.length).toBe(2);const split=await savedNote(page);expect(split.formulas).toEqual(before.formulas);expect(split.blocks!.map(b=>b.sourceRefIds)).toEqual([before.blocks![0].sourceRefIds,before.blocks![0].sourceRefIds]);
  await page.getByRole('button',{name:'与下一段合并'}).click();await expect(page.locator('.content-block')).toHaveCount(1);await expect.poll(async()=>(await savedNote(page)).blocks!.length).toBe(1);const merged=await savedNote(page);expect(merged.formulas).toEqual(before.formulas);expect(merged.blocks![0].sourceRefIds).toEqual(before.blocks![0].sourceRefIds);await page.reload();await workbench(page);await expect(page.locator('.content-block .katex')).toHaveCount(2);expect((await savedNote(page)).formulas).toEqual(before.formulas);
});

test('context text and inline math suggestions preview without mutation, apply and undo atomically; inserting or deleting math requires manual editing',async({page})=>{
  let mode:'text'|'math'|'insert'|'delete'='text';await fixtures(page,body=>{if(body.type==='page-transcribe')return inlinePage;const b=body.input.blocks![0];const after=mode==='math'?b.text!.replace('$x>0$','$x\\ge0$'):mode==='insert'?`${b.text} 新增 $z>1$`:mode==='delete'?b.text!.replace('，以及 $y^2$',''):b.text!.replace('条件','已知条件');return{summary:'fixture 检查',suggestions:[{id:'inline-suggestion',type:'language',blockId:b.id,expectedVersion:b.version,before:b.text,after,reason:'检查显式文本建议与公式保护流程',evidence:[{blockId:b.id,version:b.version,quote:b.text}]}]};});
  const before=await inlineDraft(page);await submit(page,'context-check');await expect(page.getByRole('button',{name:'采用此建议',exact:true})).toBeVisible();const preview=await savedNote(page);expect(preview.formulas).toEqual(before.formulas);expect(preview.blocks).toEqual(before.blocks);expect(preview.contentRevision).toBe(before.contentRevision);await page.getByRole('button',{name:'采用此建议',exact:true}).click();await expect(page.locator('.content-block textarea')).toHaveValue(/已知条件/);await expect(page.locator('.content-block .katex')).toHaveCount(2);expect((await savedNote(page)).formulas).toEqual(before.formulas);await page.getByRole('button',{name:'撤销采用',exact:true}).click();await expect(page.locator('.content-block textarea')).toHaveValue('条件 $x>0$，以及 $y^2$。');await expect(page.locator('.content-block .katex')).toHaveCount(2);
  mode='math';const beforeMath=await savedNote(page);await submit(page,'context-check');await expect(page.locator('#suggestion-list .suggestion-card').last().locator('pre').nth(0)).toContainText('$x>0$');await expect(page.locator('#suggestion-list .suggestion-card').last().locator('pre').nth(1)).toContainText('$x\\ge0$');const mathPreview=await savedNote(page);expect(mathPreview.formulas).toEqual(beforeMath.formulas);expect(mathPreview.blocks).toEqual(beforeMath.blocks);expect(mathPreview.contentRevision).toBe(beforeMath.contentRevision);
  await page.getByRole('button',{name:'采用此建议',exact:true}).click();await expect(page.locator('.content-block textarea')).toHaveValue('条件 $x\\ge0$，以及 $y^2$。');await expect(page.locator('.content-block .katex')).toHaveCount(2);const adopted=await savedNote(page);expect(adopted.formulas.map(f=>f.id)).toEqual(beforeMath.formulas.map(f=>f.id));expect(adopted.formulas.map(f=>f.sourceRefId)).toEqual(beforeMath.formulas.map(f=>f.sourceRefId));expect(adopted.formulas.map(f=>f.latex)).toEqual(['x\\ge0','y^2']);await page.getByRole('button',{name:'撤销采用',exact:true}).click();await expect(page.locator('.content-block textarea')).toHaveValue('条件 $x>0$，以及 $y^2$。');expect((await savedNote(page)).formulas).toEqual(beforeMath.formulas);
  for(const nextMode of ['insert','delete'] as const){mode=nextMode;const beforeRejected=await savedNote(page);await submit(page,'context-check');await expect(page.locator('#page-task-list')).toContainText('需要手工核对');await expect(page.locator('#page-task-list')).toContainText('原公式保持不变');await expect(page.getByRole('button',{name:'采用此建议',exact:true})).toHaveCount(0);const rejected=await savedNote(page);expect(rejected.formulas).toEqual(beforeRejected.formulas);expect(rejected.blocks).toEqual(beforeRejected.blocks);expect(rejected.contentRevision).toBe(beforeRejected.contentRevision);}
});
