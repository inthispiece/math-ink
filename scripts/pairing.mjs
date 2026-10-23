import { mkdir, open, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve, dirname } from 'node:path';

/** Reuse a LAN installation's pairing secret. Explicit environment/.env values always win. */
export async function ensurePairingToken({ env = process.env, directory = process.cwd(), required = false } = {}) {
  if (env.GATEWAY_PAIRING_TOKEN) return env.GATEWAY_PAIRING_TOKEN;
  if (!required) return '';
  const path = resolve(directory, '.local', 'pairing-token');
  const readExisting = async () => {
    // Another launcher can have won open('wx') and still be writing the tiny file.
    for (let attempt = 0; ; attempt++) {
      const token = (await readFile(path, 'utf8')).trim();
      if (/^[A-Za-z0-9_-]{24,128}$/.test(token)) return token;
      if (attempt >= 10) throw new Error('本机配对令牌文件无效，请检查 .local/pairing-token；未自动更换，以免使已配对设备失效。');
      await new Promise(done => setTimeout(done, 20));
    }
  };
  try { return env.GATEWAY_PAIRING_TOKEN = await readExisting(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let file;
  try { file = await open(path, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return env.GATEWAY_PAIRING_TOKEN = await readExisting();
  }
  try {
    const token = randomBytes(24).toString('base64url');
    await file.writeFile(token + '\n');
    await file.sync();
    env.GATEWAY_PAIRING_TOKEN = token;
    return token;
  } finally { await file.close(); }
}

export function pairingUrl(baseUrl, token = '') {
  const url = new URL(baseUrl);
  if (token) url.hash = 'mathink-pair=' + encodeURIComponent(token);
  return url.href;
}
