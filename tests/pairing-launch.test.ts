import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('LAN preview restart keeps pairing links usable and honors .env overrides', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mathink-pairing-launch-'));
  const webRoot = join(directory, 'web');
  await mkdir(webRoot);
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Pairing launcher fixture</title>');
  const children: ChildProcess[] = [];
  const close = async (child: ChildProcess) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  };
  t.after(async () => {
    await Promise.all(children.map(close));
    await rm(directory, { recursive: true, force: true });
  });
  async function launch() {
    const env: NodeJS.ProcessEnv = { ...process.env, OCR_PROVIDER: 'mock', GATEWAY_PORT: '0', GATEWAY_HOST: '127.0.0.1', GATEWAY_DATABASE_PATH: join(directory, 'quota.sqlite') };
    // No real pairing credentials are read or printed by this test.
    delete env.GATEWAY_PAIRING_TOKEN;
    const child = spawn(process.execPath, ['--env-file-if-exists=.env', resolve('scripts/serve-preview.mjs'), '--lan', '--lan-address', '192.0.2.45', '--web-root', webRoot], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    const entry = await new Promise<{ url: URL; token: string }>((done, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Pairing fixture did not start')), 10000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Pairing fixture exited before ready')); });
      child.stdout!.on('data', chunk => {
        output += chunk.toString();
        const match = output.match(/本机入口：(http:\/\/127\.0\.0\.1:\d+\/#mathink-pair=\S+)/);
        if (!match || !output.includes('平板入口：')) return;
        clearTimeout(timer);
        const url = new URL(match[1]);
        const token = decodeURIComponent(url.hash.slice('#mathink-pair='.length));
        assert.ok(output.includes(`http://192.0.2.45:${url.port}/#mathink-pair=${encodeURIComponent(token)}`));
        done({ url, token });
      });
      // Consume stderr without exposing any runtime configuration on successful tests.
      child.stderr!.on('data', () => {});
    });
    const paired = await fetch(new URL('/v1/pairing', entry.url), { headers: { Authorization: `Bearer ${entry.token}` } });
    assert.equal(paired.status, 200);
    assert.equal((await fetch(new URL('/v1/pairing', entry.url))).status, 401);
    await close(child);
    return entry.token;
  }
  const first = await launch();
  assert.equal(await launch(), first);
  assert.equal((await readFile(join(directory, '.local/pairing-token'), 'utf8')).trim(), first);
  const configured = 'unit-test-env-file-token-1234567';
  await writeFile(join(directory, '.env'), `GATEWAY_PAIRING_TOKEN=${configured}\n`);
  assert.equal(await launch(), configured);
  assert.equal((await readFile(join(directory, '.local/pairing-token'), 'utf8')).trim(), first);
});
