import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { HostedAuthStore } from '../apps/gateway/src/hosted-auth.ts';

test('operator backup and restoration lockdown revoke restored permissions before reviewed accounts reopen', async t => {
  const directory=mkdtempSync(join(tmpdir(),'mathink-operator-'));
  const path=join(directory,'source.sqlite'),target=join(directory,'backup.sqlite');
  t.after(()=>{assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep)&&directory.includes('mathink-operator-'));rmSync(directory,{recursive:true,force:true});});
  const auth=new HostedAuthStore(path);
  const user=await auth.createUser('fixture-user','operator-test-password!');
  const session=await auth.login('fixture-user','operator-test-password!');
  const run=(args:string[],database=path)=>spawnSync(process.execPath,['scripts/hosted-admin.mjs',...args],{cwd:resolve('.'),env:{...process.env,GATEWAY_DATABASE_PATH:database},encoding:'utf8',windowsHide:true});
  try {
    const result=run(['backup',target]);
    assert.equal(result.status,0,result.stderr);
    assert.ok(existsSync(target)); assert.match(result.stdout,/SHA256:/);
    const refuse=run(['backup',target]);assert.notEqual(refuse.status,0);
    const restored=new HostedAuthStore(target);
    try {
      assert.equal(restored.authenticate('Bearer '+session.sessionToken).username,'fixture-user');
      const revoke=run(['restore-lockdown'],target);assert.equal(revoke.status,0,revoke.stderr);
      assert.throws(()=>restored.authenticate('Bearer '+session.sessionToken),/会话无效/);
      await assert.rejects(restored.login('fixture-user','operator-test-password!'),/会话无效/);
      const enable=run(['enable',user.id],target);assert.equal(enable.status,0,enable.stderr);
      assert.equal((await restored.login('fixture-user','operator-test-password!')).user.id,user.id);
      assert.equal(auth.authenticate('Bearer '+session.sessionToken).username,'fixture-user');
    } finally {restored.close();}
  } finally {auth.close();}
});
