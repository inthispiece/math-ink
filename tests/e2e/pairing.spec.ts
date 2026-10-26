import { test, expect } from '@playwright/test';
import { toolFixture, seedToolNotes, openToolOwner, chooseProvider, settings, notes, toolToken } from './fixtures/notebook-tools';

test('connection check uses the current token form and rejects an incorrect token even when public metadata succeeds', async ({ page, context }) => {
  const service = await toolFixture(page, context); await settings(page); await page.locator('#pairing-token').fill('wrong-token-in-current-form'); await page.locator('#health-check').click();
  await expect(page.locator('#service-details')).toContainText('正确的服务配对令牌');
  expect(service.calls.filter(c => c.path === '/v1/provider-health').at(-1)!.authorization).toBe('Bearer wrong-token-in-current-form');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('math-ink-settings')!).pairingToken)).toBe(toolToken);
  await page.locator('#pairing-token').fill(toolToken); await page.locator('#health-check').click(); await expect(page.locator('#service-details')).toContainText('当前后端连接通过'); expect(service.generated()).toHaveLength(0);
});

test('changing current gateway and model does not change the original task account or send the old request to the new gateway', async ({ page, context }) => {
  const oldGateway = 'https://old-mathink-fixture.test', newGateway = 'https://new-mathink-fixture.test';
  const service = await toolFixture(page, context, { gateway: oldGateway, holdSelection: true }), seed = await seedToolNotes(page, { pendingTask: true, gateway: oldGateway }); await openToolOwner(page, seed);
  await expect.poll(() => service.calls.filter(c => c.method === 'GET' && c.path.startsWith('/v1/recognitions/')).length).toBeGreaterThan(0);
  await chooseProvider(page, 'ollama', newGateway); await service.releaseHeld();
  await expect.poll(async () => (await notes(page))[0].drafts.find(d => d.id === seed.draftId)!.status).toBe('completed');
  const queries = service.calls.filter(c => c.method === 'GET' && c.path.startsWith('/v1/recognitions/')); expect(queries.every(c => c.origin === oldGateway && c.provider === 'deepseek' && c.authorization === 'Bearer ' + toolToken)).toBe(true);
  expect(service.generated()).toHaveLength(0); expect((await notes(page))[0].drafts[0].task!.gateway).toBe(oldGateway); expect((await notes(page))[0].drafts[0].task!.provider).toBe('deepseek');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('math-ink-settings')!).gatewayUrl)).toBe(newGateway);
});

test('hosted logout revokes the session and pending tasks wait for their original connection without falling back to pairing or another account', async ({ page, context }) => {
  const service = await toolFixture(page, context, { hosted: true, holdSelection: true }), seed = await seedToolNotes(page, { hosted: true, pendingTask: true }); await openToolOwner(page, seed);
  await expect.poll(() => service.calls.filter(c => c.path.startsWith('/v1/recognitions/')).length).toBeGreaterThan(0);
  await settings(page); await page.locator('#health-check').click(); await expect(page.locator('#account-logout')).toBeVisible(); await page.locator('#account-logout').click();
  await expect(page.locator('#hosted-state')).toContainText('请登录'); await page.reload(); await service.releaseHeld();
  await expect.poll(async () => (await notes(page))[0].drafts.find(d => d.id === seed.draftId)!.status).toBe('waiting-connection');
  expect(await page.evaluate(() => sessionStorage.getItem('mathink-session:' + location.origin))).toBeNull(); expect(service.calls.filter(c => c.path === '/v1/auth/logout')).toHaveLength(1); expect(service.generated()).toHaveLength(0); expect((await notes(page))[0].drafts[0].task!.principal).toBe('user:fixture-user');
});
