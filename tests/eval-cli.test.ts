import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, relative } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { deflateSync } from 'node:zlib';
import { crc32 } from '../apps/gateway/src/png.ts';
import { canReserve, chargeForRecord, main } from '../scripts/eval-ai.mjs';

const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
async function withDirectory(run: (directory: string) => Promise<void>) { const directory = resolve('.local', `eval-test-${randomUUID()}`); await mkdir(directory, { recursive: true }); try { await run(directory); } finally { assert.equal(relative(resolve('.local'), directory).startsWith('eval-test-'), true); await rm(directory, { recursive: true, force: true }); } }
const sample = { id: 'real-review', kind: 'review', split: 'acceptance', writerGroup: 'writer-a', sourceGroup: 'source-a', latex: 'x^2', expected: { hasError: false }, humanVerified: false };
test('evaluation initializer never overwrites private data and supplies balanced unverified candidate checks', async () => withDirectory(async directory => {
  await main(['init', '--directory', directory]); const manifest = await readJson(resolve(directory, 'manifest.json')); assert.deepEqual(manifest.samples, []);
  const checks = await readJson(resolve(directory, 'checks-manifest.json')); assert.equal(checks.samples.length, 40); assert.equal(checks.samples.filter((s: typeof sample) => s.expected.hasError).length, 20); assert.equal(checks.samples.every((s: typeof sample) => s.humanVerified === false), true);
  manifest.samples = [sample]; await writeFile(resolve(directory, 'manifest.json'), JSON.stringify(manifest)); await main(['init', '--directory', directory]); assert.deepEqual((await readJson(resolve(directory, 'manifest.json'))).samples, [sample]);
}));
test('unknown/pending and failed paid calls retain conservative budget, known successful estimates can settle', () => {
  assert.equal(chargeForRecord({ status: 'unknown', reservedCny: 5, cost: { status: 'estimated', amount: .01 } }), 5);
  assert.equal(chargeForRecord({ status: 'ok', reservedCny: 5, cost: { status: 'unknown', amount: null } }), 5);
  assert.equal(canReserve([{ status: 'pending', reservedCny: 5 }], 5, 9), false);
  assert.equal(canReserve([{ status: 'ok', reservedCny: 5, cost: { status: 'estimated', amount: .1 } }], 5, 6), true);
});
test('evaluation requires explicit paid consent and stops before generation when provider is unconfigured', async () => withDirectory(async directory => {
  const manifest = resolve(directory, 'manifest.json'); await writeFile(manifest, JSON.stringify({ version: 1, samples: [sample] }));
  await assert.rejects(main(['run', '--manifest', manifest, '--budget-cny', '5']), /allow-paid/);
  const original = globalThis.fetch; let posts = 0; globalThis.fetch = async (_url, init) => { if (init?.method === 'POST') posts++; return new Response(JSON.stringify({ provider: 'deepseek', simulated: false, configured: false }), { status: 200 }); };
  try { await assert.rejects(main(['run', '--manifest', manifest, '--run-file', resolve(directory, 'run.json'), '--allow-paid', '--budget-cny', '5']), /尚未正确配置/); assert.equal(posts, 0); } finally { globalThis.fetch = original; }
}));
test('evaluation persists pending before POST, enforces reserved budget, and never retries prior unknown requests', async () => withDirectory(async directory => {
  const manifest = resolve(directory, 'manifest.json'), runFile = resolve(directory, 'run.json'); await writeFile(manifest, JSON.stringify({ version: 1, samples: [sample, { ...sample, id: 'second-review' }] }));
  const original = globalThis.fetch; let posts = 0;
  globalThis.fetch = async (_url, init) => { if (init?.method !== 'POST') return new Response(JSON.stringify({ provider: 'deepseek', simulated: false, configured: true, model: 'fixture-model', taskLimits: { maxCostCny: 3 } }), { status: 200 }); posts++; const state = await readJson(runFile); assert.equal(state.records[0].status, 'pending'); assert.equal(state.records[0].clientRequestId, JSON.parse(String(init.body)).clientRequestId); throw new Error('simulated transport loss'); };
  const args = ['run', '--manifest', manifest, '--run-file', runFile, '--allow-paid', '--budget-cny', '5'];
  try { await main(args); await main(args); assert.equal(posts, 1); const state = await readJson(runFile); assert.equal(state.records[0].status, 'unknown'); assert.equal(state.records[0].cost.amount, null); assert.equal(state.records.length, 1); } finally { globalThis.fetch = original; }
}));
test('real HTTP page evaluation sends PNG once, persists request first and polls with installation identity', async () => withDirectory(async directory => {
  const chunk = (name: string, data: Buffer) => { const type = Buffer.from(name), size = Buffer.alloc(4), crc = Buffer.alloc(4); size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([type, data]))); return Buffer.concat([size, type, data, crc]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 255]))), chunk('IEND', Buffer.alloc(0))]);
  await writeFile(resolve(directory, 'page.png'), png); const manifest = resolve(directory, 'manifest.json'), runFile = resolve(directory, 'run.json');
  await writeFile(manifest, JSON.stringify({ version: 1, samples: [{ ...sample, id: 'page-sample', kind: 'page', imagePath: 'page.png', expected: {} }] }));
  let posted = 0, polled = 0, installation = ''; const errors: unknown[] = [];
  const server = createServer(async (request, response) => { try { const url = new URL(request.url!, 'http://localhost'); assert.equal(request.headers.authorization, 'Bearer local-eval-test-secret'); response.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/v1/status') { response.end(JSON.stringify({ provider: 'deepseek', simulated: false, configured: true, model: 'fixture-model', taskLimits: { maxCostCny: 5 }, taskCapabilities: { 'page-transcribe': true } })); return; }
    if (request.method === 'POST' && url.pathname === '/v1/tasks') { posted++; const chunks = []; for await (const bytes of request) chunks.push(bytes); const payload = JSON.parse(Buffer.concat(chunks).toString()); installation = payload.installationId; assert.equal(payload.type, 'page-transcribe'); assert.deepEqual(Buffer.from(payload.input.imageBase64, 'base64'), png); const saved = await readJson(runFile); assert.equal(saved.records[0].status, 'pending'); assert.equal(saved.records[0].clientRequestId, payload.clientRequestId); response.statusCode = 202; response.end(JSON.stringify({ provider: 'deepseek', model: 'fixture-model', taskId: 'fixture-page-task', status: 'pending' })); return; }
    assert.equal(url.pathname, '/v1/tasks/fixture-page-task'); assert.equal(url.searchParams.get('installationId'), installation); polled++; response.end(JSON.stringify({ provider: 'deepseek', taskId: 'fixture-page-task', status: 'ok', result: { blocks: [], warnings: [] }, usage: { status: 'reported', inputTokens: 10, outputTokens: 5 }, cost: { status: 'estimated', amount: .1, reserved: 5 } }));
  } catch (error) { errors.push(error); response.statusCode = 500; response.end('{}'); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address() as import('node:net').AddressInfo;
  const oldUrl = process.env.EVAL_GATEWAY_URL, oldToken = process.env.EVAL_GATEWAY_TOKEN; process.env.EVAL_GATEWAY_URL = `http://127.0.0.1:${address.port}`; process.env.EVAL_GATEWAY_TOKEN = 'local-eval-test-secret';
  try { await main(['run', '--manifest', manifest, '--run-file', runFile, '--allow-paid', '--budget-cny', '5', '--limit', '1']); assert.deepEqual(errors, []); assert.equal(posted, 1); assert.equal(polled, 1); const saved = await readJson(runFile); assert.equal(saved.records[0].status, 'ok'); assert.equal(saved.records[0].taskId, 'fixture-page-task'); assert.equal(saved.records[0].cost.amount, .1); assert.doesNotMatch(await readFile(runFile, 'utf8'), /local-eval-test-secret/); }
  finally { if (oldUrl === undefined) delete process.env.EVAL_GATEWAY_URL; else process.env.EVAL_GATEWAY_URL = oldUrl; if (oldToken === undefined) delete process.env.EVAL_GATEWAY_TOKEN; else process.env.EVAL_GATEWAY_TOKEN = oldToken; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}));
