import { GatewayError } from './types.ts';
import type { ProviderName, PriceConfig } from './types.ts';
import { isIP } from 'node:net';

/** Canonical literal address comparison; never performs DNS or prefix matching. */
export function normalizeLiteralIp(value: string): string | null {
  if(typeof value!=='string'||!value||value!==value.trim()||value.includes('%'))return null;
  const family=isIP(value);
  if(family===4)return value;
  if(family!==6)return null;
  let canonical:string;
  try{canonical=new URL(`http://[${value}]/`).hostname.slice(1,-1).toLowerCase();}catch{return null;}
  const mapped=/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if(mapped){const high=parseInt(mapped[1],16),low=parseInt(mapped[2],16);return `${high>>>8}.${high&255}.${low>>>8}.${low&255}`;}
  return canonical;
}

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
  authMode: 'local' | 'hosted';
  priceConfig: PriceConfig | null;
  taskTimeoutMs: number;
  taskMaxOutputTokens: number;
  taskMaxContextBytes: number;
  taskMaxBlocks: number;
  taskReserveCny: number;
  taskMaxCostCny: number;
  userMonthlyLimit: number;
  userDailyBudgetCny: number;
  userMonthlyBudgetCny: number;
  globalDailyBudgetCny: number;
  globalMonthlyBudgetCny: number;
  userConcurrency: number;
  globalConcurrency: number;
  userRequestsPerMinute: number;
  globalRequestsPerMinute: number;
  trustedProxyIps: string[];
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
  const amount = (name: string, fallback: number) => {
    const value = env[name] === undefined || env[name] === '' ? fallback : Number(env[name]);
    if (!Number.isFinite(value) || value <= 0 || value > 1_000_000) throw new GatewayError('CONFIG_INVALID', `${name} 必须为正金额。`, 500);
    return value;
  };
  const authMode = env.GATEWAY_AUTH_MODE || 'local';
  if (!['local', 'hosted'].includes(authMode)) throw new GatewayError('CONFIG_INVALID', 'GATEWAY_AUTH_MODE 必须为 local 或 hosted。', 500);
  const proxyValues=env.GATEWAY_TRUSTED_PROXY_IPS?.trim()?env.GATEWAY_TRUSTED_PROXY_IPS.split(',').map(value=>value.trim()):[];
  const trustedProxyIps=proxyValues.map(value=>normalizeLiteralIp(value));
  if(trustedProxyIps.some(value=>value===null))throw new GatewayError('CONFIG_INVALID','GATEWAY_TRUSTED_PROXY_IPS 仅接受逗号分隔的明确 IPv4 或 IPv6 地址，不支持主机名、CIDR、端口或地址前缀。',500);
  let priceConfig: PriceConfig | null = null;
  if (env.AI_PRICE_CONFIG) {
    try {
      const value = JSON.parse(env.AI_PRICE_CONFIG);
      if (!value || typeof value !== 'object' || typeof value.model !== 'string' || !value.model || !/^\d{4}-\d{2}-\d{2}$/.test(value.date) || new Date(value.date).toISOString().slice(0,10) !== value.date || value.currency !== 'CNY' || ![value.inputPerMillion,value.outputPerMillion].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0) || (value.cachedInputPerMillion !== undefined && (!Number.isFinite(value.cachedInputPerMillion) || value.cachedInputPerMillion < 0 || value.cachedInputPerMillion > value.inputPerMillion))) throw new Error();
      priceConfig = value;
    } catch { throw new GatewayError('CONFIG_INVALID', 'AI_PRICE_CONFIG 必须为包含 model/date/currency:CNY/inputPerMillion/outputPerMillion 的有效价格 JSON。', 500); }
  }
  const provider = env.OCR_PROVIDER || (authMode === 'hosted' ? 'deepseek' : 'mock');
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
  if (authMode === 'local' && !['127.0.0.1', '::1', 'localhost'].includes(host) && pairingToken.length < 24) {
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
    authMode: authMode as 'local' | 'hosted', priceConfig,
    taskTimeoutMs: integer('AI_TASK_TIMEOUT_MS', 120000, 1, 300000),
    taskMaxOutputTokens: integer('AI_TASK_MAX_OUTPUT_TOKENS', 8192, 256, 16384),
    taskMaxContextBytes: integer('AI_TASK_MAX_CONTEXT_BYTES', 32000, 1000, 64000),
    taskMaxBlocks: integer('AI_TASK_MAX_BLOCKS', 80, 1, 200),
    taskReserveCny: amount('AI_REQUEST_RESERVE_CNY', 0.5),
    taskMaxCostCny: amount('AI_TASK_MAX_COST_CNY', 5),
    userMonthlyLimit: integer('OCR_USER_MONTHLY_LIMIT', 200),
    userDailyBudgetCny: amount('AI_USER_DAILY_BUDGET_CNY', 5),
    userMonthlyBudgetCny: amount('AI_USER_MONTHLY_BUDGET_CNY', 50),
    globalDailyBudgetCny: amount('AI_GLOBAL_DAILY_BUDGET_CNY', 50),
    globalMonthlyBudgetCny: amount('AI_GLOBAL_MONTHLY_BUDGET_CNY', 500),
    userConcurrency: integer('AI_USER_CONCURRENCY', 1, 1, 10),
    globalConcurrency: integer('AI_GLOBAL_CONCURRENCY', 4, 1, 100),
    userRequestsPerMinute: integer('AI_USER_REQUESTS_PER_MINUTE', 10, 1, 1000),
    globalRequestsPerMinute: integer('AI_GLOBAL_REQUESTS_PER_MINUTE', 60, 1, 10000),
    trustedProxyIps:[...new Set(trustedProxyIps as string[])],
  };
}
