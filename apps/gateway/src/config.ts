import { GatewayError } from './types.ts';
import type { ProviderName } from './types.ts';

export interface GatewayConfig {
  host: string;
  port: number;
  provider: ProviderName;
  databasePath: string;
  pairingToken: string;
  mathpixAppId: string;
  mathpixAppKey: string;
  deepseekApiKey: string;
  deepseekModel: string;
  deepseekTimeoutMs: number;
  ollamaBaseUrl: string;
  ollamaModel: string;
  ollamaTimeoutMs: number;
  requestTimeoutMs: number;
  installationDailyLimit: number;
  globalDailyLimit: number;
  globalMonthlyLimit: number;
  timeZone: string;
  allowedOrigins: string[];
  maxImageBytes: number;
  maxBodyBytes: number;
  resultTtlMs: number;
  maxCachedResults: number;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const integer = (name: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER) => {
    const raw = env[name];
    const value = raw === undefined || raw === '' ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new GatewayError('CONFIG_INVALID', `${name} 配置无效。`, 500);
    }
    return value;
  };
  const provider = env.OCR_PROVIDER || 'mock';
  if (!['mock', 'mathpix', 'deepseek', 'ollama'].includes(provider)) {
    throw new GatewayError('CONFIG_INVALID', 'OCR_PROVIDER 必须为 mock、mathpix、deepseek 或 ollama。', 500);
  }
  const ollamaBaseUrl = env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
  try {
    const url = new URL(ollamaBaseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
  } catch { throw new GatewayError('CONFIG_INVALID', 'OLLAMA_BASE_URL 必须为本机回环 HTTP 或 HTTPS 地址，不能包含凭据、路径或查询参数。', 500); }
  const host = env.GATEWAY_HOST || '127.0.0.1';
  const pairingToken = env.GATEWAY_PAIRING_TOKEN || '';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && pairingToken.length < 24) {
    throw new GatewayError('CONFIG_INVALID', '局域网监听必须配置至少 24 个字符的 GATEWAY_PAIRING_TOKEN。', 500);
  }
  const timeZone = env.GATEWAY_TIME_ZONE || 'Asia/Shanghai';
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone }).format();
  } catch {
    throw new GatewayError('CONFIG_INVALID', 'GATEWAY_TIME_ZONE 配置无效。', 500);
  }
  return {
    host,
    port: integer('GATEWAY_PORT', 8787, 0, 65535),
    provider: provider as ProviderName,
    databasePath: env.GATEWAY_DATABASE_PATH || '.local/gateway.sqlite',
    pairingToken,
    mathpixAppId: env.MATHPIX_APP_ID || '',
    mathpixAppKey: env.MATHPIX_APP_KEY || '',
    deepseekApiKey: env.DEEPSEEK_API_KEY || '',
    deepseekModel: env.DEEPSEEK_MODEL || 'deepseek-flash',
    deepseekTimeoutMs: integer('DEEPSEEK_TIMEOUT_MS', 45000, 1, 300000),
    ollamaBaseUrl: new URL(ollamaBaseUrl).origin,
    ollamaModel: env.OLLAMA_MODEL || 'qwen3-vl:2b-instruct',
    ollamaTimeoutMs: integer('OLLAMA_TIMEOUT_MS', 180000, 1, 600000),
    requestTimeoutMs: integer('OCR_TIMEOUT_MS', 20000, 1, 120000),
    installationDailyLimit: integer('OCR_INSTALLATION_DAILY_LIMIT', 10),
    globalDailyLimit: integer('OCR_GLOBAL_DAILY_LIMIT', 200),
    globalMonthlyLimit: integer('OCR_GLOBAL_MONTHLY_LIMIT', 2000),
    timeZone,
    allowedOrigins: (env.GATEWAY_ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173').split(',').map(value => value.trim()).filter(Boolean),
    maxImageBytes: 1_400_000,
    maxBodyBytes: 2_000_000,
    resultTtlMs: 24 * 60 * 60 * 1000,
    maxCachedResults: 1000,
  };
}
