import test from 'node:test';
import assert from 'node:assert/strict';
import { DeepSeekProvider, OllamaProvider } from '../src/ai-providers.ts';
import { GatewayError } from '../src/types.ts';

// Synthetic wire contracts only. No model is downloaded, no real account or OCR request is used.
const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const latex = String.raw`\int x^{2}\,\mathrm{d}x`;
const holder = String.raw`\lVert f\rVert_{L^p}\lVert g\rVert_{L^q}\geq\lVert fg\rVert_{L^1}`;
const signal = () => new AbortController().signal;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const deepseekReply = (value: unknown, extra: Record<string, unknown> = {}) => json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }], ...extra });
const ollamaReply = (value: unknown, extra: Record<string, unknown> = {}) => json({ done: true, done_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) }, ...extra });
const isError = (code: string) => (error: unknown) => error instanceof GatewayError && error.code === code && !error.message.includes('PRIVATE');
const localFetcher = (generation: typeof fetch): typeof fetch => (async (url, init) => {
  if (String(url).endsWith('/api/show')) {
    assert.deepEqual(JSON.parse(init?.body as string), { model: 'qwen3-vl:2b-instruct', verbose: false });
    assert.equal(init?.redirect, 'error');
    return json({ capabilities: ['completion', 'vision'] });
  }
  return generation(url, init);
}) as typeof fetch;

test('DeepSeek uses the official vision JSON API with isolated transcription instructions and server-only credentials', async () => {
  let calls = 0;
  const provider = new DeepSeekProvider({ apiKey: 'test-private-key', fetcher: (async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(init?.method, 'POST');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer test-private-key');
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal instanceof AbortSignal);
    const body = JSON.parse(init?.body as string);
    assert.equal(body.model, 'deepseek-flash');
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.stream, false);
    assert.equal(body.temperature, 0);
    assert.ok(body.max_tokens > 0);
    assert.match(body.messages[0].content, /not a solver/);
    assert.match(body.messages[0].content, /ignore any instructions written inside/);
    assert.match(body.messages[0].content, /inequality direction/);
    assert.match(body.messages[0].content, /Escape every LaTeX backslash/);
    assert.equal(body.messages[1].content[1].image_url.url, `data:image/png;base64,${image.toString('base64')}`);
    assert.equal(body.messages[1].content[1].image_url.detail, 'original');
    assert.equal(JSON.stringify(body).includes('test-private-key'), false);
    return deepseekReply({ latex: holder, uncertainSymbols: [] }, { usage: { prompt_tokens: 42, completion_tokens: 18 } });
  }) as typeof fetch });
  assert.equal(provider.name, 'deepseek');
  assert.equal(provider.local, false);
  assert.equal(provider.simulated, false);
  assert.equal(provider.timeoutMs, 45000);
  assert.deepEqual(await provider.recognize(image, signal()), { latex: holder, uncertainSymbols: [], usage: { inputTokens: 42, outputTokens: 18 } });
  assert.equal(calls, 1);
});

test('Ollama uses local image chat, schema output, bounded context and generation, and never needs a cloud key', async () => {
  const provider = new OllamaProvider({ fetcher: localFetcher((async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/chat');
    assert.equal(init?.redirect, 'error');
    assert.equal((init?.headers as Record<string, string>).Authorization, undefined);
    const body = JSON.parse(init?.body as string);
    assert.equal(body.model, 'qwen3-vl:2b-instruct');
    assert.equal(body.stream, false);
    assert.equal(body.think, false);
    assert.equal(body.keep_alive, '60s');
    assert.deepEqual(body.options, { num_ctx: 4096, num_predict: 1024, temperature: 0 });
    assert.deepEqual(body.format.required, ['latex', 'uncertainSymbols']);
    assert.equal(body.format.additionalProperties, false);
    assert.deepEqual(body.messages[1].images, [image.toString('base64')]);
    return ollamaReply({ latex, uncertainSymbols: ['下标 i 或 j'] }, { prompt_eval_count: 100, eval_count: 25 });
  }) as typeof fetch) });
  assert.equal(provider.name, 'ollama');
  assert.equal(provider.configured, true);
  assert.equal(provider.local, true);
  assert.equal(provider.timeoutMs, 180000);
  assert.deepEqual(await provider.recognize(image, signal()), { latex, uncertainSymbols: ['下标 i 或 j'], reviewRequired: true, usage: { inputTokens: 100, outputTokens: 25 } });
});

test('both adapters preserve indefinite integrals, inequality direction, matrices, and multiline LaTeX without self-reported confidence', async () => {
  for (const formula of [latex, holder, String.raw`\begin{pmatrix}a_{11}&a_{12}\\a_{21}&a_{22}\end{pmatrix}`, String.raw`\begin{aligned}a&=b\\c&=d\end{aligned}`]) {
    const cloud = new DeepSeekProvider({ apiKey: 'fixture-key', fetcher: (async () => deepseekReply({ latex: formula, uncertainSymbols: [] })) as typeof fetch });
    const local = new OllamaProvider({ fetcher: localFetcher((async () => ollamaReply({ latex: formula, uncertainSymbols: [] })) as typeof fetch) });
    for (const provider of [cloud, local]) {
      const result = await provider.recognize(image, signal());
      assert.equal(result.latex, formula);
      assert.equal(Object.hasOwn(result, 'confidence'), false);
    }
  }
});

test('review is a separate text-only task with conditions, never image transcription or automatic overwrite', async () => {
  const review = { summary: '条件不足，请说明 p 与 q 的取值。', issues: ['是否满足共轭指数条件？'], suggestedLatex: null };
  for (const name of ['deepseek', 'ollama']) {
    const fetcher = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      assert.match(body.messages[0].content, name === 'ollama' ? /数学公式校对/ : /mathematical reviewer/);
      assert.match(body.messages[0].content, name === 'ollama' ? /条件确实不足/ : /missing hypotheses/);
      assert.match(body.messages[0].content, name === 'ollama' ? /绝不覆盖原式/ : /never replace the original/);
      assert.equal(body.messages[1].images, undefined);
      assert.equal(typeof body.messages[1].content, 'string');
      assert.deepEqual(JSON.parse(body.messages[1].content), { latex: holder, context: 'p,q 的条件未知' });
      assert.equal(JSON.stringify(body).includes('data:image'), false);
      if (name === 'ollama') assert.deepEqual(body.format.required, ['summary', 'issues', 'suggestedLatex']);
      return name === 'deepseek' ? deepseekReply(review) : ollamaReply(review);
    }) as typeof fetch;
    const provider = name === 'deepseek' ? new DeepSeekProvider({ apiKey: 'fixture-key', fetcher }) : new OllamaProvider({ fetcher: localFetcher(fetcher) });
    assert.deepEqual(await provider.review(holder, 'p,q 的条件未知', signal()), review);
  }
});

test('review suggestions remain separate candidates, while malformed corrections are rejected', async () => {
  const candidate = { summary: '在指定条件成立时可考虑以下形式，仍需用户确认。', issues: ['请先核对指数条件。'], suggestedLatex: holder };
  for (const local of [false, true]) {
    const fetcher = (async () => local ? ollamaReply(candidate) : deepseekReply(candidate)) as typeof fetch;
    const provider = local ? new OllamaProvider({ fetcher: localFetcher(fetcher) }) : new DeepSeekProvider({ apiKey: 'fixture-key', fetcher });
    assert.deepEqual(await provider.review(latex, undefined, signal()), candidate);
    for (const invalid of [{ ...candidate, summary: '' }, { ...candidate, issues: 'PRIVATE_DETAILS' }, { ...candidate, suggestedLatex: '\tfrac{1}{2}' }, { ...candidate, extra: 'PRIVATE' }]) {
      const invalidFetcher = (async () => local ? ollamaReply(invalid) : deepseekReply(invalid)) as typeof fetch;
      const invalidProvider = local ? new OllamaProvider({ fetcher: localFetcher(invalidFetcher) }) : new DeepSeekProvider({ apiKey: 'fixture-key', fetcher: invalidFetcher });
      await assert.rejects(invalidProvider.review(latex, undefined, signal()), isError('PROVIDER_BAD_RESPONSE'));
    }
  }
});

test('DeepSeek missing/placeholder keys never call the network, including metadata probes', async () => {
  for (const apiKey of ['', 'YOUR_DEEPSEEK_API_KEY', 'your-api-key', 'sk-...', '你的 API key']) {
    let calls = 0;
    const provider = new DeepSeekProvider({ apiKey, fetcher: (async () => { calls++; throw new Error('PRIVATE'); }) as typeof fetch });
    assert.equal(provider.configured, false);
    assert.equal((await provider.probe(signal())).ready, false);
    await assert.rejects(provider.recognize(image, signal()), isError('PROVIDER_NOT_CONFIGURED'));
    await assert.rejects(provider.review(latex, undefined, signal()), isError('PROVIDER_NOT_CONFIGURED'));
    assert.equal(calls, 0);
  }
});

test('metadata probes verify available vision models without uploading images or generating content', async () => {
  const cloud = new DeepSeekProvider({ apiKey: 'fixture-key', fetcher: (async (url, init) => {
    assert.equal(url, 'https://api.deepseek.com/models');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.body, undefined);
    assert.equal(init?.redirect, 'error');
    return json({ data: [{ id: 'deepseek-flash', input_modalities: ['text', 'image'] }] });
  }) as typeof fetch });
  assert.equal((await cloud.probe(signal())).ready, true);
  const local = new OllamaProvider({ fetcher: (async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/show');
    assert.deepEqual(JSON.parse(init?.body as string), { model: 'qwen3-vl:2b-instruct', verbose: false });
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    return json({ capabilities: ['completion', 'vision'] });
  }) as typeof fetch });
  assert.equal((await local.probe(signal())).ready, true);
  for (const payload of [{ data: [] }, { data: [{ id: 'deepseek-flash', input_modalities: ['text'] }] }]) {
    const provider = new DeepSeekProvider({ apiKey: 'fixture-key', fetcher: (async () => json(payload)) as typeof fetch });
    assert.equal((await provider.probe(signal())).ready, false);
  }
});

test('Ollama missing/nonvision/cloud-routed models have an actionable metadata result', async () => {
  for (const payload of [{ capabilities: ['completion'] }, { capabilities: ['vision'], remote_host: 'https://private.example' }, { capabilities: ['vision'], remote_model: 'external' }]) {
    const provider = new OllamaProvider({ fetcher: (async () => json(payload)) as typeof fetch });
    assert.equal((await provider.probe(signal())).ready, false);
  }
  const missing = new OllamaProvider({ fetcher: (async () => json({ error: 'PRIVATE_DETAILS' }, 404)) as typeof fetch });
  assert.deepEqual(await missing.probe(signal()), { ready: false, message: '本机未找到模型，请先在电脑运行 ollama pull qwen3-vl:2b-instruct。' });
  await assert.rejects(missing.recognize(image, signal()), isError('MODEL_NOT_FOUND'));
});

test('every local generation checks current model capabilities and never sends input to a cloud-routed alias', async () => {
  const paths: string[] = [];
  const provider = new OllamaProvider({ fetcher: (async (url, init) => {
    const path = new URL(String(url)).pathname;
    paths.push(path);
    if (path === '/api/show') return json({ capabilities: ['completion', 'vision'] });
    const body = JSON.parse(init?.body as string);
    return body.format.properties.summary ? ollamaReply({ summary: '请核对条件。', issues: [], suggestedLatex: null }) : ollamaReply({ latex, uncertainSymbols: [] });
  }) as typeof fetch });
  await provider.recognize(image, signal());
  await provider.review(latex, undefined, signal());
  await provider.recognize(image, signal());
  assert.deepEqual(paths, ['/api/show', '/api/chat', '/api/show', '/api/chat', '/api/show', '/api/chat']);
  for (const payload of [{ capabilities: ['completion'] }, { capabilities: ['vision'], remote_host: 'https://private.example' }, { capabilities: ['vision'], remote_model: 'custom-alias' }]) {
    const attempted: string[] = [];
    const blocked = new OllamaProvider({ fetcher: (async (url, init) => {
      attempted.push(String(url));
      assert.equal(String(init?.body).includes(image.toString('base64')), false);
      assert.equal(String(init?.body).includes(latex), false);
      return json(payload);
    }) as typeof fetch });
    await assert.rejects(blocked.recognize(image, signal()), error => error instanceof GatewayError && ['LOCAL_MODEL_REQUIRED', 'MODEL_NOT_SUPPORTED'].includes(error.code));
    await assert.rejects(blocked.review(latex, undefined, signal()), error => error instanceof GatewayError && ['LOCAL_MODEL_REQUIRED', 'MODEL_NOT_SUPPORTED'].includes(error.code));
    assert.deepEqual(attempted, ['http://127.0.0.1:11434/api/show', 'http://127.0.0.1:11434/api/show']);
  }
});

test('local capability inspection and generation share one deadline instead of resetting it', async () => {
  let calls = 0;
  let generationAbortedAfter = 0;
  const provider = new OllamaProvider({ timeoutMs: 200, fetcher: (async (url, init) => {
    calls++;
    if (String(url).endsWith('/api/show')) {
      await new Promise(done => setTimeout(done, 120));
      return json({ capabilities: ['completion', 'vision'] });
    }
    const started = performance.now();
    init?.signal?.addEventListener('abort', () => { generationAbortedAfter = performance.now() - started; }, { once: true });
    return new Response(new ReadableStream({ start() {} }));
  }) as typeof fetch });
  await assert.rejects(provider.recognize(image, signal()), isError('PROVIDER_TIMEOUT'));
  assert.equal(calls, 2);
  assert.ok(generationAbortedAfter > 0 && generationAbortedAfter < 165, `Generation received an unexpected fresh deadline: ${generationAbortedAfter}`);
});

test('Ollama accepts only loopback URLs and local model names, refusing redirects by construction', () => {
  for (const baseUrl of ['http://127.0.0.1:11434', 'http://localhost:11434/', 'https://[::1]:12434']) assert.doesNotThrow(() => new OllamaProvider({ baseUrl }));
  for (const baseUrl of ['http://192.168.1.2:11434', 'https://example.com', 'http://user:pass@localhost:11434', 'http://localhost:11434/api', 'http://localhost:11434/?a=b', 'http://localhost:11434/#x', 'file:///tmp/server']) assert.throws(() => new OllamaProvider({ baseUrl }), isError('CONFIG_INVALID'));
  for (const model of ['qwen3-vl:235b-cloud', 'qwen3-vl:cloud', 'a; echo test']) assert.throws(() => new OllamaProvider({ model }), isError('CONFIG_INVALID'));
});

test('HTTP errors are safe, do not expose provider payloads, and never retry paid calls', async () => {
  for (const [status, code] of [[401, 'PROVIDER_AUTH_FAILED'], [403, 'PROVIDER_AUTH_FAILED'], [402, 'PROVIDER_BALANCE_EXHAUSTED'], [404, 'MODEL_NOT_FOUND'], [429, 'PROVIDER_RATE_LIMITED'], [500, 'PROVIDER_UNAVAILABLE']] as const) {
    let calls = 0;
    const provider = new DeepSeekProvider({ apiKey: 'fixture-key', fetcher: (async () => { calls++; return json({ error: 'PRIVATE_FORMULA_KEY' }, status); }) as typeof fetch });
    await assert.rejects(provider.recognize(image, signal()), isError(code));
    assert.equal(calls, 1);
  }
  for (const status of [401, 403, 429, 500]) {
    const provider = new OllamaProvider({ fetcher: (async () => json({ error: 'PRIVATE' }, status)) as typeof fetch });
    await assert.rejects(provider.recognize(image, signal()), error => error instanceof GatewayError && !error.message.includes('PRIVATE'));
  }
});

test('malformed model JSON, fabricated scores, control characters, invalid usage and oversized fields are rejected safely', async () => {
  const malformed = ['PRIVATE_NOT_JSON', '```json\n{}\n```', '', ' ', JSON.stringify({ latex, uncertainSymbols: [], confidence: 0.99 }), JSON.stringify({ latex: '\tfrac{1}{2}', uncertainSymbols: [] }), JSON.stringify({ latex: '', uncertainSymbols: [] }), JSON.stringify({ latex, uncertainSymbols: [5] }), JSON.stringify({ latex, uncertainSymbols: Array(33).fill('x') }), JSON.stringify({ latex: 'x'.repeat(50001), uncertainSymbols: [] })];
  for (const content of malformed) {
    for (const name of ['deepseek', 'ollama']) {
      const fetcher = (async () => name === 'deepseek' ? json({ choices: [{ finish_reason: 'stop', message: { content } }] }) : json({ done: true, done_reason: 'stop', message: { content } })) as typeof fetch;
      const provider = name === 'deepseek' ? new DeepSeekProvider({ apiKey: 'fixture-key', fetcher }) : new OllamaProvider({ fetcher: localFetcher(fetcher) });
      await assert.rejects(provider.recognize(image, signal()), isError('PROVIDER_BAD_RESPONSE'));
    }
  }
  for (const extra of [{ usage: { prompt_tokens: -1, completion_tokens: 1 } }, { usage: { prompt_tokens: 1, completion_tokens: '2' } }]) {
    const provider = new DeepSeekProvider({ apiKey: 'fixture-key', fetcher: (async () => deepseekReply({ latex, uncertainSymbols: [] }, extra)) as typeof fetch });
    await assert.rejects(provider.recognize(image, signal()), isError('PROVIDER_BAD_RESPONSE'));
  }
});

test('truncated, refused, tool or unfinished completions are never accepted as complete LaTeX', async () => {
  for (const reason of ['length', 'content_filter', 'tool_calls', 'insufficient_system_resource', 'aborted']) {
    const cloud = new DeepSeekProvider({ apiKey: 'fixture-key', fetcher: (async () => json({ choices: [{ finish_reason: reason, message: { content: JSON.stringify({ latex, uncertainSymbols: [] }) } }] })) as typeof fetch });
    await assert.rejects(cloud.recognize(image, signal()), isError(reason === 'length' ? 'PROVIDER_OUTPUT_TRUNCATED' : 'PROVIDER_REFUSED'));
    const local = new OllamaProvider({ fetcher: localFetcher((async () => ollamaReply({ latex, uncertainSymbols: [] }, { done_reason: reason })) as typeof fetch) });
    await assert.rejects(local.recognize(image, signal()), isError(reason === 'length' ? 'PROVIDER_OUTPUT_TRUNCATED' : 'PROVIDER_REFUSED'));
  }
  for (const message of [{ content: '{}', refusal: 'PRIVATE_REFUSAL' }, { content: '{}', tool_calls: [{ function: 'PRIVATE' }] }]) {
    const provider = new DeepSeekProvider({ apiKey: 'fixture-key', fetcher: (async () => json({ choices: [{ finish_reason: 'stop', message }] })) as typeof fetch });
    await assert.rejects(provider.recognize(image, signal()), isError('PROVIDER_REFUSED'));
  }
});

test('empty tool-call arrays do not reject an otherwise complete plain JSON response', async () => {
  const content = JSON.stringify({ latex, uncertainSymbols: [] });
  const cloud = new DeepSeekProvider({ apiKey: 'fixture-key', fetcher: (async () => json({ choices: [{ finish_reason: 'stop', message: { content, tool_calls: [] } }] })) as typeof fetch });
  const local = new OllamaProvider({ fetcher: localFetcher((async () => json({ done: true, done_reason: 'stop', message: { content, tool_calls: [] } })) as typeof fetch) });
  for (const provider of [cloud, local]) assert.equal((await provider.recognize(image, signal())).latex, latex);
});

test('fetch and response-body waits both stop on the deadline, including transports that ignore signals', async () => {
  for (const local of [false, true]) {
    for (const bodyHang of [false, true]) {
      let calls = 0;
      const fetcher = (async () => { calls++; return bodyHang ? new Response(new ReadableStream({ start() {} })) : new Promise<Response>(() => {}); }) as typeof fetch;
      const provider = local ? new OllamaProvider({ timeoutMs: 20, fetcher }) : new DeepSeekProvider({ apiKey: 'fixture-key', timeoutMs: 20, fetcher });
      const start = Date.now();
      await assert.rejects(provider.recognize(image, signal()), isError('PROVIDER_TIMEOUT'));
      assert.ok(Date.now() - start < 2000);
      assert.equal(calls, 1);
    }
  }
  let calls = 0;
  const provider = new DeepSeekProvider({ apiKey: 'fixture-key', fetcher: (async () => { calls++; throw new Error('PRIVATE_NETWORK_DETAILS'); }) as typeof fetch });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(provider.recognize(image, controller.signal), isError('PROVIDER_TIMEOUT'));
  assert.equal(calls, 0);
  await assert.rejects(provider.recognize(image, signal()), isError('PROVIDER_UNAVAILABLE'));
});

test('response bodies have a hard byte limit even without content-length and malformed UTF-8 is rejected', async () => {
  for (const response of [new Response('x', { headers: { 'Content-Length': '1000001' } }), new Response('x'.repeat(1000001)), new Response(new Uint8Array([0xff, 0xfe]))]) {
    const provider = new DeepSeekProvider({ apiKey: 'fixture-key', fetcher: (async () => response) as typeof fetch });
    await assert.rejects(provider.recognize(image, signal()), isError('PROVIDER_BAD_RESPONSE'));
  }
});

test('input bounds and local review context fail before any image or text leaves the process', async () => {
  let calls = 0;
  const fetcher = (async () => { calls++; throw new Error('PRIVATE'); }) as typeof fetch;
  for (const provider of [new DeepSeekProvider({ apiKey: 'fixture-key', fetcher }), new OllamaProvider({ fetcher })]) {
    await assert.rejects(provider.recognize(Buffer.alloc(0), signal()), isError('INVALID_IMAGE'));
    await assert.rejects(provider.recognize(Buffer.alloc(1400001), signal()), isError('INVALID_IMAGE'));
    await assert.rejects(provider.review('', undefined, signal()), isError('INVALID_REQUEST'));
    await assert.rejects(provider.review(latex, 'x'.repeat(10001), signal()), isError('INVALID_REQUEST'));
    await assert.rejects(provider.review('x\u0000y', undefined, signal()), isError('INVALID_REQUEST'));
  }
  await assert.rejects(new OllamaProvider({ fetcher }).review('x'.repeat(2500), undefined, signal()), isError('CONTEXT_TOO_LARGE'));
  assert.equal(calls, 0);
});
