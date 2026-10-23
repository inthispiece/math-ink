import { cp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { spawnSync } from 'node:child_process';
const stage = resolve('dist/preview-stage');
const distRoot = resolve('dist');
if (relative(distRoot, stage) !== 'preview-stage') throw new Error('预览打包目录不在预期 dist 范围内。');
// A prior preview extraction may contain .env or old assets. Never carry those into a new release.
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await cp('dist/web', join(stage, 'web'), { recursive: true });
await cp('apps/gateway/src', join(stage, 'apps/gateway/src'), { recursive: true });
await mkdir(join(stage, 'scripts'), { recursive: true });
await cp('scripts/serve-preview.mjs', join(stage, 'scripts/serve-preview.mjs'));
await cp('scripts/pairing.mjs', join(stage, 'scripts/pairing.mjs'));
for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md', '.env.example']) await cp(file, join(stage, file));
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true });
const published = await readFile('platforms/published-sources.json', 'utf8').then(JSON.parse).catch(error => {
  if (error.code === 'ENOENT') return null;
  throw error;
});
const buildInfo = {
  version: '0.1.0', builtAt: new Date().toISOString(),
  source: 'https://github.com/inthispiece/math-ink',
  sourceCommit: revision.status === 0 ? revision.stdout.trim() : null,
  upstreams: published?.repositories || JSON.parse(await readFile('platforms/upstreams.lock.json', 'utf8')).repositories,
  node: process.versions.node,
};
await writeFile(join(stage, 'BUILD-INFO.json'), JSON.stringify(buildInfo, null, 2) + '\n');
await writeFile('dist/plugin/math-ink/BUILD-INFO.json', JSON.stringify(buildInfo, null, 2) + '\n');
await writeFile(join(stage, 'README.md'), '# MathInk 开发预览\n\n需要 Node.js 24，无需安装 npm 依赖。解压后运行：\n\n```sh\nnode --env-file-if-exists=.env scripts/serve-preview.mjs --web-root web\n```\n\n本机页面自动配对。同一 Wi-Fi 平板实验可在命令末尾加上 `--lan`，打开终端打印的平板配对链接。链接包含凭据，请勿公开分享。自动生成的令牌保存在 `.local/pairing-token`，重启继续使用；`.env` 中明确配置的令牌优先。升级后若页面仍为旧版，请强制刷新，无需清除笔记。\n\n访问终端地址，默认模拟识别（预设公式）。真实识别需要把 .env.example 复制为 .env 并配置服务端凭据。数据保存在当前浏览器，请导出备份。Android/Harmony 原生安装包、真机笔感及商城审核另行验收。完整源码：https://github.com/inthispiece/math-ink\n');
async function zipDirectory(directory, output, prefix = '') {
  const files = {};
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`发布文件中不允许符号链接：${relative(directory, file)}`);
      if (entry.name === '.env' || /\.(?:sqlite(?:-shm|-wal)?|db|keystore|jks|p12|p7b|pem|key)$/i.test(entry.name)) throw new Error(`发布文件中包含本机凭据或数据库：${relative(directory, file)}`);
      if (entry.isDirectory()) await walk(file);
      else files[prefix + relative(directory, file).replaceAll('\\', '/')] = new Uint8Array(await readFile(file));
    }
  }
  await walk(directory);
  await writeFile(output, zipSync(files, { level: 6 }));
}
await mkdir('dist/release', { recursive: true });
await zipDirectory(stage, 'dist/release/mathink-preview-0.1.0.zip', 'mathink-preview/');
await zipDirectory(resolve('dist/plugin/math-ink'), 'dist/release/mathink-siyuan-plugin-0.1.0.zip', 'math-ink/');
let hashes = '';
for (const name of await readdir('dist/release')) if (name.endsWith('.zip')) hashes += `${createHash('sha256').update(await readFile(join('dist/release', name))).digest('hex')}  ${name}\n`;
await writeFile('dist/release/SHA256SUMS', hashes);
console.log('生成 dist/release 中的开发预览、思源插件及 SHA256 清单。');
