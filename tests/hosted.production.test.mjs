import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { HostedAuthStore } from '../apps/gateway/src/hosted-auth.ts';
import { QuotaStore } from '../apps/gateway/src/store.ts';
import { configFromEnv } from '../apps/gateway/src/config.ts';
import { chromium } from '@playwright/test';
import { waitForLibrary, createNotebook, manualFormulaDraft, isGenerationRequest } from './production-ui.mjs';

const root=resolve('.');
const hash=value=>createHash('sha256').update(value).digest('hex');
const pause=ms=>new Promise(done=>setTimeout(done,ms));
async function run(args,env){
  const child=spawn(process.execPath,args,{cwd:root,env,stdio:['ignore','pipe','pipe'],windowsHide:true});
  let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  const [code]=await once(child,'exit');assert.equal(code,0,output);return output;
}

test('production hosted library UI, schema-4 local backups, real identity APIs and private account metadata work without cloud credentials',{timeout:120000},async t=>{
  await stat(resolve('dist/web/index.html')); // Run pnpm build before this production check.
  const temporary=await mkdtemp(join(tmpdir(),'mathink-hosted-production-'));
  const databasePath=join(temporary,'gateway.sqlite');
  const env={...process.env,GATEWAY_AUTH_MODE:'hosted',GATEWAY_HOST:'127.0.0.1',GATEWAY_PORT:'0',GATEWAY_PAIRING_TOKEN:'',GATEWAY_DATABASE_PATH:databasePath,GATEWAY_ALLOWED_ORIGINS:'',OCR_PROVIDER:'deepseek',DEEPSEEK_API_KEY:'',MATHPIX_APP_ID:'',MATHPIX_APP_KEY:'',DEEPSEEK_MODEL:'deepseek-flash',AI_PRICE_CONFIG:JSON.stringify({model:'deepseek-flash',date:'2026-10-24',currency:'CNY',inputPerMillion:2,cachedInputPerMillion:1,outputPerMillion:4})};
  // These are explicit test rates, never advertised as real supplier prices.
  const auth=new HostedAuthStore(databasePath);
  const inviteA=auth.createInvite({expiresAt:Date.now()+3600000});
  const inviteB=auth.createInvite({expiresAt:Date.now()+3600000});
  auth.close();
  const server=spawn(process.execPath,['scripts/serve-preview.mjs','--web-root','dist/web'],{cwd:root,env,stdio:['ignore','pipe','pipe'],windowsHide:true});
  let output='';server.stdout.on('data',chunk=>output+=chunk);server.stderr.on('data',chunk=>output+=chunk);
  let browser;
  t.after(async()=>{
    await browser?.close();
    if(server.exitCode===null){const stopped=once(server,'exit');server.kill();await stopped;}
    const checked=resolve(temporary);assert.ok(checked.startsWith(resolve(tmpdir())+sep)&&checked.includes('mathink-hosted-production-'));
    await rm(checked,{recursive:true,force:true});
  });
  let base;
  for(let attempt=0;attempt<100;attempt++){
    if(server.exitCode!==null)throw new Error('Hosted preview stopped: '+output);
    const found=/http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
    if(found){base=`http://127.0.0.1:${found[1]}`;if((await fetch(base+'/health')).ok)break;}
    await pause(50);
  }
  assert.ok(base,'No random-port hosted entry was reported: '+output);assert.notEqual(new URL(base).port,'8787');
  const post=async(path,body,token)=>{
    const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
    return {status:response.status,headers:response.headers,body:await response.json()};
  };
  const get=async(path,token)=>{const response=await fetch(base+path,{headers:token?{Authorization:'Bearer '+token}:{}});return {status:response.status,headers:response.headers,body:await response.json()};};
  const html=await fetch(base+'/');assert.equal(html.status,200);assert.match(html.headers.get('content-type'),/text\/html/);const source=await html.text();assert.match(source,/MathInk/);
  const javascript=/src="([^"]+\.js)"/.exec(source)?.[1];assert.ok(javascript,'Built application module must exist');assert.equal((await fetch(new URL(javascript,base))).status,200);
  assert.equal((await fetch(base+'/ai-setup.html')).status,200);assert.equal((await fetch(base+'/.local/gateway.sqlite')).status,404);
  const state=await get('/v1/status');assert.equal(state.body.authMode,'hosted');assert.equal(state.body.provider,'deepseek');assert.equal(state.body.configured,false);assert.equal(state.body.pairingRequired,false);assert.equal(state.body.taskCapabilities['page-transcribe'],true);
  const pairing=await get('/v1/local-pairing');assert.equal(pairing.status,403);assert.equal(pairing.body.error.code,'LOCAL_PAIRING_NOT_ALLOWED');
  const unauthenticated=await get('/v1/usage?installationId=fake-installation');assert.equal(unauthenticated.status,401);
  const registerA=await post('/v1/auth/register',{username:'production-a',password:'production-password-a',invite:inviteA.invite});
  const registerB=await post('/v1/auth/register',{username:'production-b',password:'production-password-b',invite:inviteB.invite});
  assert.equal(registerA.status,200);assert.equal(registerB.status,200);assert.match(registerA.headers.get('cache-control'),/no-store/);
  const tokenA=registerA.body.sessionToken,tokenB=registerB.body.sessionToken;
  assert.ok(tokenA&&tokenB&&tokenA!==tokenB);assert.notEqual(registerA.body.user.id,registerB.body.user.id);
  assert.equal((await get('/v1/auth/me',tokenA)).body.user.username,'production-a');assert.equal((await get('/v1/auth/me',tokenB)).body.user.username,'production-b');
  const repeatInvite=await post('/v1/auth/register',{username:'production-c',password:'production-password-c',invite:inviteA.invite});assert.equal(repeatInvite.status,403);
  const login=await post('/v1/auth/login',{username:'production-a',password:'production-password-a'});assert.equal(login.status,200);assert.notEqual(login.body.sessionToken,tokenA);assert.equal((await get('/v1/auth/me',login.body.sessionToken)).body.user.id,registerA.body.user.id);

  // Seed a prior metadata-only task, as after an actual service restart. This does
  // not fake a provider result or run generation with fabricated credentials.
  const metadata=new QuotaStore(databasePath);const timestamp=Date.now();
  const taskId=randomUUID(),principalA=hash('user:'+registerA.body.user.id),requestKey=hash('production-metadata-task');
  const config=configFromEnv(env);
  try{
    metadata.reserve({requestKey,requestId:taskId,installationHash:principalA,fingerprint:hash('already-submitted-source'),now:timestamp,countQuota:true,budget:{principalHash:principalA,amountCny:.5,provider:'deepseek',model:'deepseek-flash',operation:'page-transcribe',deadlineMs:120000}},config);
    const time=new Date(timestamp).toISOString();metadata.createTask({taskId,type:'page-transcribe',provider:'deepseek',model:'deepseek-flash',status:'error',sourceRevision:1,contentRevision:1,createdAt:time,updatedAt:time,steps:[{id:'generate',status:'error'}]},requestKey,principalA);
    metadata.complete(requestKey,'error');metadata.settle(requestKey,undefined,{status:'unknown',currency:'CNY',amount:null,priceDate:'2026-10-24',reserved:.5});
  }finally{metadata.close();}
  const own=await get(`/v1/tasks/${taskId}`,tokenA);assert.equal(own.status,200);assert.equal(own.body.status,'result-unavailable');assert.equal(own.body.cost.status,'unknown');assert.equal(own.body.result,undefined);
  const other=await get(`/v1/tasks/${taskId}?installationId=spoofed-owner`,tokenB);assert.equal(other.status,404);assert.equal(other.body.error.code,'TASK_NOT_FOUND');
  const usageA=await get('/v1/usage?provider=deepseek&installationId=first-browser-id',tokenA);
  const renamed=await get('/v1/usage?provider=deepseek&installationId=another-browser-id',tokenA);
  assert.equal(usageA.body.quota.subject,'account');assert.equal(usageA.body.quota.installationDaily.used,1);assert.equal(usageA.body.quota.userMonthly.used,1);assert.equal(usageA.body.budget.userDaily.usedCny,.5);assert.deepEqual(renamed.body.quota,usageA.body.quota);
  const usageB=await get('/v1/usage?provider=deepseek&installationId=first-browser-id',tokenB);assert.equal(usageB.body.quota.installationDaily.used,0);assert.equal(usageB.body.budget.userDaily.usedCny,0);
  const noKey=await post('/v1/tasks',{clientRequestId:'production-no-key-task',installationId:'production-browser-id',provider:'deepseek',sourceRevision:0,type:'context-review',input:{noteId:'note-test',pageId:'page-test',contentRevision:0,blocks:[{id:'b1',version:0,kind:'paragraph',text:'仅用于未配置拦截测试。'}]}},tokenA);
  assert.equal(noKey.status,503);assert.equal(noKey.body.error.code,'PROVIDER_NOT_CONFIGURED');
  assert.equal((await get('/v1/usage?provider=deepseek',tokenA)).body.quota.installationDaily.used,1);

  // Exercise the built default library and real hosted login UI. Provider
  // credentials remain empty and every generation endpoint is counted.
  browser=await chromium.launch({channel:'msedge',headless:true,args:['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1']});
  const context=await browser.newContext({viewport:{width:1365,height:900}});
  const page=await context.newPage(),browserErrors=[];let generations=0;
  context.on('request',request=>{if(isGenerationRequest(request))generations++;});
  await context.route('**/*',route=>{
    const url=new URL(route.request().url());
    return ['http:','https:'].includes(url.protocol)&&!['127.0.0.1','localhost'].includes(url.hostname)?route.abort():route.continue();
  });
  page.on('pageerror',error=>browserErrors.push(error.message));
  await page.goto(base);await waitForLibrary(page);
  assert.equal(await page.locator('#library-empty').isVisible(),true);
  await page.locator('#library-settings').click();
  await page.locator('#recognition-settings > summary').click();
  await page.locator('#health-check').click();
  await page.locator('#hosted-login').waitFor({state:'visible'});
  await page.locator('#account-username').fill('production-a');
  await page.locator('#account-password').fill('production-password-a');
  await page.locator('#account-login').click();
  await page.waitForFunction(()=>document.getElementById('hosted-state')?.textContent?.includes('已登录 production-a'));
  const browserToken=await page.evaluate(base=>sessionStorage.getItem('mathink-session:'+base),base);
  assert.ok(browserToken);assert.equal(await page.locator('#account-password').inputValue(),'');
  await page.locator('#settings-close').click();
  const privateTitle='PRIVATE_BROWSER_NOTE_NOT_SERVER_METADATA';
  await createNotebook(page,privateTitle);await manualFormulaDraft(page,'\\lVert fg\\rVert_1\\le\\lVert f\\rVert_p\\lVert g\\rVert_q');
  await page.locator('#draft-detail-dialog').getByRole('button',{name:'关闭',exact:true}).click();
  await page.locator('#editor-more').click();
  const localBackupEvent=page.waitForEvent('download');
  await page.getByRole('button',{name:'导出此笔记完整备份',exact:true}).click();
  const localBackupText=await readFile(await(await localBackupEvent).path(),'utf8'),localBackup=JSON.parse(localBackupText);
  assert.equal(localBackup.schemaVersion,4);assert.equal(localBackup.notes.length,1);
  assert.equal(localBackup.notes[0].title,privateTitle);assert.equal(localBackup.notes[0].drafts.length,1);
  assert.equal(localBackup.notes[0].formulas.length,0,'Creating a manual draft must not insert formal content');
  for(const secret of [browserToken,'production-password-a',inviteA.invite])assert.equal(localBackupText.includes(secret),false,'Hosted credentials must not enter notebook backup');
  assert.equal(generations,0);assert.deepEqual(browserErrors,[]);
  await context.close();

  const backupPath=join(temporary,'private-metadata-backup.sqlite');
  const backupOutput=await run(['scripts/hosted-admin.mjs','backup',backupPath],env);assert.match(backupOutput,/Consistent metadata backup/);
  const backupBytes=await readFile(backupPath);
  for(const secret of [tokenA,tokenB,login.body.sessionToken,browserToken,inviteA.invite,inviteB.invite,'production-password-a','production-password-b',privateTitle])assert.equal(backupBytes.includes(Buffer.from(secret)),false,'Plaintext credential or local notebook entered metadata backup');
  const backupDb=new DatabaseSync(backupPath,{readOnly:true});
  try{assert.equal(backupDb.prepare('SELECT COUNT(*) AS n FROM auth_users').get().n,2);assert.equal(backupDb.prepare('SELECT COUNT(*) AS n FROM ai_tasks').get().n,1);assert.equal(backupDb.prepare('SELECT COUNT(*) AS n FROM ai_ledger').get().n,1);}finally{backupDb.close();}
  assert.equal((await post('/v1/auth/logout',{},tokenA)).status,200);assert.equal((await get('/v1/auth/me',tokenA)).status,401);assert.equal((await get('/v1/auth/me',tokenB)).status,200);
  const revoke=await run(['scripts/hosted-admin.mjs','revoke-all'],env);assert.match(revoke,/Revoked sessions:/);assert.equal((await get('/v1/auth/me',login.body.sessionToken)).status,401);assert.equal((await get('/v1/auth/me',tokenB)).status,401);
  // A restored snapshot can predate logout/revocation; invalidate its old sessions
  // before exposing it. Identity, quota and task metadata must still be retained.
  await run(['scripts/hosted-admin.mjs','revoke-all'],{...env,GATEWAY_DATABASE_PATH:backupPath});
  const restored=new HostedAuthStore(backupPath);
  try{assert.equal(restored.listUsers().length,2);for(const token of [tokenA,tokenB,login.body.sessionToken])assert.throws(()=>restored.authenticate('Bearer '+token),/会话无效/);}finally{restored.close();}
  assert.ok(!output.includes(tokenA)&&!output.includes(tokenB)&&!output.includes(inviteA.invite));
});
