import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairingFromUrl, canPairLocally, recognitionFailureMessage } from '../src/pairing.ts';

test('a pairing URL preserves the note origin/path and removes the token from the fragment', () => {
  assert.deepEqual(pairingFromUrl('http://192.168.1.9:8787/index.html?view=ink#mathink-pair=test%2Bfixture%3D&tab=ink'), {
    token: 'test+fixture=', gatewayUrl: 'http://192.168.1.9:8787', cleanUrl: 'http://192.168.1.9:8787/index.html?view=ink#tab=ink',
  });
  assert.equal(pairingFromUrl('http://localhost:8787/#tab=ink'), undefined);
  assert.throws(() => pairingFromUrl('http://localhost:8787/#mathink-pair=%0A'), /无效/);
  assert.throws(() => pairingFromUrl('file:///notes/#mathink-pair=test-token'), /无效/);
});

test('automatic pairing is limited to a local page using its own gateway origin', () => {
  assert.equal(canPairLocally('http://localhost:8787', 'http://localhost:8787/index.html'), true);
  assert.equal(canPairLocally('http://[::1]:8787/', 'http://[::1]:8787/'), true);
  for (const [gateway, page] of [
    ['http://192.168.1.9:8787', 'http://192.168.1.9:8787/'],
    ['http://localhost:8787', 'https://example.test/'],
    ['http://localhost:8787', 'http://localhost:5173/'],
    ['http://localhost:8787/api', 'http://localhost:8787/'],
    ['http://user:password@localhost:8787', 'http://localhost:8787/'],
  ]) assert.equal(canPairLocally(gateway, page), false);
});

test('recognition errors retain the original-ink notice without duplicate punctuation', () => {
  assert.equal(recognitionFailureMessage('请填写正确的服务配对令牌。'), '请填写正确的服务配对令牌。原稿已保留。');
  assert.equal(recognitionFailureMessage('网络错误。。'), '网络错误。原稿已保留。');
  assert.equal(recognitionFailureMessage('识别超时，原稿已保留。'), '识别超时，原稿已保留。');
});
