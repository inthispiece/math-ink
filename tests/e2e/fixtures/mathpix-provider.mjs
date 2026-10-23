// Loaded only by this suite's isolated server process, with fixture-only credentials.
// Exercise the real HTTP gateway/provider/SQLite path without sending paid requests.
if (process.env.MATHINK_E2E_PROVIDER_FIXTURE !== '1' || process.env.MATHPIX_APP_ID !== 'e2e-app-id' || process.env.MATHPIX_APP_KEY !== 'e2e-key-not-real') {
  throw new Error('The isolated provider fixture requires explicit test credentials');
}
const originalFetch = globalThis.fetch;
let mathpixCalls = 0;
let ollamaShowCalls = 0;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.origin === 'http://127.0.0.1:11439') {
    if (process.env.MATHINK_E2E_OLLAMA_FIXTURE !== '1' || process.env.OLLAMA_BASE_URL !== url.origin) throw new Error('The local model fixture requires its explicit isolated URL');
    if (init?.method !== 'POST') throw new Error('Unexpected local model fixture request');
    const body = JSON.parse(init.body);
    if (body.model !== 'qwen3-vl:2b') throw new Error('Unexpected local model fixture model');
    if (url.pathname === '/api/show') {
      if (++ollamaShowCalls === 1) return Response.json({ error: 'fixture model not found' }, { status: 404 });
      return Response.json({ capabilities: ['vision'] });
    }
    if (url.pathname === '/api/chat') {
      if (body.stream !== false || !body.messages?.some(message => message.role === 'user' && message.images?.length === 1)) throw new Error('Unexpected local transcription fixture body');
      return Response.json({ done: true, done_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ latex: 'x^2', uncertainSymbols: [] }) } });
    }
    throw new Error('Unexpected local model fixture endpoint');
  }
  if (url.href === 'https://api.mathpix.com/v3/text') {
    const headers = new Headers(init?.headers);
    if (init?.method !== 'POST' || headers.get('app_id') !== 'e2e-app-id' || headers.get('app_key') !== 'e2e-key-not-real') throw new Error('Unexpected test provider request');
    if (++mathpixCalls === 1 && process.env.MATHINK_E2E_MATHPIX_FAIL_FIRST === '1') return Response.json({ error: 'fixture provider unavailable' }, { status: 503 });
    return new Response(JSON.stringify({ latex_styled: 'x^2', confidence: 0.98 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  // Gateway-to-model traffic may only use the intercepted fixture endpoint, never an actual local Ollama.
  if (['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !['11434', '11439'].includes(url.port)) return originalFetch(input, init);
  throw new Error('External network is disabled in the isolated OCR fixture');
};
