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
await cp('scripts/local-qwen.mjs', join(stage, 'scripts/local-qwen.mjs'));
await cp('scripts/hosted-admin.mjs', join(stage, 'scripts/hosted-admin.mjs'));
await cp('scripts/eval-ai.mjs', join(stage, 'scripts/eval-ai.mjs'));
await cp('evaluation', join(stage, 'evaluation'), { recursive: true });
for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md', '.env.example']) await cp(file, join(stage, file));
for (const file of ['Start-MathInk.cmd', 'Start-MathInk-Lan.cmd', 'Start-Qwen.cmd', 'Setup-Qwen.cmd']) await cp(file, join(stage, file));
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true });
const published = await readFile('platforms/published-sources.json', 'utf8').then(JSON.parse).catch(error => {
  if (error.code === 'ENOENT') return null;
  throw error;
});
const buildInfo = {
  version: '0.1.0', builtAt: new Date().toISOString(),
  noteBackupSchema: 2, pageWorkbench: 'development-preview', cloudQuality: 'not-evaluated',
  source: 'https://github.com/inthispiece/math-ink',
  sourceCommit: revision.status === 0 ? revision.stdout.trim() : null,
  upstreams: published?.repositories || JSON.parse(await readFile('platforms/upstreams.lock.json', 'utf8')).repositories,
  node: process.versions.node,
};
await writeFile(join(stage, 'BUILD-INFO.json'), JSON.stringify(buildInfo, null, 2) + '\n');
await writeFile('dist/plugin/math-ink/BUILD-INFO.json', JSON.stringify(buildInfo, null, 2) + '\n');
await writeFile(join(stage, 'README.md'), '# MathInk 开发预览\n\n需要 Node.js 24，无需安装 npm 依赖。Windows 可双击 Start-MathInk.cmd 启动本机预览；平板实验双击 Start-MathInk-Lan.cmd，无需调整 PowerShell 执行策略。终端也可运行：\n\n```sh\nnode --env-file-if-exists=.env scripts/serve-preview.mjs --web-root web\n```\n\n本机页面自动配对。同一 Wi-Fi 平板实验可在命令末尾加上 `--lan`，打开终端打印的平板配对链接。链接包含凭据，请勿公开分享。自动生成的令牌保存在 `.local/pairing-token`，重启继续使用；`.env` 中明确配置的令牌优先。升级后若页面仍为旧版，请强制刷新，无需清除笔记。\n\n主按钮只接受已配置的真实识别；默认模拟服务请使用独立的“查看固定样例演示”，完全本地、不上传、不限次数。真实识别需要把 .env.example 复制为 .env 并配置服务端凭据；可在设置切换 DeepSeek 云端与本地 Qwen，转写和公式检查独立操作，中文步骤见 web/ai-setup.html。本地模型另行安装，Setup-Qwen.cmd 下载模型，Start-Qwen.cmd 启动本地服务。设置显示额度与重置时间，本地成本上限与供应商账单独立。数据保存在当前浏览器，请导出备份。Android/Harmony 原生安装包、真机笔感及商城审核另行验收。完整源码：https://github.com/inthispiece/math-ink\n');
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
