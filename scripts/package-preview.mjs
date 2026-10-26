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
  version: '0.1.0-preview.7', builtAt: new Date().toISOString(),
  noteBackupSchema: 3, notebookDatabaseSchema: 3, pageWorkbench: 'development-preview',
  interaction: 'notebook-first-multipage-drafts', cloudQuality: 'not-evaluated', deviceHandwriting: 'not-accepted',
  source: 'https://github.com/inthispiece/math-ink',
  sourceCommit: revision.status === 0 ? revision.stdout.trim() : null,
  upstreams: published?.repositories || JSON.parse(await readFile('platforms/upstreams.lock.json', 'utf8')).repositories,
  node: process.versions.node,
};
await writeFile(join(stage, 'BUILD-INFO.json'), JSON.stringify(buildInfo, null, 2) + '\n');
await writeFile('dist/plugin/math-ink/BUILD-INFO.json', JSON.stringify(buildInfo, null, 2) + '\n');
const previewReadme = [
  '# MathInk 开发预览 · 0.1.0-preview.7', '',
  '需要 Node.js 24，无需安装 npm 依赖。Windows 双击 Start-MathInk.cmd；同一 Wi-Fi 平板实验双击 Start-MathInk-Lan.cmd，无需调整 PowerShell 执行策略。终端也可运行：', '',
  '```sh', 'node --env-file-if-exists=.env scripts/serve-preview.mjs --web-root web', '```', '',
  '本机页面自动配对。平板打开启动窗口打印的配对链接；链接含凭据，请勿公开分享。自动令牌保存在 .local/pairing-token，重启复用；.env 明确配置优先。旧页面可强制刷新，不要清除笔记。', '',
  '先进入“我的笔记”，新建后即可书写、新增页和管理页面，普通笔记不需要密钥或模型。页面、笔迹和视图自动保存。工具箱和草稿箱按需打开；新笔记手写引擎仅影响以后创建的笔记，已有原稿不隐式转换。', '',
  '识别公式：工具箱选择→圈选→点击识别→核对原图和范围→明确提交。圈选本身不上传。识别整页单独预览完整当前页。成功自动存进原笔记草稿箱，不改正式内容、不翻页、不新建笔记；等待时可以继续写。', '',
  '草稿编辑自动保存，人工核对和插入另行确认。公式选择放置位置，整页明确加入排版页。每次插入是独立副本，后改草稿不联动旧实例，撤销插入保留草稿。', '',
  '真实识别先将 .env.example 复制为 .env 并在服务端配置凭据；应用设置可选 DeepSeek、本地 Qwen 或 Mathpix。供应商密钥不填配对栏。默认模拟服务不会冒充真实转写；可先用手工 LaTeX 草稿、本地检索和多项式核对。中文步骤见 web/ai-setup.html。本地模型另装：Setup-Qwen.cmd 下载，Start-Qwen.cmd 运行。', '',
  '选区和整页任务重开后只查询原请求，不自动重复生成；切换模型不改变旧任务的原服务和账号。连接失效或服务重启可能无法恢复正文，同步文字检查中断也不保证可查询。明确重做可能再次计费，取消不能保证撤销供应商计算。次数和金额保护与供应商实际账单分别计算。', '',
  '完整备份为 schema 3，兼容导入 1/2；数据库升级同事务保留旧格式快照，失败回滚。旧正文在“原有整理内容”页继续可见可编辑。Markdown、LaTeX 和思源普通导出只含正式页面；完整 JSON 备份才包含草稿箱、任务及来源快照，分享前请检查。不同地址的浏览器数据不自动同步。', '',
  '已打开笔记可断网书写；首次加载并完成生产资源缓存后才能离线重开，云识别仍需联网。真实云端质量和费用尚未评测，安卓/鸿蒙原生包、真机笔压/掌触/延迟和商城审核尚未完成。', '',
  '完整源码：https://github.com/inthispiece/math-ink', '',
].join('\n');
await writeFile(join(stage, 'README.md'), previewReadme);
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
