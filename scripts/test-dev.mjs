// A separate, credential-free test service; never inherit a developer's paid API keys.
Object.assign(process.env, { DEEPSEEK_API_KEY: '', MATHPIX_APP_ID: '', MATHPIX_APP_KEY: '', GATEWAY_AUTH_MODE: 'local', GATEWAY_PAIRING_TOKEN: '', GATEWAY_PORT: '8793', MATHINK_WEB_PORT: '5175', GATEWAY_DATABASE_PATH: '.local/browser-tests.sqlite', OCR_PROVIDER: 'mock' });
process.argv.push('--demo');
await import('./dev.mjs');
