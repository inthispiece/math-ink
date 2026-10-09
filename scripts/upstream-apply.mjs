import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const lock = JSON.parse(await readFile(resolve(root, 'platforms/upstreams.lock.json'), 'utf8'));
const published = JSON.parse(await readFile(resolve(root, 'platforms/published-sources.json'), 'utf8')
  .catch(error => { if (error.code === 'ENOENT') return '{"repositories":[]}'; throw error; }));
function git(path, args) {
  return spawnSync('git', ['-C', path, ...args], {encoding: 'utf8', windowsHide: true});
}
for (const repo of lock.repositories) {
  const path = resolve(root, repo.path);
  const head = git(path, ['rev-parse', 'HEAD']);
  const integration = published.repositories.find(item => item.name === repo.name)?.integrationCommit;
  if (head.status !== 0 || ![repo.commit, integration].includes(head.stdout.trim())) {
    throw new Error(`${repo.name}: initialize the pinned submodule first (git submodule update --init --recursive)`);
  }
  if (!repo.patch) continue;
  const patch = resolve(root, repo.patch);
  if (git(path, ['apply', '--reverse', '--check', patch]).status === 0) {
    console.log(`${repo.name}: patch already applied`); continue;
  }
  const check = git(path, ['apply', '--check', patch]);
  if (check.status !== 0) throw new Error(`${repo.name}: patch cannot apply; local edits preserved\n${check.stderr}`);
  const result = git(path, ['apply', patch]);
  if (result.status !== 0) throw new Error(result.stderr);
  console.log(`${repo.name}: applied ${repo.patch}`);
}
