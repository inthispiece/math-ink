import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { configFromEnv, normalizeLiteralIp } from './config.ts';
import type { GatewayConfig } from './config.ts';
import { MockProvider, MathpixProvider } from './providers.ts';
import { DeepSeekProvider, OllamaProvider } from './ai-providers.ts';
import { decodePngBase64 } from './png.ts';
import { QuotaStore } from './store.ts';
import { HostedAuthStore } from './hosted-auth.ts';
import { TaskManager } from './task-manager.ts';
import { TASK_PROMPT_VERSION, taskCapabilityTable, validateTaskRequest } from './tasks.ts';
import { estimateCost, reserveAmount, unknownUsage } from './accounting.ts';
import { GatewayError } from './types.ts';
import type { ProviderName, RecognitionProvider, RecognitionRequest, RecognitionResponse, RecognitionResult, RecognitionTaskResponse, ReviewRequest, ReviewResponse, ReviewResult, TokenUsage } from './types.ts';

interface Result { statusCode: number; body: RecognitionResponse | ReviewResponse }
const providerNames: ProviderName[] = ['deepseek', 'ollama', 'mathpix', 'mock'];
const providerLabels: Record<ProviderName, string> = { deepseek: 'DeepSeek', ollama: 'Ollama 本地模型', mathpix: 'Mathpix', mock: '固定样例演示' };

/** Only a pinned proxy socket may supply a single overwritten client IP. */
export function authenticationSourceIp(request:Pick<IncomingMessage,'socket'|'headers'>,trustedProxyIps:readonly string[]):string {
  const socketIp=normalizeLiteralIp(request.socket.remoteAddress||'');
  if(!socketIp)return 'unknown';
  if(!trustedProxyIps.some(ip=>normalizeLiteralIp(ip)===socketIp))return socketIp;
  const forwarded=request.headers['x-forwarded-for'];
  // Ignore malformed, multi-hop or repeated values. Caddy must overwrite this
  // header with remote_host; appending an untrusted chain is not supported.
  const clientIp=typeof forwarded==='string'?normalizeLiteralIp(forwarded.trim()):null;
  return clientIp||socketIp;
}

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

function validateCommon(input: unknown, fields: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new GatewayError('INVALID_REQUEST', '识别请求格式无效。');
  const object = input as Record<string, unknown>;
  if (Object.keys(object).some(key => !fields.includes(key))) throw new GatewayError('INVALID_REQUEST', '识别请求包含未知字段。');
  for (const field of ['clientRequestId', 'installationId']) {
    if (typeof object[field] !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(object[field] as string)) {
      throw new GatewayError('INVALID_REQUEST', `${field} 必须为 8–128 位的字母、数字或标识符。`);
    }
  }
  if (!Number.isSafeInteger(object.sourceRevision) || (object.sourceRevision as number) < 0) throw new GatewayError('INVALID_REQUEST', 'sourceRevision 必须为非负整数。');
  if (object.provider !== undefined && !providerNames.includes(object.provider as ProviderName)) throw new GatewayError('INVALID_PROVIDER', '请选择受支持的识别服务。');
  return object;
}

function validateRequest(input: unknown): RecognitionRequest {
  const object = validateCommon(input, ['clientRequestId', 'installationId', 'imageBase64', 'sourceRevision', 'provider']);
  if (typeof object.imageBase64 !== 'string') throw new GatewayError('INVALID_IMAGE', '请上传 PNG 选区图片。');
  return object as unknown as RecognitionRequest;
}

function validateReview(input: unknown): ReviewRequest {
  const object = validateCommon(input, ['clientRequestId', 'installationId', 'sourceRevision', 'provider', 'latex', 'context']);
  if (typeof object.latex !== 'string' || !object.latex.trim() || object.latex.length > 20000) throw new GatewayError('INVALID_REQUEST', '待检查的 LaTeX 必须为 1–20000 个字符。');
  if (object.context !== undefined && (typeof object.context !== 'string' || object.context.length > 20000)) throw new GatewayError('INVALID_REQUEST', '补充说明最多允许 20000 个字符。');
  return object as unknown as ReviewRequest;
}

export function createGateway(options: { config?: GatewayConfig; provider?: RecognitionProvider; providers?: Partial<Record<ProviderName, RecognitionProvider>>; store?: QuotaStore; now?: () => number } = {}) {
  const config = options.config || configFromEnv();
  const providers: Record<ProviderName, RecognitionProvider> = {
    mock: new MockProvider(),
    mathpix: new MathpixProvider({ appId: config.mathpixAppId, appKey: config.mathpixAppKey }),
    deepseek: new DeepSeekProvider({ apiKey: config.deepseekApiKey, model: config.deepseekModel, timeoutMs: config.deepseekTimeoutMs, taskTimeoutMs:config.taskTimeoutMs,taskMaxOutputTokens:config.taskMaxOutputTokens }),
    ollama: new OllamaProvider({ baseUrl: config.ollamaBaseUrl, model: config.ollamaModel, timeoutMs: config.ollamaTimeoutMs }),
    ...options.providers,
  };
  if (options.provider) providers[options.provider.name] = options.provider;
  const provider = options.provider || providers[config.provider];
  const selectProvider = (name?: string | null): RecognitionProvider => {
    if (name === undefined || name === null) return provider;
    if (!providerNames.includes(name as ProviderName)) throw new GatewayError('INVALID_PROVIDER', '请选择受支持的识别服务。');
    return providers[name as ProviderName];
  };
  const isLocal = (selected: RecognitionProvider) => selected.local ?? (selected.name === 'ollama' || selected.simulated);
  const charged = (selected: RecognitionProvider) => !selected.simulated && !isLocal(selected);
  const timeoutFor = (selected: RecognitionProvider) => selected.timeoutMs ?? (selected.name === 'deepseek' ? config.deepseekTimeoutMs : selected.name === 'ollama' ? config.ollamaTimeoutMs : config.requestTimeoutMs);
  const capabilities = (selected: RecognitionProvider) => ({ transcribe: true, review: typeof selected.review === 'function' });
  const providerInfo = (selected: RecognitionProvider) => ({ id: selected.name, label: providerLabels[selected.name], configured: selected.configured, local: isLocal(selected), model: selected.model || null, ...capabilities(selected) });
  const store = options.store || new QuotaStore(config.databasePath);
  const now = options.now || Date.now;
  const auth = config.authMode==='hosted'?new HostedAuthStore(config.databasePath):null;
  const tasks = new TaskManager(config,store,now);
  const authNetwork = new Map<string,{at:number;count:number;active:number}>();
  const taskCaps = (selected:RecognitionProvider)=>Object.fromEntries(Object.entries(taskCapabilityTable(selected.name)).map(([key,value])=>[key,value&&typeof selected.task==='function']));
  const inFlight = new Map<string, Promise<Result>>();
  const cache = new Map<string, { expiresAt: number; result: Result }>();
  const recognitionControllers = new Map<string, AbortController>();
  let closed = false;

  const errorResult = (error: unknown, requestId: string = randomUUID(), sourceRevision = 0, selected = provider): Result => {
    const safe = error instanceof GatewayError ? error : new GatewayError('INTERNAL_ERROR', '服务暂时不可用，请稍后检查服务状态。', 500);
    return {
      statusCode: safe.statusCode,
      body: { requestId, status: 'error', provider: selected.name, simulated: selected.simulated, sourceRevision, error: { code: safe.code, message: safe.message, retryable: safe.retryable } },
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
    if(auth)return auth.authenticate(request.headers.authorization||'',now());
    if (!config.pairingToken) return;
    const actual = request.headers.authorization || '';
    const expected = `Bearer ${config.pairingToken}`;
    const actualBytes = Buffer.from(actual);
    const expectedBytes = Buffer.from(expected);
    if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
      throw new GatewayError('UNAUTHORIZED', '请填写正确的服务配对令牌。', 401);
    }
  };
  const allowProvider = (selected:RecognitionProvider)=>{
    if(auth&&(selected.local||selected.name==='ollama'||selected.simulated))throw new GatewayError('HOSTED_PROVIDER_UNSUPPORTED','托管网关仅提供云端服务。本地 Qwen 请从自己电脑或局域网入口启动，不会自动连接到服务器的回环地址。',422);
  };

  const recognitionTask = (id: string, principalHash: string, byRequestKey = false): RecognitionTaskResponse | undefined => {
    const metadata = store.recognitionTask(id, principalHash, byRequestKey);
    if (!metadata) return;
    const { requestKey, state: _state, errorCode: _errorCode, ...common } = metadata;
    const cached = cache.get(requestKey);
    if (cached && cached.expiresAt > now()) {
      const result = cached.result.body as RecognitionResponse;
      return { ...common, status: result.status, result, ...(result.usage ? { usage: result.usage } : {}), ...(result.cost ? { cost: result.cost } : {}), ...(result.error ? { error: result.error } : {}) };
    }
    if (inFlight.has(requestKey)) return { ...common, status: 'running' };
    return { ...common, status: 'result-unavailable', error: { code: 'RECOGNITION_RESULT_UNAVAILABLE', message: '该选区请求已提交，但结果正文当前不可用（可能服务重启或缓存过期）。不会自动重复识别；请核对设备中已有草稿，明确新建调用可能再次计费。', retryable: false } };
  };

  const execute = (input: RecognitionRequest | ReviewRequest, selected: RecognitionProvider, operation: 'recognize' | 'review', requestKey: string, fingerprint: string, invoke: (signal: AbortSignal) => Promise<RecognitionResult | ReviewResult>): Promise<Result> => {
    if (!selected.configured) return Promise.resolve(errorResult(new GatewayError('PROVIDER_NOT_CONFIGURED', `${providerLabels[selected.name]} 尚未配置，请在服务端设置对应 API 凭据或本地服务。`, 503), undefined, input.sourceRevision, selected));
    allowProvider(selected);
    const principalHash=hash(input.installationId);
    const reserved=charged(selected)?reserveAmount(config,selected.model,90000,4096):0;
    const reservation = store.reserve({ requestKey, requestId: randomUUID(), installationHash: principalHash, fingerprint, now: now(), countQuota: charged(selected),...(charged(selected)?{budget:{principalHash,amountCny:reserved,provider:selected.name,model:selected.model,operation,deadlineMs:timeoutFor(selected)}}:{}) }, config);
    if (operation === 'recognize') store.createRecognitionTask({ taskId: reservation.requestId, requestKey, principalHash, provider: selected.name, model: selected.model, simulated: selected.simulated, sourceRevision: input.sourceRevision, now: now() });
    if (reservation.existing) {
      const pending = inFlight.get(requestKey);
      if (pending) return pending;
      const completed = cache.get(requestKey);
      if (completed && completed.expiresAt > now()) return Promise.resolve(completed.result);
      cache.delete(requestKey);
      return Promise.resolve(errorResult(new GatewayError('REQUEST_RESULT_UNAVAILABLE', '该请求已提交，缓存结果已不可用。为避免重复调用不会再次提交；请核对后手动创建新请求。', 409), reservation.requestId, input.sourceRevision, selected));
    }
    const task = (async (): Promise<Result> => {
      const controller = new AbortController();
      if (operation === 'recognize') recognitionControllers.set(requestKey, controller);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let result: Result;
      let usage:TokenUsage|undefined;
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const error = new GatewayError('PROVIDER_TIMEOUT', charged(selected) ? '云端服务请求超时，可能已计费，请核对后手动重试。' : '本地服务请求超时，请检查模型状态后手动重试。', 504);
            controller.abort(error);
            reject(error);
          }, timeoutFor(selected));
        });
        const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason instanceof GatewayError ? controller.signal.reason : new GatewayError('RECOGNITION_CANCELLED', '选区任务已取消；供应商可能已经计费，原稿和已保存草稿保留。', 409)), { once: true }));
        const value = await Promise.race([invoke(controller.signal), timeout, aborted]);
        usage=value.usage;
        const common = { requestId: reservation.requestId, status: 'ok' as const, provider: selected.name, simulated: selected.simulated, sourceRevision: input.sourceRevision };
        if (operation === 'recognize') {
          const recognized = value as RecognitionResult;
          if (typeof recognized.latex !== 'string' || !recognized.latex.trim()) throw new GatewayError('NO_FORMULA', '选区未返回可编辑的公式。', 422);
          result = { statusCode: 200, body: { ...common, latex: recognized.latex, ...(recognized.confidence !== undefined ? { confidence: recognized.confidence } : {}), ...(recognized.reviewRequired !== undefined ? { reviewRequired: recognized.reviewRequired } : {}), ...(recognized.uncertainSymbols ? { uncertainSymbols: recognized.uncertainSymbols } : {}), ...(recognized.usage ? { usage: recognized.usage } : {}) } };
        } else {
          const reviewed = value as ReviewResult;
          if (typeof reviewed.summary !== 'string' || !Array.isArray(reviewed.issues) || reviewed.issues.some(issue => typeof issue !== 'string') || (reviewed.suggestedLatex !== null && typeof reviewed.suggestedLatex !== 'string')) throw new GatewayError('PROVIDER_BAD_RESPONSE', '模型未返回有效的检查结果，请手动核对。', 502);
          result = { statusCode: 200, body: { ...common, originalLatex: (input as ReviewRequest).latex, review: { summary: reviewed.summary, issues: reviewed.issues, suggestedLatex: reviewed.suggestedLatex },...(usage?{usage}:{}) } };
        }
      } catch (error) {
        if(error instanceof GatewayError)usage=error.usage||usage;
        result = errorResult(error, reservation.requestId, input.sourceRevision, selected);
      } finally {
        if (timer) clearTimeout(timer);
        if (operation === 'recognize') recognitionControllers.delete(requestKey);
      }
      if(charged(selected)){result.body.cost=estimateCost(usage,selected.model,config.priceConfig,reserved);result.body.usage=usage||unknownUsage();}
      if (closed) return result;
      store.complete(requestKey, result.body.status);
      if(charged(selected))store.settle(requestKey,usage,result.body.cost!);
      if(operation==='recognize')store.completeRecognitionTask(reservation.requestId,result.body.status,now(),result.body.error?.code);
      for (const [key, value] of cache) if (value.expiresAt <= now()) cache.delete(key);
      while (cache.size >= config.maxCachedResults) cache.delete(cache.keys().next().value!);
      cache.set(requestKey, { result, expiresAt: now() + config.resultTtlMs });
      return result;
    })();
    const result = task.finally(() => inFlight.delete(requestKey));
    inFlight.set(requestKey, result);
    return result;
  };

  const recognize = (input: RecognitionRequest, image: Buffer, selected: RecognitionProvider): Promise<Result> => {
    // Preserve the original key format so upgrading never repeats a paid OCR call.
    const requestKey = hash(`${selected.name}\0${input.installationId}\0${input.clientRequestId}`);
    return execute(input, selected, 'recognize', requestKey, hash(`${input.sourceRevision}\0${hash(image)}`), signal => selected.recognize(image, signal));
  };

  const review = (input: ReviewRequest, selected: RecognitionProvider): Promise<Result> => {
    if (!selected.review) throw new GatewayError('PROVIDER_CAPABILITY_UNSUPPORTED', '所选服务不支持公式检查，请选择 DeepSeek 或本地 Ollama。', 422);
    const requestKey = hash(`${selected.name}\0review\0${input.installationId}\0${input.clientRequestId}`);
    const fingerprint = hash(JSON.stringify({ sourceRevision: input.sourceRevision, latex: input.latex, context: input.context || '' }));
    return execute(input, selected, 'review', requestKey, fingerprint, signal => selected.review!(input.latex, input.context, signal));
  };

  async function handle(request: IncomingMessage, response: ServerResponse) {
    let sourceRevision = 0;
    let selected = provider;
    try {
      const url = new URL(request.url || '/', 'http://gateway.local');
      const path = url.pathname;
      const taskMatch=/^\/v1\/tasks\/([a-fA-F0-9-]{36})(\/cancel)?$/.exec(path);
      const taskLookup=/^\/v1\/tasks\/by-request\/([^/]+)$/.exec(path);
      const recognitionMatch=/^\/v1\/recognitions\/([a-fA-F0-9-]{36})(\/cancel)?$/.exec(path);
      const recognitionLookup=/^\/v1\/recognitions\/by-request\/([^/]+)$/.exec(path);
      const authRoute=['/v1/auth/login','/v1/auth/register','/v1/auth/logout','/v1/auth/me'].includes(path);
      if (!['/v1/recognize', '/v1/recognitions', '/v1/review', '/v1/tasks', '/v1/status', '/v1/usage', '/v1/provider-health', '/v1/pairing', '/v1/local-pairing', '/health'].includes(path)&&!taskMatch&&!taskLookup&&!recognitionMatch&&!recognitionLookup&&!authRoute) {
        send(response, 404, { error: { code: 'NOT_FOUND', message: '接口不存在。' } });
        return;
      }
      checkOrigin(request, response);
      if (path === '/v1/local-pairing') {if(auth)throw new GatewayError('LOCAL_PAIRING_NOT_ALLOWED','托管模式需要账号登录，不提供共享配对令牌。',403);checkLocalPairingRequest(request);}
      if (request.method === 'OPTIONS') { response.statusCode = 204; response.end(); return; }
      if (['/health', '/v1/status', '/v1/usage', '/v1/provider-health'].includes(path)) selected = selectProvider(url.searchParams.get('provider'));
      if(authRoute){
        if(!auth)throw new GatewayError('AUTH_MODE_LOCAL','本机开发模式不需要托管账号。',404);
        if(path==='/v1/auth/me'&&request.method==='GET'){send(response,200,{status:'ok',user:auth.authenticate(request.headers.authorization||'',now())});return;}
        if(path==='/v1/auth/logout'&&request.method==='POST'){auth.revoke(request.headers.authorization||'',now());send(response,200,{status:'ok'});return;}
        if(request.method!=='POST'||!['/v1/auth/login','/v1/auth/register'].includes(path))throw new GatewayError('METHOD_NOT_ALLOWED','请求方法不支持。',405);
        if(!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type']||''))throw new GatewayError('INVALID_CONTENT_TYPE','请求必须使用 application/json。',415);
        const key=hash(authenticationSourceIp(request,config.trustedProxyIps));
        for(const [id,entry]of authNetwork)if(entry.at+60000<=now()&&entry.active===0)authNetwork.delete(id);
        if(authNetwork.size>=10000&&!authNetwork.has(key))throw new GatewayError('AUTH_RATE_LIMITED','登录服务繁忙，请稍后重试。',429);
        let guard=authNetwork.get(key);if(!guard||guard.at+60000<=now()&&guard.active===0){guard={at:now(),count:0,active:0};authNetwork.set(key,guard);}
        if(guard.count>=20||guard.active>=2)throw new GatewayError('AUTH_RATE_LIMITED','登录或注册频率过高，请稍后再试。',429);
        guard.count++;guard.active++;
        try{
          const value=await readBody(request,4096) as Record<string,unknown>;
          if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.username!=='string'||typeof value.password!=='string'||Object.keys(value).some(k=>!['username','password',...(path.endsWith('/register')?['invite']:[])].includes(k)))throw new GatewayError('AUTH_INVALID_INPUT','请填写有效账号和密码。');
          const session=path.endsWith('/register')?await auth.register(value.username,value.password,typeof value.invite==='string'?value.invite:'',now()):await auth.login(value.username,value.password,now());
          send(response,200,session);
        }finally{guard.active--;}
        return;
      }
      if ((path === '/health' || path === '/v1/status') && request.method === 'GET') {
        const enforced = charged(selected);
        response.setHeader('X-MathInk-Recognition-Tasks', '1');
        send(response, 200, { status: 'ok', authMode:config.authMode,provider: selected.name, simulated: selected.simulated, configured: selected.configured, local: isLocal(selected), model: selected.model || null, capabilities: capabilities(selected),protocolCapabilities:{recognitionTasks:true,recognitionLookup:true,taskLookup:true},taskCapabilities:taskCaps(selected),taskLimits:{maxContextBytes:config.taskMaxContextBytes,maxBlocks:config.taskMaxBlocks,maxOutputTokens:config.taskMaxOutputTokens,timeoutMs:config.taskTimeoutMs,maxSubcalls:1,maxCostCny:config.taskMaxCostCny,reserveCny:config.taskReserveCny,promptVersion:TASK_PROMPT_VERSION}, requestTimeoutMs: timeoutFor(selected), providers: providerNames.map(name => providerInfo(providers[name])), pairingRequired: !auth&&Boolean(config.pairingToken), limits: { enforced, source: 'local-service', installationDaily: enforced ? config.installationDailyLimit : null, globalDaily: enforced ? config.globalDailyLimit : null, globalMonthly: enforced ? config.globalMonthlyLimit : null, maxImageBytes: config.maxImageBytes }, timeZone: config.timeZone });
        return;
      }
      if (path === '/v1/usage' && request.method === 'GET') {
        const user=checkToken(request);
        const installationId = url.searchParams.get('installationId');
        if (!user&&(!installationId || !/^[A-Za-z0-9._:-]{8,128}$/.test(installationId))) throw new GatewayError('INVALID_REQUEST', 'installationId 必须为 8–128 位的字母、数字或标识符。');
        const principalHash=hash(user?`user:${user.id}`:installationId!);
        send(response, 200, { status: 'ok', authMode:config.authMode,provider: selected.name, simulated: selected.simulated, configured: selected.configured, local: isLocal(selected), model: selected.model || null, timeZone: config.timeZone, quota: store.usage(principalHash, now(), config, charged(selected)),budget:store.budgetUsage(principalHash,now(),config) });
        return;
      }
      if (path === '/v1/provider-health' && request.method === 'GET') {
        checkToken(request);
        allowProvider(selected);
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new GatewayError('PROVIDER_HEALTH_TIMEOUT', '服务状态检查超时，请检查连接。', 504)); }, Math.min(timeoutFor(selected), 10000)); });
          const health = await Promise.race([selected.probe ? selected.probe(controller.signal) : Promise.resolve({ ready: selected.configured, message: selected.configured ? '服务已配置，未提交生成或识别请求。' : '服务尚未配置。' }), timeout]);
          if (typeof health.ready !== 'boolean' || typeof health.message !== 'string') throw new GatewayError('PROVIDER_BAD_RESPONSE', '服务未返回有效的就绪状态。', 502);
          send(response, 200, { status: 'ok', provider: selected.name, simulated: selected.simulated, configured: selected.configured, local: isLocal(selected), model: selected.model || null, ...health });
        } finally { if (timer) clearTimeout(timer); }
        return;
      }
      if (path === '/v1/pairing' && request.method === 'GET') {
        checkToken(request);
        send(response, 200, { status: 'ok', pairingRequired: !auth&&Boolean(config.pairingToken),authMode:config.authMode });
        return;
      }
      if (path === '/v1/local-pairing' && request.method === 'GET') {
        send(response, 200, { status: 'ok', pairingRequired: Boolean(config.pairingToken), pairingToken: config.pairingToken });
        return;
      }
      if(recognitionMatch || recognitionLookup){
        const user=checkToken(request);
        const installationId=url.searchParams.get('installationId');
        if(!user&&(!installationId||!/^[A-Za-z0-9._:-]{8,128}$/.test(installationId)))throw new GatewayError('INVALID_REQUEST','查询选区任务需要 installationId。');
        const cancelling=Boolean(recognitionMatch?.[2]);
        if(cancelling?request.method!=='POST':request.method!=='GET')throw new GatewayError('METHOD_NOT_ALLOWED','请求方法不支持。',405);
        const principalId=user?`user:${user.id}`:installationId!;
        const principalHash=hash(principalId);
        let id=recognitionMatch?.[1]||'';
        if(recognitionLookup){
          let clientRequestId:string;
          try{clientRequestId=decodeURIComponent(recognitionLookup[1]);}catch{throw new GatewayError('INVALID_REQUEST','请求标识无效。');}
          if(!/^[A-Za-z0-9._:-]{8,128}$/.test(clientRequestId))throw new GatewayError('INVALID_REQUEST','请求标识无效。');
          const providerName=url.searchParams.get('provider');
          if(!providerName)throw new GatewayError('INVALID_PROVIDER','按请求查询必须提供原任务的 provider。');
          selected=selectProvider(providerName);
          id=hash(`${selected.name}\0${principalId}\0${clientRequestId}`);
        }
        let value=recognitionTask(id,principalHash,Boolean(recognitionLookup));
        if(!value)throw new GatewayError('RECOGNITION_NOT_FOUND','选区任务不存在或不属于当前账号。',404);
        if(cancelling){
          const metadata=store.recognitionTask(value.taskId,principalHash)!;
          const controller=recognitionControllers.get(metadata.requestKey);
          if(controller){
            controller.abort(new GatewayError('RECOGNITION_CANCELLED','选区任务已取消，原稿和已保存草稿保留；供应商可能已计费，未知费用仍占用预留。',409));
            await inFlight.get(metadata.requestKey)?.catch(()=>{});
            value=recognitionTask(value.taskId,principalHash)!;
          }
        }
        send(response,200,value);return;
      }
      if(taskLookup){
        const user=checkToken(request),installationId=url.searchParams.get('installationId');
        if(request.method!=='GET')throw new GatewayError('METHOD_NOT_ALLOWED','请求方法不支持。',405);
        if(!user&&(!installationId||!/^[A-Za-z0-9._:-]{8,128}$/.test(installationId)))throw new GatewayError('INVALID_REQUEST','查询本机任务需要 installationId。');
        let clientRequestId:string;
        try{clientRequestId=decodeURIComponent(taskLookup[1]);}catch{throw new GatewayError('INVALID_REQUEST','请求标识无效。');}
        if(!/^[A-Za-z0-9._:-]{8,128}$/.test(clientRequestId))throw new GatewayError('INVALID_REQUEST','请求标识无效。');
        const providerName=url.searchParams.get('provider');
        if(!providerName)throw new GatewayError('INVALID_PROVIDER','按请求查询必须提供原任务的 provider。');
        selected=selectProvider(providerName);
        const value=tasks.byRequest(clientRequestId,selected.name,hash(user?`user:${user.id}`:installationId!));
        if(!value)throw new GatewayError('TASK_NOT_FOUND','任务不存在或不属于当前账号。',404);
        send(response,200,value);return;
      }
      if(taskMatch){
        const user=checkToken(request);
        const installationId=url.searchParams.get('installationId');
        if(!user&&(!installationId||!/^[A-Za-z0-9._:-]{8,128}$/.test(installationId)))throw new GatewayError('INVALID_REQUEST','查询本机任务需要 installationId。');
        if(taskMatch[2]?request.method!=='POST':request.method!=='GET')throw new GatewayError('METHOD_NOT_ALLOWED','请求方法不支持。',405);
        const principal=hash(user?`user:${user.id}`:installationId!);
        const value=taskMatch[2]?tasks.cancel(taskMatch[1],principal):tasks.get(taskMatch[1],principal);
        if(!value)throw new GatewayError('TASK_NOT_FOUND','任务不存在或不属于当前账号。',404);
        send(response,200,value);return;
      }
      if (!['/v1/recognize', '/v1/recognitions', '/v1/review','/v1/tasks'].includes(path) || request.method !== 'POST') {
        response.setHeader('Allow', ['/v1/recognize', '/v1/recognitions', '/v1/review','/v1/tasks'].includes(path) ? 'POST, OPTIONS' : 'GET, OPTIONS');
        throw new GatewayError('METHOD_NOT_ALLOWED', '请求方法不支持。', 405);
      }
      const user=checkToken(request);
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) throw new GatewayError('INVALID_CONTENT_TYPE', '请求必须使用 application/json。', 415);
      const body = await readBody(request, config.maxBodyBytes);
      if(path==='/v1/tasks'){
        const input=validateTaskRequest(body,config);sourceRevision=input.sourceRevision;selected=selectProvider(input.provider);allowProvider(selected);
        if(input.type==='page-transcribe')decodePngBase64(input.input.imageBase64,config.maxImageBytes);
        if(user)input.installationId=`user:${user.id}`;
        const result=tasks.submit(input,selected,hash(input.installationId));send(response,result.status==='pending'||result.status==='running'?202:200,result);return;
      }
      if(path==='/v1/recognitions'){
        const input=validateRequest(body);
        if(user)input.installationId=`user:${user.id}`;
        sourceRevision=input.sourceRevision;selected=selectProvider(input.provider);allowProvider(selected);
        const image=decodePngBase64(input.imageBase64,config.maxImageBytes);
        const job=recognize(input,image,selected);
        const key=hash(`${selected.name}\0${input.installationId}\0${input.clientRequestId}`);
        const value=recognitionTask(key,hash(input.installationId),true);
        if(!value){const result=await job;send(response,result.statusCode,result.body);return;}
        // Completion is owned by the gateway, independent of the POST connection.
        void job.catch(()=>{});
        send(response,value.status==='pending'||value.status==='running'?202:200,value);return;
      }
      let result: Result;
      if (path === '/v1/review') {
        const input = validateReview(body);
        if(user)input.installationId=`user:${user.id}`;
        sourceRevision = input.sourceRevision; selected = selectProvider(input.provider);
        result = await review(input, selected);
      } else {
        const input = validateRequest(body);
        if(user)input.installationId=`user:${user.id}`;
        sourceRevision = input.sourceRevision; selected = selectProvider(input.provider);
        const image = decodePngBase64(input.imageBase64, config.maxImageBytes);
        result = await recognize(input, image, selected);
      }
      send(response, result.statusCode, result.body);
    } catch (error) {
      const result = errorResult(error, undefined, sourceRevision, selected);
      send(response, result.statusCode, result.body);
    }
  }

  return { handle, config, provider, close: () => {closed=true;for(const controller of recognitionControllers.values())controller.abort(new GatewayError('GATEWAY_CLOSED','服务已关闭；请通过原任务查询恢复状态，不自动重发。',503));recognitionControllers.clear();tasks.close();auth?.close();store.close();cache.clear();inFlight.clear();} };
}
