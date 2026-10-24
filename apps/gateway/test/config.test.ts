import test from 'node:test';
import assert from 'node:assert/strict';
import { configFromEnv, normalizeLiteralIp } from '../src/config.ts';

test('AI configuration defaults are explicit and provider selection stays compatible', () => {
  const defaults = configFromEnv({});
  assert.equal(defaults.provider, 'mock');
  assert.equal(defaults.deepseekApiKey, '');
  assert.equal(defaults.deepseekModel, 'deepseek-flash');
  assert.equal(defaults.deepseekTimeoutMs, 45000);
  assert.equal(defaults.ollamaBaseUrl, 'http://127.0.0.1:11434');
  assert.equal(defaults.ollamaModel, 'qwen3-vl:2b-instruct');
  assert.equal(defaults.ollamaTimeoutMs, 180000);
  for (const provider of ['mock', 'mathpix', 'deepseek', 'ollama']) assert.equal(configFromEnv({ OCR_PROVIDER: provider }).provider, provider);
  assert.throws(() => configFromEnv({ OCR_PROVIDER: 'other-provider' }), /OCR_PROVIDER/);
});

test('AI provider environment uses server values and validates timeouts', () => {
  const configured = configFromEnv({ DEEPSEEK_API_KEY: 'unit-test-key', DEEPSEEK_MODEL: 'deepseek-flash', DEEPSEEK_TIMEOUT_MS: '50000', OLLAMA_BASE_URL: 'http://localhost:11435/', OLLAMA_MODEL: 'qwen3-vl:4b', OLLAMA_TIMEOUT_MS: '200000' });
  assert.equal(configured.deepseekApiKey, 'unit-test-key');
  assert.equal(configured.deepseekTimeoutMs, 50000);
  assert.equal(configured.ollamaBaseUrl, 'http://localhost:11435');
  assert.equal(configured.ollamaModel, 'qwen3-vl:4b');
  assert.equal(configured.ollamaTimeoutMs, 200000);
  for (const name of ['DEEPSEEK_TIMEOUT_MS', 'OLLAMA_TIMEOUT_MS']) {
    for (const value of ['0', '-1', '1.5', 'invalid', '999999999']) assert.throws(() => configFromEnv({ [name]: value }), new RegExp(name));
  }
});

test('Ollama configuration permits only direct server-side loopback origins', () => {
  for (const origin of ['http://127.0.0.1:11434', 'http://localhost:11434', 'https://[::1]:11434']) assert.equal(configFromEnv({ OLLAMA_BASE_URL: origin }).ollamaBaseUrl, origin);
  for (const invalid of ['http://192.168.1.20:11434', 'https://example.test', 'http://localhost.evil.test:11434', 'http://localhost:11434/api/chat', 'http://localhost:11434?url=http://example.test', 'http://localhost:11434/#fragment', 'http://user:secret@localhost:11434', 'file:///model', 'not-a-url']) {
    assert.throws(() => configFromEnv({ OLLAMA_BASE_URL: invalid }), error => error instanceof Error && error.message.includes('OLLAMA_BASE_URL') && !error.message.includes(invalid));
  }
});

test('trusted proxy configuration accepts only explicit canonical literal addresses',()=>{
  assert.deepEqual(configFromEnv({}).trustedProxyIps,[]);
  assert.deepEqual(configFromEnv({GATEWAY_TRUSTED_PROXY_IPS:'172.30.73.3,::ffff:172.30.73.3,2001:0DB8:0:0::1'}).trustedProxyIps,['172.30.73.3','2001:db8::1']);
  assert.equal(normalizeLiteralIp('0:0:0:0:0:ffff:7f00:1'),'127.0.0.1');
  assert.equal(normalizeLiteralIp('::FFFF:127.0.0.1'),'127.0.0.1');
  for(const value of ['localhost','172.30.73.0/24','172.30.73.','172.30.73.3:8787','[::1]','1.2.3.999','127.000.0.1','::1%eth0','172.30.73.3,,127.0.0.1'])assert.throws(()=>configFromEnv({GATEWAY_TRUSTED_PROXY_IPS:value}),/GATEWAY_TRUSTED_PROXY_IPS/);
});
