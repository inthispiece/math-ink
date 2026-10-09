import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createGateway } from './gateway.ts';
import type { GatewayConfig } from './config.ts';

export function startGateway(config?: GatewayConfig) {
  const gateway = createGateway({ config });
  const server = createServer((request, response) => { void gateway.handle(request, response); });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.listen(gateway.config.port, gateway.config.host);
  server.once('close', () => gateway.close());
  return { server, gateway };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { server, gateway } = startGateway();
    server.once('listening', () => console.log(`MathInk OCR: http://${gateway.config.host}:${gateway.config.port} (${gateway.provider.name}${gateway.provider.simulated ? '，模拟识别' : ''})`));
    server.on('error', () => { console.error('识别服务启动失败，请检查监听地址、端口及数据库权限。'); process.exitCode = 1; });
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close());
  } catch {
    console.error('识别服务配置无效，请检查环境变量和数据库权限；局域网模式必须设置配对令牌。');
    process.exitCode = 1;
  }
}
