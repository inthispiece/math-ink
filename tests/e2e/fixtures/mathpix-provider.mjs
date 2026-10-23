// Loaded only by this suite's isolated server process, with fixture-only credentials.
// Exercise the real HTTP gateway/provider/SQLite path without sending paid requests.
if (process.env.MATHINK_E2E_PROVIDER_FIXTURE !== '1' || process.env.MATHPIX_APP_ID !== 'e2e-app-id' || process.env.MATHPIX_APP_KEY !== 'e2e-key-not-real') {
  throw new Error('The isolated provider fixture requires explicit test credentials');
}
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.href === 'https://api.mathpix.com/v3/text') {
    const headers = new Headers(init?.headers);
    if (init?.method !== 'POST' || headers.get('app_id') !== 'e2e-app-id' || headers.get('app_key') !== 'e2e-key-not-real') throw new Error('Unexpected test provider request');
    return new Response(JSON.stringify({ latex_styled: 'x^2', confidence: 0.98 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return originalFetch(input, init);
  throw new Error('External network is disabled in the isolated OCR fixture');
};
