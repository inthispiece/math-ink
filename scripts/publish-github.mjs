import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const owner = 'inthispiece';
const identity = `${171497711}+${owner}@users.noreply.github.com`;
function run(command, args, cwd = process.cwd(), capture = false) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', timeout: 180000 });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args[0]} 失败：${result.error?.message || result.stderr || result.status}`);
  return result.stdout?.trim() || '';
}
const login = run('gh', ['api', 'user', '--jq', '.login'], undefined, true);
if (login !== owner) throw new Error(`当前 GitHub 账号不是计划中的 ${owner}；停止发布以避免发到错误账号。`);
const sources = [
  ['siyuan', 'siyuan-note/siyuan', 'mathink-core'],
  ['siyuan-android', 'siyuan-note/siyuan-android', 'mathink-android'],
  ['siyuan-harmony', 'siyuan-note/siyuan-harmony', 'mathink-harmony'],
  ['butterfly', 'LinwoodDev/Butterfly', 'mathink-butterfly']
];
const published = [];
for (const [directory, upstream, fork] of sources) {
  const cwd = resolve('upstream', directory);
  const repo = `${owner}/${fork}`;
  const metadata = JSON.parse(run('gh', ['api', `repos/${repo}`], undefined, true));
  if (metadata.parent?.full_name.toLowerCase() !== upstream.toLowerCase() || metadata.private) throw new Error(`${repo} 不是预期公开 fork`);
  run('git', ['config', 'user.name', owner], cwd);
  run('git', ['config', 'user.email', identity], cwd);
  const branch = run('git', ['branch', '--show-current'], cwd, true);
  if (!branch) run('git', ['switch', '-c', 'mathink-preview'], cwd);
  else if (branch !== 'mathink-preview') throw new Error(`子项目 ${directory} 正在非预期分支 ${branch}，停止发布。`);
  const before = run('git', ['rev-parse', 'HEAD'], cwd, true);
  run('git', ['add', '-u'], cwd);
  const changes = run('git', ['diff', '--cached', '--name-only'], cwd, true);
  if (changes.split(/\r?\n/).some(path => /\.(?:zip|apk|aab|aar|hap|app|so|keystore|jks|p12|p7b)$/i.test(path))) throw new Error(`${directory} 暂存区含构建产物或签名文件，请只提交源代码。`);
  if (changes) run('git', ['commit', '-m', 'Add MathInk preview integration'], cwd);
  const url = `https://github.com/${repo}.git`;
  run('git', ['remote', 'set-url', 'origin', url], cwd);
  run('git', ['push', '-u', 'origin', 'mathink-preview'], cwd);
  run('gh', ['repo', 'edit', repo, '--default-branch', 'mathink-preview']);
  run('git', ['config', '-f', '.gitmodules', `submodule.upstream/${directory}.url`, url]);
  run('git', ['config', `submodule.upstream/${directory}.url`, url]);
  published.push({ name: directory, directory, upstream, fork: repo, integrationCommit: run('git', ['rev-parse', 'HEAD'], cwd, true), previousCommit: before });
}
await writeFile('platforms/published-sources.json', JSON.stringify({ generatedAt: new Date().toISOString(), repositories: published }, null, 2) + '\n');
run('git', ['config', 'user.name', owner]);
run('git', ['config', 'user.email', identity]);
const remote = spawnSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' });
if (remote.status !== 0) run('git', ['remote', 'add', 'origin', `https://github.com/${owner}/math-ink.git`]);
else if (remote.stdout.trim() !== `https://github.com/${owner}/math-ink.git`) throw new Error('主仓库 origin 不匹配，停止发布。');
run('git', ['add', '.']);
const staged = run('git', ['diff', '--cached', '--name-only'], undefined, true);
if (staged.split(/\r?\n/).some(path => /(^|\/)\.env(?:$|\.(?!example$))|\.(?:sqlite(?:-shm|-wal)?|db|keystore|jks|p12|p7b|pem|key|bfly|mathink\.json)$/i.test(path))) throw new Error('暂存区含凭据、原稿或私有数据库，停止发布。');
if (staged) run('git', ['commit', '-m', 'Implement MathInk local development preview']);
run('git', ['push', '-u', 'origin', 'main']);
console.log(`Published: https://github.com/${owner}/math-ink`);
