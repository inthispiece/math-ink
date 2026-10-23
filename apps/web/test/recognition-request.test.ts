import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { requestJson, RECOGNITION_TIMEOUT_MESSAGE } from '../src/recognition-request.ts';

test('response headers do not end the deadline: a stalled body times out and closes the request', async t => {
  let closed = false;
  let headersReceived = false;
  const server = createServer((_, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{"latex":');
    response.on('close', () => { closed = true; });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test server');
  await assert.rejects(requestJson(`http://127.0.0.1:${address.port}`, {}, {
    timeoutMs: 500,
    request: async (url, init) => { const response = await fetch(url, init); headersReceived = true; return response; },
  }), { message: RECOGNITION_TIMEOUT_MESSAGE });
  assert.equal(headersReceived, true);
  for (let attempt = 0; attempt < 50 && !closed; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(closed, true);
});

test('even a response body reader ignoring abort cannot leave recognition pending forever', async () => {
  const request = async () => ({ json: () => new Promise(() => {}) }) as Response;
  await assert.rejects(requestJson('http://gateway/v1/recognize', {}, { request, timeoutMs: 10 }), { message: RECOGNITION_TIMEOUT_MESSAGE });
});

test('cancelling before or during the request stops waiting without starting another call', async () => {
  const controller = new AbortController();
  let calls = 0;
  const request = async () => { calls++; return new Promise<Response>(() => {}); };
  const pending = requestJson('http://gateway/v1/recognize', { signal: controller.signal }, { request });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(requestJson('http://gateway/v1/recognize', { signal: controller.signal }, { request }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('valid results and server error bodies survive parsing; broken JSON and network failure are actionable', async () => {
  const success = await requestJson<{ latex: string }>('http://gateway', {}, { request: async () => Response.json({ latex: 'x^2' }) });
  assert.equal(success.data.latex, 'x^2');
  const unavailable = await requestJson<{ error: { message: string } }>('http://gateway', {}, { request: async () => Response.json({ error: { message: '请配置真实识别凭据' } }, { status: 503 }) });
  assert.equal(unavailable.response.status, 503);
  assert.equal(unavailable.data.error.message, '请配置真实识别凭据');
  await assert.rejects(requestJson('http://gateway', {}, { request: async () => new Response('<html>not an API</html>', { status: 404 }) }), /无效内容（HTTP 404）/);
  await assert.rejects(requestJson('http://gateway', {}, { request: async () => { throw new TypeError('Failed to fetch'); } }), /无法连接识别服务/);
});
