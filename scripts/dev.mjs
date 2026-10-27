import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { ensurePairingToken, pairingUrl } from './pairing.mjs';
await import('./prepare-pdf-assets.mjs');

const args = new Set(process.argv.slice(2));
const env = { ...process.env };
if (existsSync('.env')) {
  for (const [key, value] of Object.entries(parseEnv(readFileSync('.env', 'utf8')))) if (env[key] === undefined) env[key] = value;
}
if (args.has('--demo')) env.OCR_PROVIDER = 'mock';
if (args.has('--real')) env.OCR_PROVIDER = env.OCR_PROVIDER && env.OCR_PROVIDER !== 'mock' ? env.OCR_PROVIDER : 'deepseek';
if (args.has('--local')) env.OCR_PROVIDER = 'ollama';
if (args.has('--mathpix')) env.OCR_PROVIDER = 'mathpix';
env.OCR_PROVIDER ??= 'mock';
env.GATEWAY_PORT ??= '8787';
env.MATHINK_WEB_PORT ??= '5173';
env.GATEWAY_HOST = args.has('--lan') ? '0.0.0.0' : '127.0.0.1';
const hosted = env.GATEWAY_AUTH_MODE === 'hosted';
if (!hosted) await ensurePairingToken({ env, required: args.has('--lan') });
else env.GATEWAY_PAIRING_TOKEN = '';
const lanAddresses = Object.values(networkInterfaces()).flatMap(entries => entries ?? []).filter(entry => entry.family === 'IPv4' && !entry.internal).map(entry => entry.address);
env.GATEWAY_ALLOWED_ORIGINS = [...new Set([`http://localhost:${env.MATHINK_WEB_PORT}`, `http://127.0.0.1:${env.MATHINK_WEB_PORT}`, ...(env.GATEWAY_ALLOWED_ORIGINS || '').split(',').filter(Boolean), ...lanAddresses.map(address => `http://${address}:${env.MATHINK_WEB_PORT}`)])].join(',');
const children = [];
let shuttingDown = false;
function stop(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill();
  process.exitCode = code;
}
function run(file, argv) {
  const child = spawn(process.execPath, [file, ...argv], { env, stdio: 'inherit' });
  children.push(child);
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => { if (!shuttingDown) stop(code ?? 1); });
}
console.log(`MathInk ${env.OCR_PROVIDER === 'mock' ? '演示识别（预设结果）' : env.OCR_PROVIDER === 'ollama' ? '电脑本地识别' : '真实联网识别'}：${pairingUrl(`http://localhost:${env.MATHINK_WEB_PORT}`, env.GATEWAY_PAIRING_TOKEN)}`);
if (env.GATEWAY_PAIRING_TOKEN) console.log(`本机入口：${pairingUrl(`http://127.0.0.1:${env.MATHINK_WEB_PORT}`, env.GATEWAY_PAIRING_TOKEN)}`);
if (args.has('--lan')) {
  console.log(hosted ? '托管账号开发模式：入口不含配对凭据，需要登录。正式公开服务请使用 HTTPS。' : '请直接打开以下配对入口，浏览器会保存令牌。地址含配对凭据，请勿公开分享（仅开发联调）。');
  for (const address of lanAddresses) console.log(`局域网：${pairingUrl(`http://${address}:${env.MATHINK_WEB_PORT}`, env.GATEWAY_PAIRING_TOKEN)}`);
}
run(resolve('apps/gateway/src/server.ts'), []);
run(resolve('node_modules/vite/bin/vite.js'), ['apps/web', '--config', 'vite.config.ts', '--host', env.GATEWAY_HOST, '--port', env.MATHINK_WEB_PORT, '--strictPort']);
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
