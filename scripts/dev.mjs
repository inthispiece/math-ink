import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';

const args = new Set(process.argv.slice(2));
const env = { ...process.env };
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (match && env[match[1]] === undefined) env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
if (args.has('--demo')) env.OCR_PROVIDER = 'mock';
if (args.has('--real')) env.OCR_PROVIDER = 'mathpix';
env.OCR_PROVIDER ??= 'mock';
env.GATEWAY_PORT ??= '8787';
env.GATEWAY_HOST = args.has('--lan') ? '0.0.0.0' : '127.0.0.1';
if (args.has('--lan')) env.GATEWAY_PAIRING_TOKEN ||= randomBytes(24).toString('base64url');
const lanAddresses = Object.values(networkInterfaces()).flatMap(entries => entries ?? []).filter(entry => entry.family === 'IPv4' && !entry.internal).map(entry => entry.address);
env.GATEWAY_ALLOWED_ORIGINS = [...new Set(['http://localhost:5173', 'http://127.0.0.1:5173', ...(env.GATEWAY_ALLOWED_ORIGINS || '').split(',').filter(Boolean), ...lanAddresses.map(address => `http://${address}:5173`)])].join(',');
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
console.log(`MathInk ${env.OCR_PROVIDER === 'mock' ? '演示识别（预设结果）' : '真实联网识别'}：http://localhost:5173`);
if (args.has('--lan')) {
  console.log(`平板配对令牌（请填入应用设置）：${env.GATEWAY_PAIRING_TOKEN}`);
  for (const entries of Object.values(networkInterfaces())) for (const entry of entries ?? []) {
    if (entry.family === 'IPv4' && !entry.internal) console.log(`局域网：http://${entry.address}:5173（仅开发联调）`);
  }
}
run(resolve('apps/gateway/src/server.ts'), []);
run(resolve('node_modules/vite/bin/vite.js'), ['apps/web', '--config', 'vite.config.ts', '--host', env.GATEWAY_HOST]);
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
