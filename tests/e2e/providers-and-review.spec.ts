import { test, expect } from '@playwright/test';
import { toolFixture, seedToolNotes, openToolOwner, openToolDraft, chooseProvider, settings, previewAdvanced, sendAdvanced, completedDraft, notes } from './fixtures/notebook-tools';

test('provider switching preserves offline notes and each cloud image submission requires its own current scope despite legacy consent', async ({ page, context }) => {
  const service = await toolFixture(page, context, { legacyConsent: true }), seed = await seedToolNotes(page, { formulaDraft: true }); await openToolOwner(page, seed);
  await page.locator('#toolbox-open').click(); await page.getByRole('button', { name: '识别公式', exact: true }).click(); await page.locator('#select-all').click(); await page.locator('#recognize').click();
  await expect(page.locator('#recognition-dialog')).toBeVisible(); await expect(page.locator('#recognition-service')).toContainText('deepseek'); expect(service.generated()).toHaveLength(0);
  await page.locator('#recognition-cancel').click(); await chooseProvider(page, 'mathpix');
  await page.locator('#toolbox-open').click(); await page.getByRole('button', { name: '识别公式', exact: true }).click(); await page.locator('#select-all').click(); await page.locator('#recognize').click();
  await expect(page.locator('#recognition-dialog')).toBeVisible(); await expect(page.locator('#recognition-service')).toContainText('mathpix'); expect(service.generated()).toHaveLength(0);
  await page.locator('#recognition-cancel').click(); await chooseProvider(page, 'ollama'); await settings(page); await page.locator('#health-check').click();
  await expect(page.locator('#service-details')).toContainText('当前后端连接通过'); expect(service.calls.filter(c => c.path === '/v1/provider-health').at(-1)!.provider).toBe('ollama');
  expect(service.generated()).toHaveLength(0); expect((await notes(page))[0].pageStrokes[seed.sourcePageId]).toHaveLength(1); expect((await notes(page))[0].drafts[0].latex).toBe('\\int x^2\\,dx');
});

test('local Qwen formula checking stays on the local provider and produces separately adoptable draft suggestions without a cloud request', async ({ page, context }) => {
  const service = await toolFixture(page, context, { provider: 'ollama' }), seed = await seedToolNotes(page, { formulaDraft: true }); await openToolOwner(page, seed); await openToolDraft(page, seed.noteId, seed.draftId);
  await page.locator('#draft-detail-dialog').getByRole('button', { name: '检查这条公式', exact: true }).click(); await previewAdvanced(page);
  await expect(page.getByRole('button', { name: '确认在本机检查', exact: true })).toBeVisible(); expect(service.generated()).toHaveLength(0);
  await sendAdvanced(page, true); const reviewed = await completedDraft(page, seed.noteId, 'review');
  const requests = service.generated(); expect(requests).toHaveLength(1); expect(requests[0].path).toBe('/v1/review'); expect(requests[0].provider).toBe('ollama');
  expect((await notes(page))[0].drafts.find(d => d.id === seed.draftId)!.latex).toBe('\\int x^2\\,dx');
  await openToolDraft(page, seed.noteId, reviewed.id); await expect(page.locator('.dd-suggestion')).toHaveCount(1);
  await page.getByRole('button', { name: '采用这条建议', exact: true }).click();
  await expect.poll(async () => (await notes(page))[0].drafts.find(d => d.id === reviewed.id)!.content!.formulas[0].latex).toBe('\\frac{x^3}{3}+C');
  expect((await notes(page))[0].formulas).toHaveLength(0); expect((await notes(page))[0].drafts.find(d => d.id === seed.draftId)!.latex).toBe('\\int x^2\\,dx'); expect(service.calls.filter(c => c.provider === 'deepseek')).toHaveLength(0);
});

test('cloud formula check sends only explicit formula and conditions; preview, adopting into a draft and insertion remain separate', async ({ page, context }) => {
  const service = await toolFixture(page, context), seed = await seedToolNotes(page, { formulaDraft: true }); await openToolOwner(page, seed); await openToolDraft(page, seed.noteId, seed.draftId);
  await page.locator('#draft-detail-dialog').getByRole('button', { name: '检查这条公式', exact: true }).click(); await page.locator('#advanced-conditions').fill('x 是实数，只检查对 x 的不定积分'); await previewAdvanced(page);
  const scope = await page.locator('.upload-scope-preview').textContent(); expect(scope).toContain('x 是实数'); expect(service.generated()).toHaveLength(0);
  await sendAdvanced(page); const checked = await completedDraft(page, seed.noteId, 'review'), request = service.generated()[0];
  expect(request.path).toBe('/v1/review'); expect(request.body!.latex).toBe('\\int x^2\\,dx'); expect(request.body!.context).toContain('x 是实数');
  expect(request.body).not.toHaveProperty('imageBase64'); expect(request.body).not.toHaveProperty('blocks'); expect(JSON.stringify(request.body)).not.toContain(seed.title);
  let saved = (await notes(page))[0]; expect(saved.formulas).toHaveLength(0); expect(saved.placements).toHaveLength(0); expect(saved.drafts.find(d => d.id === checked.id)!.content!.formulas[0].latex).toBe('\\int x^2\\,dx');
  await openToolDraft(page, seed.noteId, checked.id); await expect(page.locator('.dd-comparison')).toContainText('建议'); expect((await notes(page))[0].drafts.find(d => d.id === checked.id)!.content!.formulas[0].latex).toBe('\\int x^2\\,dx');
  await page.getByRole('button', { name: '采用这条建议', exact: true }).click(); await expect.poll(async () => (await notes(page))[0].drafts.find(d => d.id === checked.id)!.content!.formulas[0].latex).toBe('\\frac{x^3}{3}+C');
  saved = (await notes(page))[0]; expect(saved.formulas).toHaveLength(0); expect(saved.placements).toHaveLength(0); expect(saved.drafts.find(d => d.id === seed.draftId)!.latex).toBe('\\int x^2\\,dx'); expect(service.generated()).toHaveLength(1);
});
