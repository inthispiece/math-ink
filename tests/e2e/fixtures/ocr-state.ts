import type { Page } from '@playwright/test';

export function readyOcrStatus(configured = true) {
  return { status: 'ok', provider: 'mathpix', simulated: false, configured, pairingRequired: false,
    limits: { enforced: true, source: 'local-service', installationDaily: 10, globalDaily: 200, globalMonthly: 2000, maxImageBytes: 1400000 }, timeZone: 'Asia/Shanghai' };
}

export function quotaState(remaining = 8) {
  const resetsAt = '2099-01-01T00:00:00.000Z';
  return { status: 'ok', provider: 'mathpix', simulated: false, configured: true, timeZone: 'Asia/Shanghai', quota: {
    enforced: true, source: 'local-service',
    installationDaily: { limit: 10, used: 10 - remaining, remaining, resetsAt },
    globalDaily: { limit: 200, used: remaining ? 4 : 200, remaining: remaining ? 196 : 0, resetsAt },
    globalMonthly: { limit: 2000, used: 12, remaining: 1988, resetsAt },
  } };
}

/** Explicit network-boundary fixtures. No handwritten recognition accuracy is implied. */
export async function installReadyOcrMetadata(page: Page, remaining = 8) {
  const headers = { 'Access-Control-Allow-Origin': '*' };
  await page.route('**/v1/status', route => route.fulfill({ headers, json: readyOcrStatus() }));
  await page.route('**/v1/usage?**', route => route.fulfill({ headers, json: quotaState(remaining) }));
}
