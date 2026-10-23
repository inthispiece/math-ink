import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Scripts run directly in the downloadable preview, without TypeScript or npm dependencies.
const pairingPath = pathToFileURL(join(process.cwd(), 'scripts/pairing.mjs')).href;
const { ensurePairingToken, pairingUrl } = await import(pairingPath);

async function temporary(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'mathink-pairing-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('LAN pairing secret persists across launches rather than invalidating existing devices', async t => {
  const directory = await temporary(t);
  const first: NodeJS.ProcessEnv = {};
  const token = await ensurePairingToken({ env: first, directory, required: true });
  assert.match(token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(first.GATEWAY_PAIRING_TOKEN, token);
  assert.equal((await readFile(join(directory, '.local/pairing-token'), 'utf8')).trim(), token);
  const second: NodeJS.ProcessEnv = {};
  assert.equal(await ensurePairingToken({ env: second, directory, required: true }), token);
  assert.equal(second.GATEWAY_PAIRING_TOKEN, token);
});

test('explicit environment or .env pairing token wins without overwriting saved installation secret', async t => {
  const directory = await temporary(t);
  const saved = await ensurePairingToken({ env: {}, directory, required: true });
  const configured = 'unit-test-explicit-token-123456';
  const env = { GATEWAY_PAIRING_TOKEN: configured };
  assert.equal(await ensurePairingToken({ env, directory, required: true }), configured);
  assert.equal(env.GATEWAY_PAIRING_TOKEN, configured);
  assert.equal((await readFile(join(directory, '.local/pairing-token'), 'utf8')).trim(), saved);
});

test('unpaired local mode needs no token and does not enable a saved LAN token unexpectedly', async t => {
  const directory = await temporary(t);
  assert.equal(await ensurePairingToken({ env: {}, directory }), '');
  await assert.rejects(readFile(join(directory, '.local/pairing-token')), { code: 'ENOENT' });
  await ensurePairingToken({ env: {}, directory, required: true });
  assert.equal(await ensurePairingToken({ env: {}, directory, required: false }), '');
});

test('simultaneous launchers create one pairing secret', async t => {
  const directory = await temporary(t);
  const tokens = await Promise.all(Array.from({ length: 8 }, () => ensurePairingToken({ env: {}, directory, required: true })));
  assert.equal(new Set(tokens).size, 1);
});

test('invalid persisted token fails clearly rather than replacing the secret silently', async t => {
  const directory = await temporary(t);
  await mkdir(join(directory, '.local'));
  await writeFile(join(directory, '.local/pairing-token'), 'broken');
  await assert.rejects(ensurePairingToken({ env: {}, directory, required: true }), /未自动更换/);
  assert.equal(await readFile(join(directory, '.local/pairing-token'), 'utf8'), 'broken');
});

test('pairing links keep credentials in encoded fragments and retain the preview origin', () => {
  const url = new URL(pairingUrl('http://192.0.2.4:8787/', 'unit-test+token/&=1?'));
  assert.equal(url.origin, 'http://192.0.2.4:8787');
  assert.equal(url.search, '');
  assert.equal(url.hash, '#mathink-pair=unit-test%2Btoken%2F%26%3D1%3F');
  assert.equal(pairingUrl('http://localhost:8787/', ''), 'http://localhost:8787/');
});
