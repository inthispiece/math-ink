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
  if (provider !== 'mock' && provider !== 'mathpix') {
    throw new GatewayError('CONFIG_INVALID', 'OCR_PROVIDER 必须为 mock 或 mathpix。', 500);
  }
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
    provider,
    databasePath: env.GATEWAY_DATABASE_PATH || '.local/gateway.sqlite',
    pairingToken,
    mathpixAppId: env.MATHPIX_APP_ID || '',
    mathpixAppKey: env.MATHPIX_APP_KEY || '',
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
