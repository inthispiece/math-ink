import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { toolFixture, seedToolNotes, openToolOwner, openToolDraft, notes } from './fixtures/notebook-tools';

test('HTTP headers with an unfinished JSON body eventually leave the original task unknown and never trigger another POST', async ({ page, context }) => {
  let gets = 0, started!: () => void; const receiving = new Promise<void>(resolve => started = resolve);
  const server = createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*'); response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization'); response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
    if (request.method !== 'GET' || !request.url?.startsWith('/v1/recognitions/')) { response.writeHead(500).end(); return; }
    gets++; response.writeHead(200, { 'Content-Type': 'application/json' }); response.flushHeaders(); response.write('{"taskId":'); started();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const gateway = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  try {
    const service = await toolFixture(page, context, { gateway, allowPartialOrigin: gateway }), seed = await seedToolNotes(page, { pendingTask: true, gateway }); await openToolOwner(page, seed); await receiving;
    await expect.poll(async () => (await notes(page))[0].drafts.find(d => d.id === seed.draftId)!.status, { timeout: 18000 }).toBe('unknown');
    await openToolDraft(page, seed.noteId, seed.draftId); await expect(page.locator('#draft-task-state')).toContainText('状态未知');
    expect(gets).toBe(1); expect(service.generated()).toHaveLength(0); expect((await notes(page))[0].pageStrokes[seed.sourcePageId]).toHaveLength(1); expect((await notes(page))[0].formulas).toHaveLength(0);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('explicitly cancelled selection cannot adopt a late reply or overwrite the retained original and never repeats generation', async ({ page, context }) => {
  const service = await toolFixture(page, context, { holdSelection: true }), seed = await seedToolNotes(page, { pendingTask: true }); await openToolOwner(page, seed); await openToolDraft(page, seed.noteId, seed.draftId);
  await expect.poll(() => service.calls.filter(c => c.method === 'GET' && c.path.startsWith('/v1/recognitions/')).length).toBeGreaterThan(0);
  await page.locator('#draft-detail-dialog').getByRole('button', { name: '取消任务', exact: true }).click();
  await expect.poll(async () => (await notes(page))[0].drafts.find(d => d.id === seed.draftId)!.status).toBe('cancelled'); await service.releaseHeld();
  await expect(page.locator('#draft-task-state')).toContainText('已取消');
  const saved = (await notes(page))[0]; expect(saved.drafts[0].latex).toBeUndefined(); expect(saved.formulas).toHaveLength(0); expect(saved.placements).toHaveLength(0); expect(saved.pageStrokes[seed.sourcePageId]).toHaveLength(1); expect(service.generated()).toHaveLength(0); expect(service.calls.filter(c => c.path.endsWith('/cancel'))).toHaveLength(1);
});
