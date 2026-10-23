import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { once } from 'node:events';

const root = resolve(import.meta.dirname, '..');
const mode = process.argv[2] || '--serve';
if (!['--serve', '--pull', '--status'].includes(mode) || process.argv.length > 3) throw new Error('Usage: node scripts/local-qwen.mjs [--serve|--pull|--status]');
const config = { ...process.env };
try { for (const [key, value] of Object.entries(parseEnv(await readFile(resolve(root, '.env'), 'utf8')))) config[key] ??= value; }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const url = new URL(config.OLLAMA_BASE_URL || 'http://127.0.0.1:11434');
if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('OLLAMA_BASE_URL must be a loopback origin.');
const model = config.OLLAMA_MODEL || 'qwen3-vl:2b-instruct';
if (!/^[A-Za-z0-9._:/-]{1,128}$/.test(model) || /(?:[:/-]cloud)(?:$|[:/-])/i.test(model)) throw new Error('Use a local model, for example qwen3-vl:2b-instruct.');
const modelDirectory = resolve(root, '.local/ollama-models');
const runtimeCandidates = [resolve(root, '.tools/ollama/v0.40.9/ollama.exe'), resolve(root, '.tools/ollama/ollama.exe')];
if (process.env.LOCALAPPDATA) runtimeCandidates.push(resolve(process.env.LOCALAPPDATA, 'Programs/Ollama/ollama.exe'));
const installed = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [process.platform === 'win32' ? 'ollama.exe' : 'ollama'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
if (installed.status === 0) runtimeCandidates.push(...installed.stdout.trim().split(/\r?\n/));
const executable = runtimeCandidates.find(path => existsSync(path));
async function running() {
  try { const response = await fetch(new URL('/api/version', url), { signal: AbortSignal.timeout(2500), redirect: 'error' }); return response.ok && typeof (await response.json()).version === 'string'; }
  catch { return false; }
}
async function status() {
  if (!await running()) throw new Error('Local Ollama is not running. Start Start-Qwen.cmd first.');
  const response = await fetch(new URL('/api/show', url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }), signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (response.status === 404) throw new Error('Model not found. Run Setup-Qwen.cmd or ollama pull qwen3-vl:2b-instruct.');
  const result = await response.json();
  if (!response.ok || result.remote_host || result.remote_model || !Array.isArray(result.capabilities) || !result.capabilities.includes('vision')) throw new Error('The selected model must be a downloaded local vision model.');
  console.log(`Local vision model ready: ${model} (${url.origin})`);
}
const childEnvironment = { ...process.env, OLLAMA_HOST: url.host, OLLAMA_MODELS: modelDirectory, OLLAMA_NO_CLOUD: '1', OLLAMA_KEEP_ALIVE: '60s', OLLAMA_CONTEXT_LENGTH: '4096', OLLAMA_NUM_PARALLEL: '1' };
for (const key of ['DEEPSEEK_API_KEY', 'MATHPIX_APP_ID', 'MATHPIX_APP_KEY', 'GATEWAY_PAIRING_TOKEN']) delete childEnvironment[key];
let owned;
async function stopOwned() {
  if (!owned || owned.exitCode !== null || owned.signalCode !== null) return;
  const exited = once(owned, 'exit'); owned.kill(); await exited;
}
try {
  if (mode === '--status') { await status(); }
  else {
    if (!await running()) {
      if (!executable) throw new Error('Ollama was not found. Install Ollama for Windows from https://ollama.com/download/windows and run this launcher again.');
      if (url.protocol !== 'http:') throw new Error('Start your local HTTPS proxy first; this launcher starts native HTTP Ollama only.');
      await mkdir(modelDirectory, { recursive: true });
      owned = spawn(executable, ['serve'], { cwd: root, env: childEnvironment, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'] });
      owned.on('error', error => { console.error(error.message); process.exitCode = 1; });
      process.once('SIGINT', () => void stopOwned()); process.once('SIGTERM', () => void stopOwned());
      for (let attempt = 0; !await running(); attempt++) {
        if (owned.exitCode !== null || attempt >= 60) throw new Error('Ollama did not start. Check the port and runtime above.');
        await new Promise(done => setTimeout(done, 500));
      }
      console.log(`MathInk local service: ${url.origin}; models: ${modelDirectory}`);
    } else console.log(`Using the existing local Ollama service: ${url.origin}`);
    if (mode === '--pull') {
      if (!executable) throw new Error('Install the Ollama CLI before downloading a model.');
      console.log(`Downloading ${model}; this is a large model download, not a paid cloud generation request.`);
      const pull = spawn(executable, ['pull', model], { cwd: root, env: childEnvironment, windowsHide: true, stdio: 'inherit' });
      const [code] = await once(pull, 'exit'); if (code !== 0) throw new Error('Model download failed. Run Setup-Qwen.cmd again to resume.');
      await status(); console.log('Setup complete. Keep Start-Qwen.cmd running when using MathInk local Qwen.');
    } else if (owned) {
      console.log('Keep this window open. Select Local Qwen in MathInk settings. Ctrl+C stops this service.');
      const [code] = await once(owned, 'exit'); if (code && !owned.signalCode) process.exitCode = code;
    }
  }
} catch (error) { console.error(error instanceof Error ? error.message : 'Local model setup failed.'); process.exitCode = 1; }
finally { await stopOwned(); }
