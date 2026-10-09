import { createServer } from 'node:http';
import { readFile, stat, realpath } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { createGateway } from '../apps/gateway/src/gateway.ts';
const rootArg = process.argv.indexOf('--web-root');
if (rootArg >= 0 && (!process.argv[rootArg + 1] || process.argv[rootArg + 1].startsWith('--'))) throw new Error('--web-root 需要指定目录。');
const webRoot = await realpath(resolve(rootArg >= 0 ? process.argv[rootArg + 1] : 'dist/web'));
const entry = await stat(resolve(webRoot, 'index.html')).catch(() => { throw new Error('缺少预览文件，请先运行 pnpm build'); });
if (!entry.isFile()) throw new Error('预览入口 index.html 必须是文件。');
const gateway = createGateway();
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.map': 'application/json' };
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url || '/', 'http://preview.local');
    if (url.pathname.startsWith('/v1/') || url.pathname === '/health') return gateway.handle(request, response);
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
    let path;
    try { path = resolve(webRoot, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)); }
    catch { response.writeHead(400); response.end(); return; }
    if (path !== webRoot && !path.startsWith(webRoot + sep)) { response.writeHead(403); response.end(); return; }
    try {
      // A local symlink/junction must not expose files outside the selected static root.
      const real = await realpath(path);
      if (real !== webRoot && !real.startsWith(webRoot + sep)) { response.writeHead(403); response.end(); return; }
      const info = await stat(real);
      if (!info.isFile()) throw new Error('Not a file');
      const body = request.method === 'HEAD' ? undefined : await readFile(real);
      response.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream', 'Content-Length': body?.length ?? info.size, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': extname(path) === '.html' || path.endsWith('sw.js') ? 'no-cache' : 'public, max-age=3600' });
      response.end(body);
    } catch { response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('资源不存在'); }
  })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end('预览服务暂时不可用'); });
});
server.requestTimeout = 30000;
server.listen(gateway.config.port, gateway.config.host, () => console.log(`MathInk 开发预览：http://${gateway.config.host}:${gateway.config.port}（${gateway.provider.simulated ? '模拟识别' : '真实识别'}）`));
let gatewayClosed = false;
function closeGateway() { if (!gatewayClosed) { gatewayClosed = true; gateway.close(); } }
server.once('error', () => { closeGateway(); console.error('预览启动失败，请检查端口及配置'); process.exitCode = 1; });
server.once('close', closeGateway);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
