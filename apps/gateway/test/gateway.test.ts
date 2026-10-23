import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get as httpGet } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { checkLocalPairingRequest, createGateway } from '../src/gateway.ts';
import { configFromEnv } from '../src/config.ts';
import { MathpixProvider } from '../src/providers.ts';
import { QuotaStore } from '../src/store.ts';
import { crc32, decodePngBase64 } from '../src/png.ts';
import type { GatewayConfig } from '../src/config.ts';
import type { RecognitionProvider } from '../src/types.ts';

function chunk(type: string, value: Buffer) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, value])));
  return Buffer.concat([length, name, value, crc]);
}

function png(pixel = 0) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, pixel, pixel, pixel, 255]))), chunk('IEND', Buffer.alloc(0))]);
}

const imageBase64 = png().toString('base64');
const request = (clientRequestId = 'request-0001', image = imageBase64) => ({ clientRequestId, installationId: 'installation-0001', imageBase64: image, sourceRevision: 2 });
const realProvider = (): RecognitionProvider => ({ name: 'mathpix', simulated: false, configured: true, async recognize() { return { latex: 'x' }; } });

async function fixture(t: test.TestContext, options: { config?: Partial<GatewayConfig>; provider?: RecognitionProvider; databasePath?: string; now?: () => number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'mathink-gateway-'));
  const databasePath = options.databasePath || join(directory, 'quota.sqlite');
  const config = { ...configFromEnv({}), databasePath, port: 0, ...options.config };
  const gateway = createGateway({ config, provider: options.provider, now: options.now });
  const server = createServer((req, res) => void gateway.handle(req, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  const close = async () => {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    gateway.close();
  };
  t.after(async () => { await close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    base, config, databasePath, gateway, close,
    post: async (body: unknown, headers: Record<string, string> = {}) => {
      const response = await fetch(`${base}/v1/recognize`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as Record<string, any> };
    },
  };
}

test('mock response explicitly simulated and input PNG accepted', async t => {
  const app = await fixture(t);
  const result = await app.post(request());
  assert.equal(result.status, 200);
  assert.equal(result.body.provider, 'mock');
  assert.equal(result.body.simulated, true);
  assert.equal(result.body.sourceRevision, 2);
  assert.match(result.body.latex, /\\int/);
  const dataUrl = await app.post(request('request-dataurl', `data:image/png;base64,${imageBase64}`));
  assert.equal(dataUrl.status, 200);
});

test('mock requests exceed every real quota without charging it; switching to real preserves its limits', async t => {
  const simulated = await fixture(t, { config: { installationDailyLimit: 1, globalDailyLimit: 1, globalMonthlyLimit: 1 } });
  for (let index = 0; index < 15; index++) {
    const result = await simulated.post(request(`mock-request-${index}`));
    assert.equal(result.status, 200);
    assert.equal(result.body.simulated, true);
  }
  const status = await (await fetch(`${simulated.base}/v1/status`)).json() as Record<string, any>;
  assert.deepEqual(status.limits, { enforced: false, source: 'local-service', installationDaily: null, globalDaily: null, globalMonthly: null, maxImageBytes: simulated.config.maxImageBytes });
  const usage = await (await fetch(`${simulated.base}/v1/usage?installationId=installation-0001`)).json() as Record<string, any>;
  assert.equal(usage.quota.enforced, false);
  assert.equal(usage.provider, 'mock');
  for (const name of ['installationDaily', 'globalDaily', 'globalMonthly']) assert.deepEqual(usage.quota[name], { limit: null, used: 0, remaining: null, resetsAt: null });
  const db = new DatabaseSync(simulated.databasePath);
  assert.deepEqual({ ...db.prepare('SELECT COUNT(*) AS total, SUM(quota_counted) AS counted FROM reservations').get() }, { total: 15, counted: 0 });
  db.close();
  await simulated.close();
  const real = await fixture(t, { databasePath: simulated.databasePath, config: { installationDailyLimit: 1 }, provider: realProvider() });
  try {
    assert.equal((await real.post(request())).status, 200);
    const limited = await real.post(request('real-request-two'));
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error.code, 'INSTALLATION_QUOTA_EXCEEDED');
    assert.match(limited.body.error.message, /当前安装实例.*每日运营额度（1 次）/);
    assert.match(limited.body.error.message, /并非 Mathpix/);
  } finally { await real.close(); }
});

test('usage validates pairing, origin and installation ID without calling a provider or reserving quota', async t => {
  let calls = 0;
  const provider: RecognitionProvider = { name: 'mathpix', simulated: false, configured: true, async recognize() { calls++; return { latex: 'x' }; } };
  const app = await fixture(t, { config: { pairingToken: 'usage-test-pairing-token-12345' }, provider });
  const headers = { Authorization: 'Bearer usage-test-pairing-token-12345' };
  const url = `${app.base}/v1/usage?installationId=installation-0001`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { Authorization: 'Bearer invalid' } })).status, 401);
  assert.equal((await fetch(url, { headers: { ...headers, Origin: 'https://evil.example.test' } })).status, 403);
  for (const suffix of ['', '?installationId=short', '?installationId=bad%20installation']) assert.equal((await fetch(`${app.base}/v1/usage${suffix}`, { headers })).status, 400);
  const response = await fetch(url, { headers: { ...headers, Origin: app.base } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const usage = await response.json() as Record<string, any>;
  assert.equal(usage.status, 'ok');
  assert.equal(usage.provider, 'mathpix');
  assert.equal(usage.simulated, false);
  assert.equal(usage.configured, true);
  assert.equal(usage.quota.source, 'local-service');
  assert.equal(usage.quota.enforced, true);
  assert.equal(usage.quota.installationDaily.used, 0);
  assert.equal(usage.quota.installationDaily.remaining, app.config.installationDailyLimit);
  assert.equal(calls, 0);
  const db = new DatabaseSync(app.databasePath);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM reservations').get() as { n: number }).n, 0);
  db.close();
  const status = await (await fetch(`${app.base}/v1/status`)).json() as Record<string, any>;
  assert.equal(status.limits.enforced, true);
  assert.equal(status.limits.installationDaily, app.config.installationDailyLimit);
});

test('usage shows three real quota windows, idempotency and local calendar reset boundaries', async t => {
  let clock = Date.UTC(2026, 9, 31, 15, 59);
  const app = await fixture(t, { config: { installationDailyLimit: 3, globalDailyLimit: 5, globalMonthlyLimit: 7 }, now: () => clock, provider: realProvider() });
  assert.equal((await app.post(request())).status, 200);
  assert.equal((await app.post(request())).status, 200);
  assert.equal((await app.post({ ...request('other-installation-request'), installationId: 'installation-0002' })).status, 200);
  const usage = await (await fetch(`${app.base}/v1/usage?installationId=installation-0001`)).json() as Record<string, any>;
  assert.equal(usage.timeZone, 'Asia/Shanghai');
  assert.deepEqual(usage.quota.installationDaily, { limit: 3, used: 1, remaining: 2, resetsAt: '2026-10-31T16:00:00.000Z' });
  assert.deepEqual(usage.quota.globalDaily, { limit: 5, used: 2, remaining: 3, resetsAt: '2026-10-31T16:00:00.000Z' });
  assert.deepEqual(usage.quota.globalMonthly, { limit: 7, used: 2, remaining: 5, resetsAt: '2026-10-31T16:00:00.000Z' });
  clock = Date.UTC(2026, 9, 31, 16);
  const reset = await (await fetch(`${app.base}/v1/usage?installationId=installation-0001`)).json() as Record<string, any>;
  for (const name of ['installationDaily', 'globalDaily', 'globalMonthly']) assert.equal(reset.quota[name].used, 0);
  assert.equal(reset.quota.installationDaily.resetsAt, '2026-11-01T16:00:00.000Z');
  assert.equal(reset.quota.globalMonthly.resetsAt, '2026-11-30T16:00:00.000Z');
});

test('quota reset times respect a 25-hour daylight-saving day', () => {
  const store = new QuotaStore(':memory:');
  try {
    const config = { ...configFromEnv({}), timeZone: 'America/New_York' };
    const usage = store.usage('installation-hash', Date.UTC(2026, 10, 1, 4), config);
    assert.equal(usage.installationDaily.resetsAt, '2026-11-02T05:00:00.000Z');
    assert.equal(usage.globalMonthly.resetsAt, '2026-12-01T05:00:00.000Z');
  } finally { store.close(); }
});

test('legacy quota migration retains existing real usage while mock bypasses exhausted quota', t => {
  const directory = mkdtempSync(join(tmpdir(), 'mathink-legacy-quota-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'quota.sqlite');
  const db = new DatabaseSync(path);
  const now = Date.UTC(2026, 9, 9, 8);
  db.exec(`CREATE TABLE reservations (
    request_key TEXT PRIMARY KEY, request_id TEXT NOT NULL, installation_hash TEXT NOT NULL,
    fingerprint TEXT NOT NULL, day TEXT NOT NULL, month TEXT NOT NULL, created_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending'
  )`);
  db.prepare('INSERT INTO reservations VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('legacy-key', 'legacy-id', 'installation-hash', 'legacy-fingerprint', '2026-10-09', '2026-10', now, 'ok');
  db.close();
  const store = new QuotaStore(path);
  try {
    const config = { ...configFromEnv({}), installationDailyLimit: 1 };
    const before = store.usage('installation-hash', now, config);
    assert.equal(before.installationDaily.used, 1);
    assert.equal(before.installationDaily.remaining, 0);
    assert.throws(() => store.reserve({ requestKey: 'real-key', requestId: 'real-id', installationHash: 'installation-hash', fingerprint: 'real-fingerprint', now }, config), /每日运营额度/);
    store.reserve({ requestKey: 'mock-key', requestId: 'mock-id', installationHash: 'installation-hash', fingerprint: 'mock-fingerprint', now, countQuota: false }, config);
    assert.deepEqual(store.usage('installation-hash', now, config), before);
  } finally { store.close(); }
});

test('missing real credentials never silently falls back to mock and consumes no quota', async t => {
  const app = await fixture(t, { config: { provider: 'mathpix', installationDailyLimit: 1 } });
  for (const id of ['request-one', 'request-two']) {
    const result = await app.post(request(id));
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, 'PROVIDER_NOT_CONFIGURED');
    assert.equal(result.body.simulated, false);
  }
  const db = new DatabaseSync(app.databasePath);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM reservations').get() as { n: number }).n, 0);
  db.close();
});

test('rejects non-PNG, corrupt CRC, invalid base64, empty and malformed input before reservation', async t => {
  const app = await fixture(t, { config: { installationDailyLimit: 1 } });
  const damaged = png();
  damaged[20] ^= 1;
  for (const image of ['', 'not-base64', Buffer.from('jpeg').toString('base64'), damaged.toString('base64')]) {
    const result = await app.post(request('invalid-request', image));
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'INVALID_IMAGE');
  }
  for (const invalid of [{ ...request(), sourceRevision: -1 }, { ...request(), sourceRevision: '2' }, { ...request(), upstreamKey: 'secret' }, { ...request(), clientRequestId: '' }, []]) {
    const result = await app.post(invalid);
    assert.equal(result.status, 400);
  }
  assert.equal((await app.post(request())).status, 200);
});

test('PNG parser validates image decompression instead of accepting signature-only data', () => {
  const header = png().subarray(8, 33);
  const fake = Buffer.concat([png().subarray(0, 8), header, chunk('IDAT', Buffer.from('not-zlib')), chunk('IEND', Buffer.alloc(0))]);
  assert.throws(() => decodePngBase64(fake.toString('base64'), 1_400_000), /有效/);
});

test('quota reservations are persisted and installation limit is atomic under simultaneous submissions', async t => {
  let calls = 0;
  const provider: RecognitionProvider = {
    name: 'mathpix', simulated: false, configured: true,
    async recognize() { calls++; await new Promise(resolve => setTimeout(resolve, 10)); return { latex: 'x' }; },
  };
  const app = await fixture(t, { config: { installationDailyLimit: 2 }, provider });
  const results = await Promise.all([1, 2, 3].map(n => app.post(request(`request-${n}000`))));
  assert.deepEqual(results.map(value => value.status).sort(), [200, 200, 429]);
  assert.equal(calls, 2);
  assert.equal(results.find(value => value.status === 429)?.body.error.code, 'INSTALLATION_QUOTA_EXCEEDED');
});

test('same request merges concurrent calls and caches result without second quota reservation', async t => {
  let calls = 0;
  const provider: RecognitionProvider = {
    name: 'mathpix', simulated: false, configured: true,
    async recognize() { calls++; await new Promise(resolve => setTimeout(resolve, 25)); return { latex: 'x^2' }; },
  };
  const app = await fixture(t, { config: { installationDailyLimit: 1 }, provider });
  const results = await Promise.all([app.post(request()), app.post(request())]);
  assert.equal(calls, 1);
  assert.equal(results[0].status, 200);
  assert.deepEqual(results[0].body, results[1].body);
  assert.deepEqual((await app.post(request())).body, results[0].body);
  assert.equal(calls, 1);
  assert.equal((await app.post(request('request-another'))).status, 429);
});

test('changed image or revision with an existing request ID returns conflict', async t => {
  const app = await fixture(t);
  assert.equal((await app.post(request())).status, 200);
  for (const changed of [{ ...request(), sourceRevision: 3 }, request('request-0001', png(255).toString('base64'))]) {
    const result = await app.post(changed);
    assert.equal(result.status, 409);
    assert.equal(result.body.error.code, 'IDEMPOTENCY_CONFLICT');
  }
});

test('SQLite holds no image or formula; restarted service never repeats an unknown result', async t => {
  let calls = 0;
  const provider: RecognitionProvider = { name: 'mathpix', simulated: false, configured: true, async recognize() { calls++; return { latex: 'SECRET_FORMULA_CONTENT' }; } };
  const first = await fixture(t, { provider });
  const original = await first.post(request());
  assert.equal(original.status, 200);
  const db = new DatabaseSync(first.databasePath);
  const columns = db.prepare('PRAGMA table_info(reservations)').all() as { name: string }[];
  assert.deepEqual(columns.map(value => value.name), ['request_key', 'request_id', 'installation_hash', 'fingerprint', 'day', 'month', 'created_at', 'state', 'quota_counted']);
  const rows = JSON.stringify(db.prepare('SELECT * FROM reservations').all());
  assert.equal(rows.includes('SECRET_FORMULA_CONTENT'), false);
  assert.equal(rows.includes(imageBase64), false);
  assert.equal(rows.includes('installation-0001'), false);
  db.close();
  await first.close();
  assert.equal(readFileSync(first.databasePath).includes(Buffer.from('SECRET_FORMULA_CONTENT')), false);
  const second = await fixture(t, { databasePath: first.databasePath, provider });
  try {
    const repeated = await second.post(request());
    assert.equal(repeated.status, 409);
    assert.equal(repeated.body.error.code, 'REQUEST_RESULT_UNAVAILABLE');
    assert.equal(repeated.body.requestId, original.body.requestId);
    assert.equal(calls, 1);
  } finally { await second.close(); }
});

test('expired memory cache does not initiate another paid call', async t => {
  let clock = Date.UTC(2026, 9, 9, 0);
  const app = await fixture(t, { now: () => clock, config: { resultTtlMs: 10 }, provider: realProvider() });
  assert.equal((await app.post(request())).status, 200);
  clock += 11;
  assert.equal((await app.post(request())).body.error.code, 'REQUEST_RESULT_UNAVAILABLE');
});

test('daily and monthly global limits span installation IDs', async t => {
  const daily = await fixture(t, { config: { globalDailyLimit: 1 }, provider: realProvider() });
  assert.equal((await daily.post(request())).status, 200);
  const dailyResult = await daily.post({ ...request('request-0002'), installationId: 'installation-0002' });
  assert.equal(dailyResult.body.error.code, 'GLOBAL_DAILY_QUOTA_EXCEEDED');
  const monthly = await fixture(t, { config: { globalMonthlyLimit: 1 }, provider: realProvider() });
  assert.equal((await monthly.post(request())).status, 200);
  assert.equal((await monthly.post({ ...request('request-0002'), installationId: 'installation-0002' })).body.error.code, 'GLOBAL_MONTHLY_QUOTA_EXCEEDED');
});

test('quota day rolls over in Shanghai, independently of UTC date', async t => {
  let clock = Date.UTC(2026, 9, 9, 15, 59);
  const app = await fixture(t, { config: { installationDailyLimit: 1 }, now: () => clock, provider: realProvider() });
  assert.equal((await app.post(request())).status, 200);
  assert.equal((await app.post(request('request-0002'))).status, 429);
  clock = Date.UTC(2026, 9, 9, 16, 1);
  assert.equal((await app.post(request('request-0003'))).status, 200);
});

test('timeout counts quota, is cached, and does not automatically retry', async t => {
  let calls = 0;
  const provider: RecognitionProvider = { name: 'mathpix', simulated: false, configured: true, recognize() { calls++; return new Promise(() => {}); } };
  const app = await fixture(t, { config: { requestTimeoutMs: 10, installationDailyLimit: 1 }, provider });
  const result = await app.post(request());
  assert.equal(result.status, 504);
  assert.equal(result.body.error.code, 'PROVIDER_TIMEOUT');
  assert.equal(result.body.error.retryable, false);
  assert.deepEqual((await app.post(request())).body, result.body);
  assert.equal((await app.post(request('request-newid'))).status, 429);
  assert.equal(calls, 1);
});

test('LAN configuration requires long token; API validates pairing and allowed origins', async t => {
  assert.throws(() => configFromEnv({ GATEWAY_HOST: '0.0.0.0' }), /GATEWAY_PAIRING_TOKEN/);
  const pairingToken = 'test-pairing-token-with-24-characters';
  const app = await fixture(t, { config: { pairingToken, allowedOrigins: ['https://notes.example.test'] } });
  assert.equal((await app.post(request())).status, 401);
  assert.equal((await app.post(request(), { Authorization: 'Bearer wrong' })).status, 401);
  const blocked = await app.post(request(), { Authorization: `Bearer ${pairingToken}`, Origin: 'https://evil.example.test' });
  assert.equal(blocked.status, 403);
  const allowed = await app.post(request(), { Authorization: `Bearer ${pairingToken}`, Origin: 'https://notes.example.test' });
  assert.equal(allowed.status, 200);
  const preflight = await fetch(`${app.base}/v1/recognize`, { method: 'OPTIONS', headers: { Origin: 'https://notes.example.test' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://notes.example.test');
});

test('pairing check validates credentials and origin without recognizing or reserving quota', async t => {
  const pairingToken = 'test-pairing-token-with-24-characters';
  let calls = 0;
  const provider: RecognitionProvider = { name: 'mock', simulated: true, configured: true, async recognize() { calls++; return { latex: 'x' }; } };
  const app = await fixture(t, { config: { pairingToken, allowedOrigins: ['https://notes.example.test'], installationDailyLimit: 1 }, provider });
  for (const headers of [{}, { Authorization: 'Bearer wrong' }] as Record<string, string>[]) {
    const result = await fetch(`${app.base}/v1/pairing`, { headers });
    assert.equal(result.status, 401);
    assert.equal((await result.json() as { error: { code: string } }).error.code, 'UNAUTHORIZED');
  }
  for (const origin of [app.base, 'https://notes.example.test']) {
    const result = await fetch(`${app.base}/v1/pairing`, { headers: { Authorization: `Bearer ${pairingToken}`, Origin: origin } });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal(result.headers.get('access-control-allow-origin'), origin);
    assert.deepEqual(await result.json(), { status: 'ok', pairingRequired: true });
  }
  const blocked = await fetch(`${app.base}/v1/pairing`, { headers: { Authorization: `Bearer ${pairingToken}`, Origin: 'https://evil.example.test' } });
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json() as { error: { code: string } }).error.code, 'ORIGIN_NOT_ALLOWED');
  assert.equal(calls, 0);
  const db = new DatabaseSync(app.databasePath);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM reservations').get() as { n: number }).n, 0);
  db.close();
  assert.equal((await app.post(request(), { Authorization: `Bearer ${pairingToken}` })).status, 200);
  assert.equal(calls, 1);
});

test('pairing check also supports an unpaired local service and unavailable provider', async t => {
  const app = await fixture(t, { config: { provider: 'mathpix' } });
  const result = await fetch(`${app.base}/v1/pairing`);
  assert.deepEqual(await result.json(), { status: 'ok', pairingRequired: false });
  assert.equal(result.status, 200);
  const local = await fetch(`${app.base}/v1/local-pairing`);
  assert.deepEqual(await local.json(), { status: 'ok', pairingRequired: false, pairingToken: '' });
  const method = await fetch(`${app.base}/v1/pairing`, { method: 'POST' });
  assert.equal(method.status, 405);
  assert.equal(method.headers.get('allow'), 'GET, OPTIONS');
});

test('local pairing bootstraps only direct local pages and leaves recognition protected', async t => {
  const pairingToken = 'test-local-pairing-token-24-characters';
  const app = await fixture(t, { config: { pairingToken, allowedOrigins: ['https://notes.example.test'] } });
  for (const headers of [{}, { Origin: app.base, 'Sec-Fetch-Site': 'same-origin' }, { 'Sec-Fetch-Site': 'none' }] as Record<string, string>[]) {
    const result = await fetch(`${app.base}/v1/local-pairing`, { headers });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(await result.json(), { status: 'ok', pairingRequired: true, pairingToken });
  }
  // Even explicitly allowed WebView origins cannot retrieve a local bootstrap token.
  for (const headers of [
    { Origin: 'https://notes.example.test' },
    { Origin: app.base.replace('http:', 'https:') },
    { 'Sec-Fetch-Site': 'cross-site' },
    { 'Sec-Fetch-Site': 'same-site' },
    { 'X-Forwarded-For': '192.168.1.15' },
    { 'X-Forwarded-Host': 'public.example.test' },
    { Forwarded: 'for=192.168.1.15;host=public.example.test' },
    { Via: '1.1 proxy' },
  ] as Record<string, string>[]) {
    const blocked = await fetch(`${app.base}/v1/local-pairing`, { headers });
    assert.equal(blocked.status, 403, JSON.stringify(headers));
    assert.equal((await blocked.text()).includes(pairingToken), false);
  }
  // fetch controls Host itself; use HTTP directly to exercise a rebinding Host.
  const rebound = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    httpGet(`${app.base}/v1/local-pairing`, { headers: { Host: 'rebind.example.test' } }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode!, body }));
      response.on('error', reject);
    }).on('error', reject);
  });
  assert.equal(rebound.status, 403);
  assert.equal(rebound.body.includes(pairingToken), false);
  assert.equal((await app.post(request())).status, 401);
  const statusText = await (await fetch(`${app.base}/v1/status`)).text();
  assert.equal(statusText.includes(pairingToken), false);
  const db = new DatabaseSync(app.databasePath);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM reservations').get() as { n: number }).n, 0);
  db.close();
  assert.equal((await app.post(request(), { Authorization: `Bearer ${pairingToken}` })).status, 200);
});

test('local pairing guard rejects LAN sockets, rebinding hosts and misleading same-site metadata', () => {
  type LocalRequestOverrides = { address?: string; headers?: Record<string, string>; encrypted?: boolean };
  const incoming = (overrides: LocalRequestOverrides = {}) => ({
    socket: { remoteAddress: overrides.address ?? '127.0.0.1', encrypted: overrides.encrypted },
    headers: { host: '127.0.0.1:8787', ...overrides.headers },
  }) as unknown as IncomingMessage;
  for (const address of ['127.0.0.1', '127.2.3.4', '::1', '::ffff:127.0.0.1']) {
    assert.doesNotThrow(() => checkLocalPairingRequest(incoming({ address })));
  }
  assert.doesNotThrow(() => checkLocalPairingRequest(incoming({ address: '::1', headers: { host: '[::1]:8787', origin: 'http://[::1]:8787' } })));
  assert.doesNotThrow(() => checkLocalPairingRequest(incoming({ headers: { host: 'localhost:8787', origin: 'https://localhost:8787' }, encrypted: true })));
  for (const input of [
    { address: '192.168.1.12' },
    { address: '::ffff:192.168.1.12' },
    { address: '203.0.113.10' },
    { address: '127.0.0.1.example.test' },
    { headers: { host: 'rebind.example.test:8787', origin: 'http://rebind.example.test:8787' } },
    { headers: { host: '127.0.0.1.evil.test:8787' } },
    { headers: { host: '127.1:8787' } },
    { headers: { host: '2130706433:8787' } },
    { headers: { host: 'localhost.:8787' } },
    { headers: { host: 'localhost:99999' } },
    { headers: { host: 'localhost:8787@evil.test' } },
    { headers: { origin: 'http://127.0.0.1:5173' } },
    { headers: { origin: 'http://localhost:8787' } },
    { headers: { origin: 'https://127.0.0.1:8787' } },
    { headers: { origin: 'null' } },
    { headers: { origin: 'http://127.0.0.1:8787/' } },
    { headers: { 'sec-fetch-site': 'same-site' } },
    { headers: { 'sec-fetch-site': 'cross-site' } },
    { headers: { 'x-forwarded-proto': 'https' } },
  ] as LocalRequestOverrides[]) {
    assert.throws(() => checkLocalPairingRequest(incoming(input)), error => error instanceof Error && 'code' in error && error.code === 'LOCAL_PAIRING_NOT_ALLOWED');
  }
});

test('health exposes configuration state but no credentials; method and type rejected', async t => {
  const app = await fixture(t, { config: { mathpixAppKey: 'SECRET_KEY', pairingToken: 'SECRET_TOKEN' } });
  const status = await fetch(`${app.base}/v1/status`);
  const text = await status.text();
  assert.equal(text.includes('SECRET_KEY'), false);
  assert.equal(text.includes('SECRET_TOKEN'), false);
  assert.equal(JSON.parse(text).pairingRequired, true);
  assert.equal((await fetch(`${app.base}/v1/recognize`)).status, 405);
  const invalid = await fetch(`${app.base}/v1/recognize`, { method: 'POST', headers: { Authorization: 'Bearer SECRET_TOKEN', 'Content-Type': 'text/plain' }, body: 'text' });
  assert.equal(invalid.status, 415);
});

test('request body size limited before reading content', async t => {
  const app = await fixture(t, { config: { maxBodyBytes: 100 } });
  assert.equal((await app.post(request())).status, 413);
});

test('multiple SQLite stores share atomic global quota', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mathink-store-'));
  const first = new QuotaStore(join(directory, 'quota.sqlite'));
  const second = new QuotaStore(join(directory, 'quota.sqlite'));
  try {
    const config = { ...configFromEnv({}), globalDailyLimit: 1 };
    first.reserve({ requestKey: 'key1', requestId: 'id1', installationHash: 'installation1', fingerprint: 'input1', now: Date.now() }, config);
    assert.throws(() => second.reserve({ requestKey: 'key2', requestId: 'id2', installationHash: 'installation2', fingerprint: 'input2', now: Date.now() }, config), /额度/);
  } finally {
    first.close(); second.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test('Mathpix real adapter sends privacy flag and credentials server-side; maps latex response', async () => {
  let calls = 0;
  const provider = new MathpixProvider({
    appId: 'test-app-id', appKey: 'test-app-key',
    fetcher: (async (url, options) => {
      calls++;
      assert.equal(url, 'https://api.mathpix.com/v3/text');
      assert.equal((options?.headers as Record<string, string>).app_key, 'test-app-key');
      const body = JSON.parse(options?.body as string);
      assert.equal(body.metadata.improve_mathpix, false);
      assert.deepEqual(body.formats, ['latex_styled', 'text', 'data']);
      assert.match(body.src, /^data:image\/png;base64,/);
      return new Response(JSON.stringify({ latex_styled: ' x^2 ', confidence: 0.93 }), { status: 200 });
    }) as typeof fetch,
  });
  const result = await provider.recognize(png(), new AbortController().signal);
  assert.deepEqual(result, { latex: 'x^2', confidence: 0.93 });
  assert.equal(calls, 1);
});

test('Mathpix HTTP 200 error_info is an error and never leaks provider payload', async () => {
  const provider = new MathpixProvider({ appId: 'id', appKey: 'key', fetcher: (async () => new Response(JSON.stringify({ error_info: { id: 'image_no_content' }, error: 'PRIVATE_INPUT', latex_styled: 'x' }))) as typeof fetch });
  await assert.rejects(provider.recognize(png(), new AbortController().signal), error => error instanceof Error && 'code' in error && error.code === 'NO_CONTENT' && !error.message.includes('PRIVATE_INPUT'));
});

test('Mathpix maps credentials, rate limit, invalid payload, empty/prose output, and network failure', async () => {
  for (const [response, code] of [
    [new Response('', { status: 401 }), 'PROVIDER_AUTH_FAILED'],
    [new Response('', { status: 429 }), 'PROVIDER_RATE_LIMITED'],
    [new Response('not-json'), 'PROVIDER_BAD_RESPONSE'],
    [new Response(JSON.stringify({ text: 'hello world' })), 'NO_FORMULA'],
    [new Response(JSON.stringify({ latex_styled: '' })), 'NO_FORMULA'],
  ] as const) {
    const provider = new MathpixProvider({ appId: 'id', appKey: 'key', fetcher: (async () => response) as typeof fetch });
    await assert.rejects(provider.recognize(png(), new AbortController().signal), error => error instanceof Error && 'code' in error && error.code === code);
  }
  const failure = new MathpixProvider({ appId: 'id', appKey: 'key', fetcher: (async () => { throw new Error('SECRET_PROVIDER_MESSAGE'); }) as typeof fetch });
  await assert.rejects(failure.recognize(png(), new AbortController().signal), error => error instanceof Error && !error.message.includes('SECRET_PROVIDER_MESSAGE'));
});

test('Mathpix recognizes pure math delimiters and multiple equation data without returning Markdown prose', async () => {
  for (const [payload, expected] of [
    [{ text: '\\[x^2\\]' }, 'x^2'],
    [{ text: '$x$' }, 'x'],
    [{ data: [{ type: 'latex', value: 'x=1' }, { type: 'latex', value: 'y=2' }] }, '\\begin{gathered}x=1 \\\\ y=2\\end{gathered}'],
  ] as const) {
    const provider = new MathpixProvider({ appId: 'id', appKey: 'key', fetcher: (async () => new Response(JSON.stringify(payload))) as typeof fetch });
    assert.equal((await provider.recognize(png(), new AbortController().signal)).latex, expected);
  }
});
