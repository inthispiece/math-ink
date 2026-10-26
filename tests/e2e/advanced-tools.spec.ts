import { test, expect } from '@playwright/test';
import { toolFixture, seedToolNotes, openToolOwner, openToolDraft, advanced, previewAdvanced, sendAdvanced, completedDraft, notes } from './fixtures/notebook-tools';

test('context review previews only selected blocks and adopting a suggestion edits its draft while canonical conditions and formulas stay intact', async ({ page, context }) => {
  const service = await toolFixture(page, context), seed = await seedToolNotes(page, { formal: true }); await openToolOwner(page, seed);
  const original = (await notes(page)).find(n => n.id === seed.noteId)!;
  await advanced(page, '上下文纠错'); await page.locator('.scope-block').filter({ hasText: 'PRIVATE_UNSELECTED_BLOCK' }).locator('input').uncheck();
  await previewAdvanced(page); const preview = page.locator('#advanced-dialog .upload-scope-preview');
  await expect(preview).toContainText('x 为实数且 p > 1'); await expect(preview).toContainText('\\int x^2\\,dx'); await expect(preview).not.toContainText('PRIVATE_UNSELECTED_BLOCK'); expect(service.generated()).toHaveLength(0);
  await sendAdvanced(page); const reviewed = await completedDraft(page, seed.noteId, 'review'), request = service.generated()[0];
  expect(request.path).toBe('/v1/tasks'); expect(request.body!.type).toBe('context-review'); expect(request.body!.input.blocks).toHaveLength(2); expect(JSON.stringify(request.body)).not.toContain('PRIVATE_UNSELECTED_BLOCK'); expect(request.body!.input).not.toHaveProperty('imageBase64');
  expect(reviewed.content!.suggestions).toHaveLength(1); expect(JSON.stringify(reviewed.content!.blocks)).not.toContain('（已核对）');
  await openToolDraft(page, seed.noteId, reviewed.id); await expect(page.locator('.dd-comparison')).toContainText('（已核对）');
  await page.getByRole('button', { name: '采用这条建议', exact: true }).click();
  await expect.poll(async () => JSON.stringify((await notes(page)).find(n => n.id === seed.noteId)!.drafts.find(d => d.id === reviewed.id)!.content!.blocks)).toContain('（已核对）');
  const saved = (await notes(page)).find(n => n.id === seed.noteId)!; expect(saved.blocks).toEqual(original.blocks); expect(saved.formulas).toEqual(original.formulas); expect(saved.pageOrder).toEqual(original.pageOrder); expect(service.generated()).toHaveLength(1);
});

test('organizing creates an editable shadow that retains every original condition and formula with AI additions labelled separately', async ({ page, context }) => {
  const service = await toolFixture(page, context), seed = await seedToolNotes(page, { formal: true }); await openToolOwner(page, seed);
  const original = (await notes(page)).find(n => n.id === seed.noteId)!;
  await advanced(page, '整理笔记'); await previewAdvanced(page); await expect(page.locator('.upload-scope-preview')).toContainText('x 为实数且 p > 1'); expect(service.generated()).toHaveLength(0);
  await sendAdvanced(page); const organized = await completedDraft(page, seed.noteId, 'organization'), request = service.generated()[0];
  expect(request.body!.type).toBe('organize'); expect(request.body!.input.blocks).toHaveLength(3);
  for (const originalBlock of original.blocks!) { const block = organized.content!.blocks!.find(b => b.id === originalBlock.id)!; expect(block).toBeDefined(); expect(block.type).toBe(originalBlock.type); expect(block.content).toEqual(originalBlock.content); expect(block.sourceRefIds).toEqual(originalBlock.sourceRefIds); } expect(organized.content!.formulas).toEqual(original.formulas);
  const shadow = JSON.stringify(organized.content!.blocks); expect(shadow).toContain('条件：x 为实数且 p > 1，不能遗漏。'); expect(shadow).toContain('PRIVATE_UNSELECTED_BLOCK'); expect(shadow).toContain('AI 摘要（非原文）'); expect(shadow).toContain('AI 新增说明（待核对）');
  const saved = (await notes(page)).find(n => n.id === seed.noteId)!; expect(saved.blocks).toEqual(original.blocks); expect(saved.formulas).toEqual(original.formulas); expect(saved.pageOrder).toEqual(original.pageOrder); expect((await notes(page))).toHaveLength(1);
  await openToolDraft(page, seed.noteId, organized.id); await expect(page.locator('#draft-block-list')).toContainText('AI 摘要（非原文）'); await expect(page.locator('#draft-block-list')).toContainText('AI 新增说明（待核对）'); await expect(page.getByRole('button', { name: '作为排版页加入笔记', exact: true })).toBeVisible(); expect(service.generated()).toHaveLength(1);
});

test('knowledge links send only explicitly allowed candidate notes and preserve cited reasons until a separate adoption', async ({ page, context }) => {
  const service = await toolFixture(page, context), seed = await seedToolNotes(page, { formal: true, candidates: true }); await openToolOwner(page, seed);
  const original = (await notes(page)).find(n => n.id === seed.noteId)!;
  await advanced(page, '知识关联'); await page.locator('#advanced-dialog').getByRole('button', { name: '查看发送范围', exact: true }).click();
  await expect(page.locator('.upload-scope-preview')).toHaveCount(0); expect(service.generated()).toHaveLength(0);
  await page.locator('input[name="candidate-note"][value="' + seed.candidates[0].id + '"]').check(); await previewAdvanced(page);
  await expect(page.locator('.upload-scope-preview')).toContainText('ALLOWED_THEOREM_CONTENT'); await expect(page.locator('.upload-scope-preview')).not.toContainText('PRIVATE_UNSELECTED_NOTE_SECRET'); expect(service.generated()).toHaveLength(0);
  await sendAdvanced(page); const linked = await completedDraft(page, seed.noteId, 'links'), request = service.generated()[0];
  expect(request.body!.type).toBe('knowledge-links'); expect(request.body!.input.candidates).toHaveLength(1); expect(request.body!.input.candidates[0].id).toBe(seed.candidates[0].blockId); expect(JSON.stringify(request.body)).not.toContain(seed.candidates[1].id); expect(JSON.stringify(request.body)).not.toContain('PRIVATE_UNSELECTED_NOTE_SECRET'); expect((await notes(page)).find(n => n.id === seed.noteId)!.links).toHaveLength(0);
  await openToolDraft(page, seed.noteId, linked.id); await expect(page.locator('.dd-links')).toContainText('所选笔记提供了相关定理'); await expect(page.locator('.dd-links blockquote')).toContainText(['条件：x 为实数且 p > 1，不能遗漏。', 'ALLOWED_THEOREM_CONTENT']);
  await page.getByRole('button', { name: '采用这条关联', exact: true }).click(); await expect.poll(async () => (await notes(page)).find(n => n.id === seed.noteId)!.links!.length).toBe(1);
  const saved = (await notes(page)).find(n => n.id === seed.noteId)!; expect(saved.links![0].targetNoteId).toBe(seed.candidates[0].id); expect(saved.blocks).toEqual(original.blocks); expect(saved.formulas).toEqual(original.formulas); expect(service.generated()).toHaveLength(1);
});

test('proof assistance sends the selected steps and assumptions then labels all suggested steps unverified without changing the formal note', async ({ page, context }) => {
  const service = await toolFixture(page, context), seed = await seedToolNotes(page, { formal: true }); await openToolOwner(page, seed);
  const original = (await notes(page)).find(n => n.id === seed.noteId)!;
  await advanced(page, '证明步骤辅助'); await page.locator('#proof-goal').fill('验证 x^3/3 是 x^2 的一个原函数'); await page.locator('#advanced-conditions').fill('x 为实数\np > 1'); await page.locator('#proof-domain').selectOption('calculus'); await previewAdvanced(page);
  await expect(page.locator('.upload-scope-preview')).toContainText('x 为实数'); await expect(page.locator('.upload-scope-preview')).toContainText('p > 1'); expect(service.generated()).toHaveLength(0);
  await sendAdvanced(page); const proof = await completedDraft(page, seed.noteId, 'proof'), request = service.generated()[0];
  expect(request.body!.type).toBe('proof-assist'); expect(request.body!.input.domain).toBe('calculus'); expect(request.body!.input.assumptions).toEqual(['x 为实数', 'p > 1']); expect(request.body!.input.steps).toHaveLength(3); expect(request.body!.input.steps).toContain('\\int x^2\\,dx'); expect((proof.result as { verification: string }).verification).toBe('unverified');
  await openToolDraft(page, seed.noteId, proof.id); await expect(page.locator('.dd-proof')).toContainText('证明步骤建议 · 未验证'); await expect(page.locator('.dd-proof')).toContainText('尚未核验全部步骤'); await expect(page.locator('.dd-proof')).not.toContainText('已证明');
  await page.locator('.dd-proof').getByRole('button', { name: '加入草稿', exact: true }).click();
  await expect.poll(async () => JSON.stringify((await notes(page)).find(n => n.id === seed.noteId)!.drafts.find(d => d.id === proof.id)!.content!.blocks)).toContain('AI 建议（未验证）：先核对假设');
  const saved = (await notes(page)).find(n => n.id === seed.noteId)!; expect(saved.blocks).toEqual(original.blocks); expect(saved.formulas).toEqual(original.formulas); expect(service.generated()).toHaveLength(1);
});

test('local polynomial checking distinguishes a wrong antiderivative, a verified one and unsupported mathematics without any service call', async ({ page, context }) => {
  const service = await toolFixture(page, context), seed = await seedToolNotes(page); await openToolOwner(page, seed); await advanced(page, '本地多项式核对');
  await page.getByRole('button', { name: '在本机核对', exact: true }).click(); await expect(page.locator('.tool-result')).toContainText('候选原函数求导后不等于被积函数');
  await page.getByRole('textbox', { name: '候选原函数或右式', exact: true }).fill('x^3/3+C'); await page.getByRole('button', { name: '在本机核对', exact: true }).click(); await expect(page.locator('.tool-result')).toContainText('候选原函数求导后与被积函数完全一致'); await expect(page.locator('.tool-result')).toContainText('不验证额外条件或一般定理');
  await page.getByRole('textbox', { name: '被积函数或左式', exact: true }).fill('sin(x)'); await page.getByRole('button', { name: '在本机核对', exact: true }).click(); await expect(page.locator('.tool-result')).toContainText('仅支持变量 x'); expect(service.calls).toHaveLength(0); expect(service.generated()).toHaveLength(0); expect((await notes(page))[0].drafts).toHaveLength(0);
});

test('manual local links use live search, show backlinks and retain changed or broken relationships without any AI request',async({page,context})=>{
  const service=await toolFixture(page,context),seed=await seedToolNotes(page,{formal:true,candidates:true});await openToolOwner(page,seed);await advanced(page,'知识关联');await page.locator('#manual-link-source').selectOption(seed.conditionId);await page.locator('#manual-link-relation').selectOption('theorem');await page.locator('#local-knowledge-search').fill('ALLOWED_THEOREM_CONTENT');await expect(page.locator('.local-link-result')).toHaveCount(1);await page.locator('.local-link-result').getByRole('button',{name:'建立人工关联',exact:true}).click();await expect.poll(async()=>(await notes(page)).find(n=>n.id===seed.noteId)!.links!.length).toBe(1);const link=(await notes(page)).find(n=>n.id===seed.noteId)!.links![0];expect(link.sourceBlockId).toBe(seed.conditionId);expect(link.targetBlockId).toBe(seed.candidates[0].blockId);expect(link.relation).toBe('theorem');
  await page.locator('.local-link-result').getByRole('button',{name:'打开内容',exact:true}).click();await expect(page.locator('#note-title')).toHaveValue(seed.candidates[0].title);await expect(page.locator('#typeset-page')).toContainText('ALLOWED_THEOREM_CONTENT');await advanced(page,'知识关联');await page.getByText('已有关系与反向链接',{exact:true}).click();await expect(page.locator('#local-knowledge details')).toContainText('有效');await page.locator('#advanced-close').click();
  await page.locator('#typeset-page').getByRole('button',{name:'编辑',exact:true}).click();await page.getByRole('textbox',{name:'排版内容',exact:true}).fill('THEOREM_CHANGED_AFTER_MANUAL_LINK');await page.getByRole('button',{name:'保存修改',exact:true}).click();await expect(page.locator('#advanced-dialog')).not.toBeVisible();await page.locator('#back-library').click();await page.getByRole('button',{name:'打开 '+seed.title,exact:true}).click();await advanced(page,'知识关联');await page.locator('#local-knowledge-search').fill('ALLOWED_THEOREM_CONTENT');await expect(page.locator('.local-link-result')).toHaveCount(0);await page.locator('#local-knowledge-search').fill('THEOREM_CHANGED_AFTER_MANUAL_LINK');await expect(page.locator('.local-link-result')).toHaveCount(1);await page.getByText('已有关系与反向链接',{exact:true}).click();await expect(page.locator('#local-knowledge details')).toContainText('目标已修改，需核对');
  await page.locator('.local-link-result').getByRole('button',{name:'打开内容',exact:true}).click();await page.locator('#pages-open').click();await page.locator('.page-item').filter({hasText:'排版页'}).getByRole('button',{name:'页菜单',exact:true}).click();await page.getByRole('button',{name:'删除这一页',exact:true}).click();await expect(page.locator('#ink-canvas')).toBeVisible();await page.locator('#back-library').click();await page.getByRole('button',{name:'打开 '+seed.title,exact:true}).click();await advanced(page,'知识关联');await page.locator('#local-knowledge-search').fill('THEOREM_CHANGED_AFTER_MANUAL_LINK');await expect(page.locator('.local-link-result')).toHaveCount(0);await page.getByText('已有关系与反向链接',{exact:true}).click();await expect(page.locator('#local-knowledge details')).toContainText('链接已断开');expect((await notes(page)).find(n=>n.id===seed.noteId)!.links).toHaveLength(1);expect(service.calls).toHaveLength(0);expect(service.generated()).toHaveLength(0);
});
