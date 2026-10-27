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
  version: '0.1.0-preview.9', builtAt: new Date().toISOString(),
  noteBackupSchema: 4, notebookDatabaseSchema: 4, pageWorkbench: 'development-preview',
  interaction: 'notebook-first-multipage-drafts', cloudQuality: 'not-evaluated', deviceHandwriting: 'not-accepted',
  bugfixPlan: 'BUGFIX-002-v1.0', acceptance: 'pending',
  source: 'https://github.com/inthispiece/math-ink',
  sourceCommit: revision.status === 0 ? revision.stdout.trim() : null,
  upstreams: published?.repositories || JSON.parse(await readFile('platforms/upstreams.lock.json', 'utf8')).repositories,
  node: process.versions.node,
};
await writeFile(join(stage, 'BUILD-INFO.json'), JSON.stringify(buildInfo, null, 2) + '\n');
await writeFile('dist/plugin/math-ink/BUILD-INFO.json', JSON.stringify(buildInfo, null, 2) + '\n');
const previewReadme = [
  '# MathInk 开发预览 · 0.1.0-preview.9（待验收）', '',
  '需要 Node.js 24，无需安装 npm 依赖。Windows 双击 Start-MathInk.cmd；同一 Wi-Fi 平板实验双击 Start-MathInk-Lan.cmd，无需调整 PowerShell 执行策略。终端也可运行：', '',
  '```sh', 'node --env-file-if-exists=.env scripts/serve-preview.mjs --web-root web', '```', '',
  '本机页面自动配对。平板打开启动窗口打印的配对链接；链接含凭据，请勿公开分享。自动令牌保存在 .local/pairing-token，重启复用；.env 明确配置优先。旧页面可强制刷新，不要清除笔记。', '',
  '先进入“我的笔记”，新建后即可书写、新增页和管理页面，普通笔记不需要密钥或模型。页面、笔迹和视图自动保存。工具箱和草稿箱按需打开；新笔记手写引擎仅影响以后创建的笔记，已有原稿不隐式转换。', '',
  '本批新增 PDF 导入导出、识别排版页阅读/编辑切换、整文档识别、单层文件夹和滑动翻页。PDF、目录和阅读操作均在本地完成，不调用 AI。笔记库可新建文件夹，经笔记菜单移动，或拖入目录；平板可长按拖动。删除目录仅将笔记移回未分类，回收站中的归属也一起处理。', '',
  '笔记库“导入 → PDF”新建笔记，笔记内“更多 → 导入 PDF”可追加到当前页后。先预览并选择页码范围，再确认导入；原 PDF 是固定底图，手写批注另存，普通擦除和套索不会修改原文。加密文件暂不支持。笔记菜单“导出 → PDF”按正式页序输出，可选范围、底纹和质量，预览实际输出页数；长排版页可能续成多张纸，图片模式不含可搜索文字层。PDF 用于阅读分享，恢复编辑请另存完整备份。', '',
  '常规套索可选择笔迹和已插入公式，拖动移动、控制点等比缩放；平移/双指只改变视图。识别公式复用纯笔迹选区，空选区、混选或只选排版公式会明确提示调整。圈选本身不上传，核对原图和范围后再提交；整页识别单独预览完整当前页。成功自动存原笔记草稿箱，不改正文、不翻页、不新建笔记。', '',
  '草稿编辑自动保存，人工核对和插入另行确认。公式选择放置位置，整页明确加入排版页。每次插入是独立副本，后改草稿不联动旧实例，撤销插入保留草稿。', '',
  '识别生成的正式排版页默认阅读，只显示正文与公式；撤销、重做右侧的“编辑模式”开关用于修改内容。进入编辑后选中块再显示编辑和原稿操作，实际修改可撤销。切页或重开恢复阅读模式，旧“原有整理内容”页仍保留原编辑入口。', '',
  '笔记库三点菜单和笔记内“更多”均可“识别整个文档”。确认页序、服务和发送范围后，任务逐页处理；已有排版页直接复制，确认空白页保留位置且不调用模型。结果先保留在文档任务中，可查看逐页进度、暂停、继续或明确重试失败页，再选择生成一份多页草稿或另存独立笔记；原笔记不会被整本替换。独立副本保留原来源标识与可用的本地历史快照。', '',
  '模型已收到与设备已保存分别显示。已收到但待保存时，可查看/复制/导出收到的结果，再重试本地保存，不重新识别。旧版导出的原始 Reply 可从草稿箱底部“恢复收到的结果”导入，按本机原任务/供应商/来源校验归属；它不是完整笔记备份，原材料或缓存已丢失时不能保证恢复。', '',
  '实验画布按笔记和页面记录当前会话的笔迹、公式插入/删除/编辑/移动/缩放，一次手势一条命令；撤销删除恢复同一实例。Butterfly 保留当前笔记原生文档时间线，跨页影响会提示。历史已执行但保存失败时只重试保存，不多撤销一步；不承诺重启恢复整条历史。', '',
  '纸面下方显示实时缩放百分比，双击恢复逻辑 100%；排版页单独保存阅读缩放和位置。滑动翻页只在符合边缘与缩放条件时触发，写字、选择和拖动内容优先；这些触控交互仍需在目标安卓/鸿蒙平板验收。', '',
  '真实识别先将 .env.example 复制为 .env 并在服务端配置凭据；应用设置可选 DeepSeek、本地 Qwen 或 Mathpix。供应商密钥不填配对栏。默认模拟服务不会冒充真实转写；可先用手工 LaTeX 草稿、本地检索和多项式核对。中文步骤见 web/ai-setup.html。本地模型另装：Setup-Qwen.cmd 下载，Start-Qwen.cmd 运行。', '',
  '选区和整页任务重开后只查询原请求，不自动重复生成；整文档任务恢复或从完整备份导入后，也要明确点击继续才会提交尚未发送的页面。切换模型不改变旧任务的原服务和账号。连接失效或服务重启可能无法恢复正文，同步文字检查中断也不保证可查询。明确重做可能再次计费，取消不能保证撤销供应商计算。次数和金额保护与供应商实际账单分别计算。', '',
  '完整 JSON 备份为 schema 4，包含空文件夹、每本笔记的目录归属、原 PDF 文件、草稿箱、整本文档任务、逐页输入及来源快照。资源池按内容哈希将重复 PNG/JPEG 与 Butterfly 原稿唯一编码；仍兼容无资源池的 schema 4 和旧 1/2/3。导入校验完整资源及引用后统一写入，目录 ID 或名称冲突需要明确选择映射，不按名称自动合并；覆盖笔记前先备份并确认。数据库升级同事务保留旧格式恢复快照，失败回滚。', '',
  'Markdown、LaTeX 和思源普通导出只含正式内容及所需资产，排除未插入草稿和临时任务；完整备份包含更广的私人材料，分享前请检查。任务原始 Reply 导出仍使用原恢复格式，并不等同于完整备份。不同地址的浏览器数据不自动同步。', '',
  '已打开笔记可断网书写；首次加载并完成生产资源缓存后才能离线重开，云识别仍需联网。本构建对应BUGFIX-002 v1.0，整体待验收；软件回归不代表真机笔感。真实AI质量和费用本轮未评测，安卓/鸿蒙原生包、真机笔压/掌触/延迟和商城审核尚未完成。', '',
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
