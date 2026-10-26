import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { deflateSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { configFromEnv } from '../src/config.ts';
import type { GatewayConfig } from '../src/config.ts';
import { createGateway } from '../src/gateway.ts';
import { HostedAuthStore } from '../src/hosted-auth.ts';
import { crc32 } from '../src/png.ts';
import type { ProviderName, RecognitionProvider } from '../src/types.ts';

function png(pixel=0):string {
  const chunk=(name:string,data:Buffer)=>{const type=Buffer.from(name),size=Buffer.alloc(4),crc=Buffer.alloc(4);size.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([type,data])));return Buffer.concat([size,type,data,crc]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(1);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,pixel,pixel,pixel,255]))),chunk('IEND',Buffer.alloc(0))]).toString('base64');
}
const input=(clientRequestId='selection-request-0001')=>({clientRequestId,installationId:'selection-installation-0001',provider:'deepseek',sourceRevision:7,imageBase64:png()});
const provider=(overrides:Partial<RecognitionProvider>={}):RecognitionProvider=>({name:'deepseek',configured:true,simulated:false,model:'fixture-model',async recognize(){return {latex:'PRIVATE_LATEX_SOURCE',reviewRequired:true,uncertainSymbols:['2'],usage:{inputTokens:20,outputTokens:10}};},...overrides});

async function fixture(t:test.TestContext,options:{config?:Partial<GatewayConfig>;providers?:Partial<Record<ProviderName,RecognitionProvider>>;now?:()=>number}={}){
  const directory=mkdtempSync(join(tmpdir(),'mathink-selection-tasks-'));
  const config={...configFromEnv({}),provider:'deepseek' as const,databasePath:join(directory,'metadata.sqlite'),port:0,
    ...(options.config?.authMode==='hosted'?{priceConfig:{model:'fixture-model',date:'2026-10-27',currency:'CNY' as const,inputPerMillion:2,outputPerMillion:4}}:{}),...options.config};
  const providers={deepseek:provider(),...options.providers};
  let gateway=createGateway({config,providers,now:options.now});
  const server=createServer((req,res)=>void gateway.handle(req,res));
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
  t.after(async()=>{gateway.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&target.includes('mathink-selection-tasks-'));rmSync(target,{recursive:true,force:true});});
  const send=async(path:string,body:unknown,token='')=>{const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});return {status:response.status,body:await response.json() as any};};
  const get=async(path:string,token='')=>{const response=await fetch(base+path,{headers:token?{Authorization:'Bearer '+token}:{}});return {status:response.status,body:await response.json() as any};};
  const query=(taskId:string,token='')=>get('/v1/recognitions/'+taskId+'?installationId='+input().installationId,token);
  const lookup=(clientRequestId:string,token='',name='deepseek')=>get('/v1/recognitions/by-request/'+encodeURIComponent(clientRequestId)+'?provider='+name+'&installationId='+input().installationId,token);
  const poll=async(taskId:string,token='')=>{for(let i=0;i<100;i++){const result=await query(taskId,token);if(!['pending','running'].includes(result.body.status))return result;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Selection task did not settle');};
  return {config,base,send,get,query,lookup,poll,restart(){gateway.close();gateway=createGateway({config,providers,now:options.now});}};
}

test('queryable selection returns before generation finishes and shares one invocation and bill with legacy API',async t=>{
  let calls=0,release!:()=>void;
  const app=await fixture(t,{providers:{deepseek:provider({async recognize(){calls++;await new Promise<void>(resolve=>release=resolve);return {latex:'\\int x^2\\,dx',reviewRequired:true,usage:{inputTokens:20,outputTokens:10}};}})}});
  const created=await app.send('/v1/recognitions',input());
  assert.equal(created.status,202);assert.equal(created.body.type,'formula-transcribe');assert.equal(created.body.status,'running');
  assert.equal((await app.query(created.body.taskId)).body.status,'running');
  assert.equal((await app.lookup(input().clientRequestId)).body.taskId,created.body.taskId);
  const duplicate=await app.send('/v1/recognitions',input());assert.equal(duplicate.body.taskId,created.body.taskId);
  assert.equal((await app.send('/v1/recognitions',{...input(),sourceRevision:8})).body.error.code,'IDEMPOTENCY_CONFLICT');
  assert.equal((await app.send('/v1/recognitions',{...input(),imageBase64:png(1)})).status,409);
  const legacy=app.send('/v1/recognize',input());release();
  const done=await app.poll(created.body.taskId),sync=await legacy;
  assert.equal(done.body.status,'ok');assert.equal(sync.status,200);assert.deepEqual(done.body.result,sync.body);assert.equal(done.body.result.latex,'\\int x^2\\,dx');assert.equal(calls,1);
  assert.equal((await app.send('/v1/recognitions',input())).body.status,'ok');
  const db=new DatabaseSync(app.config.databasePath);
  try{assert.equal((db.prepare('SELECT COUNT(*) AS n FROM reservations').get() as any).n,1);assert.equal((db.prepare('SELECT COUNT(*) AS n FROM ai_ledger').get() as any).n,1);assert.equal((db.prepare('SELECT COUNT(*) AS n FROM recognition_tasks').get() as any).n,1);}finally{db.close();}
});

test('original request lookup recovers synchronous results and never exposes another installation',async t=>{
  const app=await fixture(t);
  const sync=await app.send('/v1/recognize',input());assert.equal(sync.status,200);
  const found=await app.lookup(input().clientRequestId);assert.equal(found.body.taskId,sync.body.requestId);assert.deepEqual(found.body.result,sync.body);
  for(const path of ['/v1/recognitions/'+sync.body.requestId+'?installationId=another-installation','/v1/recognitions/by-request/'+input().clientRequestId+'?provider=deepseek&installationId=another-installation']){
    assert.equal((await app.get(path)).status,404);
  }
  assert.equal((await app.lookup(input().clientRequestId,'','mathpix')).status,404);
  assert.equal((await app.get('/v1/recognitions/by-request/'+input().clientRequestId+'?installationId='+input().installationId)).status,400);
  assert.equal((await app.get('/v1/recognitions/'+sync.body.requestId)).status,400);
  assert.equal((await app.send('/v1/recognitions/'+sync.body.requestId+'?installationId='+input().installationId,{})).status,405);
  const status=await app.get('/v1/status');assert.equal(status.body.protocolCapabilities.recognitionTasks,true);assert.equal(status.body.protocolCapabilities.recognitionLookup,true);
});

test('cache expiry and server restart retain paid metadata without ever regenerating selection content',async t=>{
  let calls=0,now=Date.now();
  const app=await fixture(t,{now:()=>now,config:{resultTtlMs:20},providers:{deepseek:provider({async recognize(){calls++;return {latex:'PRIVATE_LATEX_SOURCE',usage:{inputTokens:5,outputTokens:3}};}})}});
  const created=await app.send('/v1/recognitions',input());await app.poll(created.body.taskId);
  now+=100;
  const expired=await app.query(created.body.taskId);assert.equal(expired.body.status,'result-unavailable');assert.equal(expired.body.error.retryable,false);assert.equal(expired.body.cost.status,'unknown');
  assert.equal((await app.send('/v1/recognitions',input())).body.status,'result-unavailable');assert.equal(calls,1);
  const second=await app.send('/v1/recognitions',input('selection-request-0002'));await app.poll(second.body.taskId);app.restart();
  assert.equal((await app.lookup('selection-request-0002')).body.status,'result-unavailable');
  assert.equal((await app.query(second.body.taskId)).body.status,'result-unavailable');
  assert.equal((await app.send('/v1/recognitions',input('selection-request-0002'))).body.status,'result-unavailable');
  assert.equal((await app.send('/v1/recognize',input('selection-request-0002'))).body.error.code,'REQUEST_RESULT_UNAVAILABLE');assert.equal(calls,2);
  const db=new DatabaseSync(app.config.databasePath);
  try{const metadata=JSON.stringify(db.prepare('SELECT * FROM recognition_tasks').all())+JSON.stringify(db.prepare('SELECT * FROM reservations').all())+JSON.stringify(db.prepare('SELECT * FROM ai_ledger').all());assert.ok(!metadata.includes('PRIVATE_LATEX_SOURCE'));assert.ok(!metadata.includes('imageBase64'));assert.ok(!metadata.includes(input().imageBase64));assert.equal((db.prepare('SELECT COUNT(*) AS n FROM reservations').get() as any).n,2);}finally{db.close();}
});

test('explicit cancellation and timeout keep unknown money reserved and late supplier completion cannot replace cancellation',async t=>{
  let calls=0,release!:(value:any)=>void;
  const app=await fixture(t,{config:{userDailyBudgetCny:.5},providers:{deepseek:provider({async recognize(){calls++;return new Promise(resolve=>release=resolve);}})}});
  const created=await app.send('/v1/recognitions',input());
  const cancelled=await app.send('/v1/recognitions/'+created.body.taskId+'/cancel?installationId='+input().installationId,{});
  assert.equal(cancelled.status,200);assert.equal(cancelled.body.status,'error');assert.equal(cancelled.body.error.code,'RECOGNITION_CANCELLED');assert.equal(cancelled.body.cost.status,'unknown');assert.equal(cancelled.body.cost.reserved,.5);
  release({latex:'late overwrite'});await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal((await app.query(created.body.taskId)).body.error.code,'RECOGNITION_CANCELLED');
  assert.equal((await app.send('/v1/recognitions',input())).body.taskId,created.body.taskId);
  assert.equal((await app.send('/v1/recognitions',input('another-selection-request'))).body.error.code,'BUDGET_EXCEEDED');assert.equal(calls,1);
  const timed=await fixture(t,{providers:{deepseek:provider({timeoutMs:15,recognize(){return new Promise(()=>{});}})}});
  const task=await timed.send('/v1/recognitions',input());const done=await timed.poll(task.body.taskId);assert.equal(done.body.error.code,'PROVIDER_TIMEOUT');assert.equal(done.body.usage.status,'unknown');
});

test('shutdown during selection leaves an unavailable original task instead of starting another provider request',async t=>{
  let calls=0;
  const app=await fixture(t,{providers:{deepseek:provider({async recognize(){calls++;return new Promise(()=>{});}})}});
  const created=await app.send('/v1/recognitions',input());app.restart();
  const found=await app.query(created.body.taskId);assert.equal(found.body.status,'result-unavailable');assert.equal(found.body.cost.status,'unknown');
  assert.equal((await app.lookup(input().clientRequestId)).body.taskId,created.body.taskId);
  assert.equal((await app.send('/v1/recognitions',input())).body.status,'result-unavailable');assert.equal(calls,1);
});

test('hosted accounts own recognition tasks across installation changes and cannot read or cancel another account',async t=>{
  let calls=0;
  const app=await fixture(t,{config:{authMode:'hosted',installationDailyLimit:1},providers:{deepseek:provider({async recognize(){calls++;return {latex:'x',usage:{inputTokens:20,outputTokens:10}};}})}});
  const auth=new HostedAuthStore(app.config.databasePath);await auth.createUser('student-one','test-password-for-one');await auth.createUser('student-two','test-password-for-two');auth.close();
  const one=(await app.send('/v1/auth/login',{username:'student-one',password:'test-password-for-one'})).body.sessionToken;
  const two=(await app.send('/v1/auth/login',{username:'student-two',password:'test-password-for-two'})).body.sessionToken;
  assert.equal((await app.send('/v1/recognitions',input())).status,401);
  const first=await app.send('/v1/recognitions',input(),one);assert.equal(first.status,202);await app.poll(first.body.taskId,one);
  assert.equal((await app.send('/v1/recognitions',{...input(),installationId:'different-device-id'},one)).body.taskId,first.body.taskId);
  assert.equal((await app.lookup(input().clientRequestId,one)).body.taskId,first.body.taskId);
  assert.equal((await app.query(first.body.taskId,two)).status,404);
  assert.equal((await app.lookup(input().clientRequestId,two)).status,404);
  assert.equal((await app.send('/v1/recognitions/'+first.body.taskId+'/cancel?installationId='+input().installationId,{},two)).status,404);
  const second=await app.send('/v1/recognitions',input(),two);assert.equal(second.status,202);assert.notEqual(second.body.taskId,first.body.taskId);await app.poll(second.body.taskId,two);assert.equal(calls,2);
  assert.equal((await app.send('/v1/recognitions',{...input('quota-bypass-request'),installationId:'spoofed-device-0003'},one)).status,429);
  await app.send('/v1/auth/logout',{},one);assert.equal((await app.query(first.body.taskId,one)).status,401);
});

test('local Qwen selection tasks stay free and validation or missing credentials never reserve a call',async t=>{
  let calls=0;
  const app=await fixture(t,{config:{installationDailyLimit:0,userDailyBudgetCny:0},providers:{ollama:provider({name:'ollama',local:true,async recognize(){calls++;return {latex:'x'};}})}});
  for(let i=0;i<3;i++){const created=await app.send('/v1/recognitions',{...input('local-selection-'+i),provider:'ollama'});assert.equal(created.status,202);assert.equal((await app.poll(created.body.taskId)).body.status,'ok');}
  assert.equal(calls,3);
  assert.equal((await app.send('/v1/recognitions',{...input(),imageBase64:'invalid'})).status,400);
  const db=new DatabaseSync(app.config.databasePath);try{assert.equal((db.prepare('SELECT SUM(quota_counted) AS n FROM reservations').get() as any).n,0);assert.equal((db.prepare('SELECT COUNT(*) AS n FROM ai_ledger').get() as any).n,0);}finally{db.close();}
  const missing=await fixture(t,{providers:{deepseek:provider({configured:false})}});assert.equal((await missing.send('/v1/recognitions',input())).status,503);
  const empty=new DatabaseSync(missing.config.databasePath);try{assert.equal((empty.prepare('SELECT COUNT(*) AS n FROM reservations').get() as any).n,0);}finally{empty.close();}
});

test('page task request lookup shares original identity and remains query-only after restart',async t=>{
  let calls=0;
  const app=await fixture(t,{providers:{deepseek:provider({async task(){calls++;return {result:{blocks:[{id:'block-one',kind:'formula',latex:'x^2',bbox:{x:0,y:0,width:1,height:1},uncertainties:[]}],warnings:[]}};}})}});
  const request={clientRequestId:'page-lookup-request-0001',installationId:input().installationId,provider:'deepseek',sourceRevision:1,type:'page-transcribe',input:{noteId:'note-one',pageId:'page-one',contentRevision:0,imageBase64:png()}};
  const created=await app.send('/v1/tasks',request);assert.equal(created.status,202);
  const path='/v1/tasks/by-request/'+request.clientRequestId+'?provider=deepseek&installationId='+input().installationId;
  let found=await app.get(path);for(let i=0;i<100&&['pending','running'].includes(found.body.status);i++){await new Promise(resolve=>setTimeout(resolve,5));found=await app.get(path);}
  assert.equal(found.body.taskId,created.body.taskId);assert.equal(found.body.status,'ok');
  assert.equal((await app.get(path.replace(input().installationId,'different-installation'))).status,404);
  assert.equal((await app.get(path.replace('provider=deepseek','provider=mathpix'))).status,404);
  app.restart();assert.equal((await app.get(path)).body.status,'result-unavailable');
  assert.equal((await app.get('/v1/tasks/by-request/unknown-request-0001?provider=deepseek&installationId='+input().installationId)).status,404);assert.equal(calls,1);
});
