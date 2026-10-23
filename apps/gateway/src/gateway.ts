import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { configFromEnv } from './config.ts';
import type { GatewayConfig } from './config.ts';
import { MockProvider, MathpixProvider } from './providers.ts';
import { decodePngBase64 } from './png.ts';
import { QuotaStore } from './store.ts';
import { GatewayError } from './types.ts';
import type { RecognitionProvider, RecognitionRequest, RecognitionResponse } from './types.ts';

interface Result { statusCode: number; body: RecognitionResponse }

/** Bootstrap is only for a browser talking directly to this computer's local server. */
export function checkLocalPairingRequest(request: IncomingMessage): void {
  const reject = () => { throw new GatewayError('LOCAL_PAIRING_NOT_ALLOWED', '本机自动配对仅允许在本机同源页面使用；其他设备请手动填写配对令牌。', 403); };
  const address = request.socket.remoteAddress?.toLowerCase();
  const loopback = Boolean(address && (
    (isIP(address) === 4 && address.startsWith('127.')) ||
    address === '::1' ||
    (address.startsWith('::ffff:') && isIP(address.slice(7)) === 4 && address.slice(7).startsWith('127.'))
  ));
  if (!loopback) reject();
  const host = request.headers.host;
  // Accept these literal host names only. URL-normalized aliases and DNS names must not
  // turn a remote site's DNS-rebinding request into a trusted localhost request.
  if (!host || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host)) reject();
  // Never bootstrap credentials through a reverse proxy, even when its upstream
  // connection is loopback and it rewrites Host to localhost.
  if (Object.keys(request.headers).some(name => name === 'forwarded' || name === 'via' || name.startsWith('x-forwarded-'))) reject();
  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') reject();
  const origin = request.headers.origin;
  const protocol = (request.socket as typeof request.socket & { encrypted?: boolean }).encrypted ? 'https:' : 'http:';
  try {
    const expectedOrigin = new URL(`${protocol}//${host}`).origin;
    // Check the full origin, including scheme and port, without the general CORS
    // allow-list exception used by recognition and explicit manual pairing.
    if (origin !== undefined && origin !== expectedOrigin) reject();
  } catch { reject(); }
}

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function readBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  if (Number(request.headers['content-length']) > maxBytes) throw new GatewayError('BODY_TOO_LARGE', '选区图片过大，请缩小圈选范围。', 413);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const cleanup = () => {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      request.off('aborted', onAborted);
    };
    const fail = (error: Error) => { cleanup(); request.resume(); reject(error); };
    const onData = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) return fail(new GatewayError('BODY_TOO_LARGE', '选区图片过大，请缩小圈选范围。', 413));
      chunks.push(chunk);
    };
    const onError = () => fail(new GatewayError('INVALID_REQUEST', '请求未完整上传。'));
    const onAborted = () => fail(new GatewayError('INVALID_REQUEST', '请求已取消。'));
    const onEnd = () => {
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new GatewayError('INVALID_JSON', '请求内容必须为有效的 JSON。')); }
    };
    request.on('data', onData);
    request.on('end', onEnd);
    request.on('error', onError);
    request.on('aborted', onAborted);
  });
}

function validateRequest(input: unknown): RecognitionRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new GatewayError('INVALID_REQUEST', '识别请求格式无效。');
  const object = input as Record<string, unknown>;
  const fields = ['clientRequestId', 'installationId', 'imageBase64', 'sourceRevision'];
  if (Object.keys(object).some(key => !fields.includes(key))) throw new GatewayError('INVALID_REQUEST', '识别请求包含未知字段。');
  for (const field of ['clientRequestId', 'installationId']) {
    if (typeof object[field] !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(object[field] as string)) {
      throw new GatewayError('INVALID_REQUEST', `${field} 必须为 8–128 位的字母、数字或标识符。`);
    }
  }
  if (!Number.isSafeInteger(object.sourceRevision) || (object.sourceRevision as number) < 0) throw new GatewayError('INVALID_REQUEST', 'sourceRevision 必须为非负整数。');
  if (typeof object.imageBase64 !== 'string') throw new GatewayError('INVALID_IMAGE', '请上传 PNG 选区图片。');
  return object as unknown as RecognitionRequest;
}

export function createGateway(options: { config?: GatewayConfig; provider?: RecognitionProvider; store?: QuotaStore; now?: () => number } = {}) {
  const config = options.config || configFromEnv();
  const provider = options.provider || (config.provider === 'mock' ? new MockProvider() : new MathpixProvider({ appId: config.mathpixAppId, appKey: config.mathpixAppKey }));
  const store = options.store || new QuotaStore(config.databasePath);
  const now = options.now || Date.now;
  const inFlight = new Map<string, Promise<Result>>();
  const cache = new Map<string, { expiresAt: number; result: Result }>();

  const errorResult = (error: unknown, requestId: string = randomUUID(), sourceRevision = 0): Result => {
    const safe = error instanceof GatewayError ? error : new GatewayError('INTERNAL_ERROR', '服务暂时不可用，请稍后检查服务状态。', 500);
    return {
      statusCode: safe.statusCode,
      body: { requestId, status: 'error', provider: provider.name, simulated: provider.simulated, sourceRevision, error: { code: safe.code, message: safe.message, retryable: safe.retryable } },
    };
  };

  const send = (response: ServerResponse, statusCode: number, body: unknown) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.statusCode = statusCode;
    response.end(JSON.stringify(body));
  };

  const checkOrigin = (request: IncomingMessage, response: ServerResponse) => {
    const origin = request.headers.origin;
    if (!origin) return;
    // Local same-origin servers are allowed; other WebView/dev origins must be explicitly listed.
    let sameHost = false;
    try { sameHost = new URL(origin).host === request.headers.host && ['http:', 'https:'].includes(new URL(origin).protocol); }
    catch { throw new GatewayError('ORIGIN_NOT_ALLOWED', '请求来源未配置。', 403); }
    if (!sameHost && !config.allowedOrigins.includes(origin)) throw new GatewayError('ORIGIN_NOT_ALLOWED', '请求来源未配置。', 403);
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  };

  const checkToken = (request: IncomingMessage) => {
    if (!config.pairingToken) return;
    const actual = request.headers.authorization || '';
    const expected = `Bearer ${config.pairingToken}`;
    const actualBytes = Buffer.from(actual);
    const expectedBytes = Buffer.from(expected);
    if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
      throw new GatewayError('UNAUTHORIZED', '请填写正确的服务配对令牌。', 401);
    }
  };

  const recognize = async (input: RecognitionRequest, image: Buffer): Promise<Result> => {
    if (!provider.configured) return errorResult(new GatewayError('PROVIDER_NOT_CONFIGURED', '真实识别尚未配置，请在服务端设置 Mathpix 凭据。', 503), undefined, input.sourceRevision);
    const requestKey = hash(`${provider.name}\0${input.installationId}\0${input.clientRequestId}`);
    const fingerprint = hash(`${input.sourceRevision}\0${hash(image)}`);
    const reservation = store.reserve({ requestKey, requestId: randomUUID(), installationHash: hash(input.installationId), fingerprint, now: now() }, config);
    if (reservation.existing) {
      const pending = inFlight.get(requestKey);
      if (pending) return pending;
      const completed = cache.get(requestKey);
      if (completed && completed.expiresAt > now()) return completed.result;
      cache.delete(requestKey);
      return errorResult(new GatewayError('REQUEST_RESULT_UNAVAILABLE', '该请求已提交，缓存结果已不可用。为避免重复计费不会再次识别；请核对后手动创建新请求。', 409), reservation.requestId, input.sourceRevision);
    }
    const task = (async (): Promise<Result> => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let result: Result;
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new GatewayError('PROVIDER_TIMEOUT', '识别超时。请求可能已计费，请核对后手动重试。', 504));
          }, config.requestTimeoutMs);
        });
        const recognized = await Promise.race([provider.recognize(image, controller.signal), timeout]);
        if (!recognized.latex.trim()) throw new GatewayError('NO_FORMULA', '选区未返回可编辑的公式。', 422);
        result = { statusCode: 200, body: { requestId: reservation.requestId, status: 'ok', provider: provider.name, simulated: provider.simulated, sourceRevision: input.sourceRevision, ...recognized } };
      } catch (error) {
        result = errorResult(error, reservation.requestId, input.sourceRevision);
      } finally {
        if (timer) clearTimeout(timer);
      }
      store.complete(requestKey, result.body.status);
      for (const [key, value] of cache) if (value.expiresAt <= now()) cache.delete(key);
      while (cache.size >= config.maxCachedResults) cache.delete(cache.keys().next().value!);
      cache.set(requestKey, { result, expiresAt: now() + config.resultTtlMs });
      return result;
    })();
    inFlight.set(requestKey, task);
    try { return await task; }
    finally { inFlight.delete(requestKey); }
  };

  async function handle(request: IncomingMessage, response: ServerResponse) {
    let sourceRevision = 0;
    try {
      const path = new URL(request.url || '/', 'http://gateway.local').pathname;
      if (!['/v1/recognize', '/v1/status', '/v1/pairing', '/v1/local-pairing', '/health'].includes(path)) {
        send(response, 404, { error: { code: 'NOT_FOUND', message: '接口不存在。' } });
        return;
      }
      checkOrigin(request, response);
      if (path === '/v1/local-pairing') checkLocalPairingRequest(request);
      if (request.method === 'OPTIONS') { response.statusCode = 204; response.end(); return; }
      if ((path === '/health' || path === '/v1/status') && request.method === 'GET') {
        send(response, 200, { status: 'ok', provider: provider.name, simulated: provider.simulated, configured: provider.configured, pairingRequired: Boolean(config.pairingToken), limits: { installationDaily: config.installationDailyLimit, globalDaily: config.globalDailyLimit, globalMonthly: config.globalMonthlyLimit, maxImageBytes: config.maxImageBytes }, timeZone: config.timeZone });
        return;
      }
      if (path === '/v1/pairing' && request.method === 'GET') {
        checkToken(request);
        send(response, 200, { status: 'ok', pairingRequired: Boolean(config.pairingToken) });
        return;
      }
      if (path === '/v1/local-pairing' && request.method === 'GET') {
        send(response, 200, { status: 'ok', pairingRequired: Boolean(config.pairingToken), pairingToken: config.pairingToken });
        return;
      }
      if (path !== '/v1/recognize' || request.method !== 'POST') {
        response.setHeader('Allow', path === '/v1/recognize' ? 'POST, OPTIONS' : 'GET, OPTIONS');
        throw new GatewayError('METHOD_NOT_ALLOWED', '请求方法不支持。', 405);
      }
      checkToken(request);
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) throw new GatewayError('INVALID_CONTENT_TYPE', '请求必须使用 application/json。', 415);
      const input = validateRequest(await readBody(request, config.maxBodyBytes));
      sourceRevision = input.sourceRevision;
      const image = decodePngBase64(input.imageBase64, config.maxImageBytes);
      const result = await recognize(input, image);
      send(response, result.statusCode, result.body);
    } catch (error) {
      const result = errorResult(error, undefined, sourceRevision);
      send(response, result.statusCode, result.body);
    }
  }

  return { handle, config, provider, close: () => store.close() };
}
