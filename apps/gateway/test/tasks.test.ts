import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { configFromEnv } from '../src/config.ts';
import type { GatewayConfig } from '../src/config.ts';
import { authenticationSourceIp, createGateway } from '../src/gateway.ts';
import type { IncomingMessage } from 'node:http';
import { DeepSeekProvider } from '../src/ai-providers.ts';
import { HostedAuthStore } from '../src/hosted-auth.ts';
import { QuotaStore } from '../src/store.ts';
import { estimateCost, reserveAmount } from '../src/accounting.ts';
import { taskPrompt, validateTaskOutput, validateTaskRequest } from '../src/tasks.ts';
import { crc32 } from '../src/png.ts';
import type { RecognitionProvider, TaskRequest, TaskResponse } from '../src/types.ts';

function png(){const chunk=(name:string,data:Buffer)=>{const type=Buffer.from(name),size=Buffer.alloc(4),crc=Buffer.alloc(4);size.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([type,data])));return Buffer.concat([size,type,data,crc]);};const h=Buffer.alloc(13);h.writeUInt32BE(1);h.writeUInt32BE(1,4);h[8]=8;h[9]=6;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',h),chunk('IDAT',deflateSync(Buffer.from([0,0,0,0,255]))),chunk('IEND',Buffer.alloc(0))]).toString('base64');}
const page=():TaskRequest=>({clientRequestId:'page-request-0001',installationId:'installation-test-0001',sourceRevision:4,provider:'deepseek',type:'page-transcribe',input:{noteId:'note-one',pageId:'page-one',contentRevision:3,imageBase64:png()}});
const draft=()=>({blocks:[{id:'b1',kind:'paragraph',segments:[{type:'text',text:'设函数 '},{type:'math',latex:'f\\in L^p'}],bbox:{x:0,y:0,width:1,height:.2},uncertainties:[]},{id:'b2',kind:'formula',latex:'\\int x^2\\,dx',bbox:{x:0,y:.3,width:1,height:.2},uncertainties:['上标是否为 2']},{id:'b3',kind:'image-region',bbox:{x:0,y:.6,width:1,height:.3},uncertainties:['复杂图形保留原图']}],warnings:['图形需要手工处理']});
const blocks=()=>[{id:'block-one',version:2,kind:'paragraph',text:'设 x 为实数。'},{id:'block-two',version:3,kind:'formula',latex:'x^2=-1'}];
const context=():TaskRequest=>({...page(),type:'context-review',input:{noteId:'note-one',pageId:'page-one',contentRevision:3,blocks:blocks()}});
const suggestions=()=>({summary:'结论与条件矛盾，请核对原稿。',suggestions:[{id:'s1',type:'mathematics',blockId:'block-two',expectedVersion:3,before:'x^2=-1',after:'x^2\\ge 0',reason:'实数平方非负。',evidence:[{blockId:'block-one',version:2,quote:'实数'},{blockId:'block-two',version:3,quote:'x^2=-1'}]}]});
function provider(overrides:Partial<RecognitionProvider>={}):RecognitionProvider{return {name:'deepseek',simulated:false,configured:true,model:'fixture-model',async recognize(){return {latex:'x'};},async task(){return {result:draft() as any,usage:{inputTokens:20,outputTokens:10,cacheHitTokens:5,cacheMissTokens:15}};},...overrides};}
async function fixture(t:test.TestContext,options:{config?:Partial<GatewayConfig>;provider?:RecognitionProvider;directory?:string}={}){
  const directory=options.directory||mkdtempSync(join(tmpdir(),'mathink-tasks-'));
  const config={...configFromEnv({}),databasePath:join(directory,'metadata.sqlite'),provider:'deepseek' as const,port:0,...(options.config?.authMode==='hosted'?{priceConfig:{model:'fixture-model',date:'2026-10-24',currency:'CNY' as const,inputPerMillion:2,cachedInputPerMillion:1,outputPerMillion:4}}:{}),...options.config};
  const gateway=createGateway({config,providers:{deepseek:options.provider||provider()}});
  const server=createServer((req,res)=>void gateway.handle(req,res));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const close=async()=>{if(server.listening){await new Promise<void>(r=>server.close(()=>r()));gateway.close();}};
  t.after(async()=>{await close();if(!options.directory)rmSync(directory,{recursive:true,force:true});});
  const send=async(path:string,body:unknown,token='')=>{const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});return {status:response.status,body:await response.json() as any};};
  const get=async(path:string,token='')=>{const response=await fetch(base+path,{headers:token?{Authorization:`Bearer ${token}`}:{}});return {status:response.status,body:await response.json() as any};};
  const poll=async(id:string,token='')=>{for(let i=0;i<100;i++){const r=await get(`/v1/tasks/${id}?installationId=${page().installationId}`,token);if(!['pending','running'].includes(r.body.status))return r;await new Promise(r=>setTimeout(r,5));}throw new Error('task did not settle');};
  return {base,config,directory,gateway,close,send,get,poll};
}

test('page tasks return ordered mixed blocks, explicit uncertainty, usage and dated estimates without flattening LaTeX',async t=>{
  let calls=0;
  const app=await fixture(t,{config:{priceConfig:{model:'fixture-model',date:'2026-10-24',currency:'CNY',inputPerMillion:2,cachedInputPerMillion:1,outputPerMillion:4}},provider:provider({async task(){calls++;return {result:draft() as any,usage:{inputTokens:20,outputTokens:10,cacheHitTokens:5,cacheMissTokens:15}};}})});
  const created=await app.send('/v1/tasks',page());assert.equal(created.status,202);assert.equal(created.body.status,'pending');
  const done=await app.poll(created.body.taskId);assert.equal(done.body.status,'ok');assert.deepEqual(done.body.result,draft());assert.equal(done.body.usage.cacheHitTokens,5);assert.equal(done.body.cost.status,'estimated');assert.equal(done.body.cost.amount,.000075);
  const repeated=await app.send('/v1/tasks',page());assert.equal(repeated.body.taskId,created.body.taskId);assert.equal(calls,1);
  const changed={...page(),sourceRevision:5};assert.equal((await app.send('/v1/tasks',changed)).body.error.code,'IDEMPOTENCY_CONFLICT');
  const db=new DatabaseSync(app.config.databasePath);const metadata=JSON.stringify(db.prepare('SELECT * FROM ai_tasks').all())+JSON.stringify(db.prepare('SELECT * FROM ai_ledger').all());db.close();assert.ok(!metadata.includes('实数'));assert.ok(!metadata.includes('imageBase64'));assert.ok(!metadata.includes('\\int'));assert.ok(!metadata.includes(page().input.imageBase64!));
});

test('task capability table rejects local and mock extended tasks instead of uploading or falling back',async t=>{
  let calls=0;const app=await fixture(t,{provider:provider({async task(){calls++;return {result:draft() as any};}})});
  for(const name of ['ollama','mock','mathpix']){const result=await app.send('/v1/tasks',{...page(),provider:name});assert.equal(result.status,422);assert.equal(result.body.error.code,'PROVIDER_CAPABILITY_UNSUPPORTED');}
  assert.equal(calls,0);const status=await app.get('/v1/status?provider=ollama');assert.ok(Object.values(status.body.taskCapabilities).every(v=>v===false));
  const cloud=await app.get('/v1/status?provider=deepseek');assert.ok(Object.values(cloud.body.taskCapabilities).every(v=>v===true));
});

test('unknown usage retains reservation and blocks later calls at money limit; idempotent reads remain free',async t=>{
  let calls=0;const app=await fixture(t,{config:{userDailyBudgetCny:.5},provider:provider({async task(){calls++;return {result:draft() as any};}})});
  const created=await app.send('/v1/tasks',page());const done=await app.poll(created.body.taskId);assert.equal(done.body.usage.status,'unknown');assert.equal(done.body.cost.amount,null);assert.equal(done.body.cost.reserved,.5);
  assert.equal((await app.send('/v1/tasks',{...page(),clientRequestId:'page-request-0002'})).body.error.code,'BUDGET_EXCEEDED');
  assert.equal((await app.send('/v1/tasks',page())).body.taskId,created.body.taskId);assert.equal(calls,1);
  const usage=await app.get(`/v1/usage?provider=deepseek&installationId=${page().installationId}`);assert.equal(usage.body.budget.userDaily.usedCny,.5);assert.equal(usage.body.budget.userDaily.unknownRequests,1);
});

test('cancel and total timeout preserve an unknown paid task without automatic retries',async t=>{
  let calls=0;const app=await fixture(t,{config:{taskTimeoutMs:25},provider:provider({async task(){calls++;return await new Promise(()=>{});}})});
  const first=await app.send('/v1/tasks',page());const cancelled=await app.send(`/v1/tasks/${first.body.taskId}/cancel?installationId=${page().installationId}`,{});assert.equal(cancelled.status,200);
  const done=await app.poll(first.body.taskId);assert.equal(done.body.error.code,'TASK_CANCELLED');assert.equal(done.body.cost.status,'unknown');
  const second=await app.send('/v1/tasks',{...page(),clientRequestId:'page-timeout-0002'});const timed=await app.poll(second.body.taskId);assert.equal(timed.body.error.code,'TASK_TIMEOUT');assert.equal(timed.body.usage.status,'unknown');
  assert.equal((await app.send('/v1/tasks',page())).body.taskId,first.body.taskId);assert.equal(calls,2);
});

test('server restart exposes lost results and never resubmits a paid page from durable metadata',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mathink-restart-task-'));let calls=0;
  const fake=provider({async task(){calls++;return {result:draft() as any};}});
  const first=await fixture(t,{directory,provider:fake});const created=await first.send('/v1/tasks',page());await first.poll(created.body.taskId);await first.close();
  const second=await fixture(t,{directory,provider:fake});const lost=await second.get(`/v1/tasks/${created.body.taskId}?installationId=${page().installationId}`);assert.equal(lost.body.status,'result-unavailable');assert.equal(lost.body.error.code,'TASK_RESULT_UNAVAILABLE');
  assert.equal((await second.send('/v1/tasks',page())).body.status,'result-unavailable');assert.equal(calls,1);
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
});

test('hosted sessions isolate tasks and quota identity from spoofed installation IDs; revocation is enforced',async t=>{
  const app=await fixture(t,{config:{authMode:'hosted',installationDailyLimit:1}});
  const auth=new HostedAuthStore(app.config.databasePath);await auth.createUser('student-a','long-password-for-a');await auth.createUser('student-b','long-password-for-b');auth.close();
  const loginA=await app.send('/v1/auth/login',{username:'student-a',password:'long-password-for-a'});const a=loginA.body.sessionToken;
  const loginB=await app.send('/v1/auth/login',{username:'student-b',password:'long-password-for-b'});const b=loginB.body.sessionToken;
  assert.equal(loginA.status,200);assert.equal((await app.send('/v1/tasks',page())).status,401);
  const task=await app.send('/v1/tasks',page(),a);await app.poll(task.body.taskId,a);
  const lookup='/v1/tasks/by-request/'+page().clientRequestId+'?provider=deepseek';
  assert.equal((await app.get(lookup,a)).body.taskId,task.body.taskId);
  assert.equal((await app.get(lookup,b)).status,404);
  assert.equal((await app.get(`/v1/tasks/${task.body.taskId}`,b)).status,404);
  const bypass=await app.send('/v1/tasks',{...page(),clientRequestId:'other-request-0002',installationId:'spoofed-install-0002'},a);assert.equal(bypass.status,429);assert.equal(bypass.body.error.code,'INSTALLATION_QUOTA_EXCEEDED');
  const legacyBypass=await app.send('/v1/recognize',{clientRequestId:'legacy-bypass-0001',installationId:'another-spoofed-id',sourceRevision:4,provider:'deepseek',imageBase64:png()},a);assert.equal(legacyBypass.status,429);
  const taskB=await app.send('/v1/tasks',page(),b);assert.equal(taskB.status,202);assert.notEqual(taskB.body.taskId,task.body.taskId);await app.poll(taskB.body.taskId,b);
  assert.equal((await app.get('/v1/local-pairing')).status,403);
  const local=await app.send('/v1/recognize',{...page(),type:undefined,input:undefined,imageBase64:png(),provider:'ollama'},a);assert.equal(local.body.error.code,'HOSTED_PROVIDER_UNSUPPORTED');
  assert.equal((await app.send('/v1/auth/logout',{},a)).status,200);assert.equal((await app.get('/v1/auth/me',a)).status,401);assert.equal((await app.get('/v1/auth/me',b)).status,200);
});

test('hosted public login guard cannot be bypassed with rotating account names or forwarded headers',async t=>{
  const app=await fixture(t,{config:{authMode:'hosted'}});
  for(let i=0;i<20;i++){const response=await fetch(app.base+'/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json','X-Forwarded-For':`203.0.113.${i}`},body:JSON.stringify({username:`unknown-${i}`,password:'long-enough-invalid-password'})});assert.equal(response.status,401);}
  const blocked=await app.send('/v1/auth/login',{username:'another-account',password:'long-enough-invalid-password'});assert.equal(blocked.status,429);assert.equal(blocked.body.error.code,'AUTH_RATE_LIMITED');
});

test('only an explicitly trusted proxy can supply one client IP for independent authentication limits',async t=>{
  const app=await fixture(t,{config:{authMode:'hosted',trustedProxyIps:['::ffff:127.0.0.1']}});
  const login=async(ip:string,name:string)=>{
    const response=await fetch(app.base+'/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json','X-Forwarded-For':ip},body:JSON.stringify({username:name,password:'long-enough-invalid-password'})});
    return {status:response.status,body:await response.json() as any};
  };
  for(let i=0;i<20;i++)assert.equal((await login('198.51.100.10',`first-client-${i}`)).status,401);
  assert.equal((await login('198.51.100.10','first-client-over-limit')).body.error.code,'AUTH_RATE_LIMITED');
  // A second actual client behind this proxy has its own network bucket.
  assert.equal((await login('198.51.100.11','second-client-first')).status,401);
  for(let i=0;i<6;i++)assert.equal((await login(`203.0.113.${i}`,'same-persistent-account')).status,401);
  // Account failure accounting remains persistent even when a trusted proxy reports
  // different genuine network sources; source isolation cannot bypass this rule.
  assert.equal((await login('203.0.113.20','same-persistent-account')).body.error.code,'AUTH_RATE_LIMITED');
});

test('forwarded authentication source falls back on malformed chains and never trusts prefixes or unrelated headers',()=>{
  const request=(remote:string,forwarded:unknown)=>({socket:{remoteAddress:remote},headers:{'x-forwarded-for':forwarded,'x-real-ip':'203.0.113.99',forwarded:'for=203.0.113.98'}} as unknown as IncomingMessage);
  for(const remote of ['127.0.0.1','::ffff:127.0.0.1','0:0:0:0:0:ffff:7f00:1'])assert.equal(authenticationSourceIp(request(remote,'2001:0DB8:0::1'),['127.0.0.1']),'2001:db8::1');
  for(const value of ['198.51.100.1, 198.51.100.2','localhost','[::1]','198.51.100.999','192.168.1.3:8080','::1%eth0',undefined,['198.51.100.1','198.51.100.2']])assert.equal(authenticationSourceIp(request('127.0.0.1',value),['127.0.0.1']),'127.0.0.1');
  assert.equal(authenticationSourceIp(request('127.0.0.10','198.51.100.1'),['127.0.0.1']),'127.0.0.10');
  assert.equal(authenticationSourceIp(request('127.0.0.1','198.51.100.1'),[]),'127.0.0.1');
});

for(const mode of ['missing','mismatch'] as const)test(`hosted ${mode} pricing blocks tasks and legacy cloud calls before every reservation`,async t=>{
  let calls=0;
  const app=await fixture(t,{config:{authMode:'hosted',priceConfig:mode==='missing'?null:{model:'different-model',date:'2026-10-24',currency:'CNY',inputPerMillion:2,outputPerMillion:4}},provider:provider({async recognize(){calls++;return {latex:'x'};},async review(){calls++;return {summary:'done',issues:[],suggestedLatex:null};},async task(){calls++;return {result:draft() as any};}})});
  const auth=new HostedAuthStore(app.config.databasePath);await auth.createUser('pricing-test','long-password-for-pricing');auth.close();
  const login=await app.send('/v1/auth/login',{username:'pricing-test',password:'long-password-for-pricing'});const token=login.body.sessionToken;
  const task=await app.send('/v1/tasks',page(),token);assert.equal(task.status,503);assert.equal(task.body.error.code,'PRICING_REQUIRED');
  const recognized=await app.send('/v1/recognize',{clientRequestId:'unpriced-recognize-0001',installationId:'installation-pricing-test',sourceRevision:0,imageBase64:png(),provider:'deepseek'},token);assert.equal(recognized.status,503);assert.equal(recognized.body.error.code,'PRICING_REQUIRED');
  const reviewed=await app.send('/v1/review',{clientRequestId:'unpriced-review-0001',installationId:'installation-pricing-test',sourceRevision:0,latex:'x',provider:'deepseek'},token);assert.equal(reviewed.body.error.code,'PRICING_REQUIRED');
  assert.equal(calls,0);
  const db=new DatabaseSync(app.config.databasePath);for(const table of ['reservations','ai_ledger','ai_tasks'])assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {count:number}).count,0);db.close();
  const usage=await app.get('/v1/usage?provider=deepseek',token);assert.equal(usage.body.quota.installationDaily.used,0);assert.equal(usage.body.budget.userDaily.usedCny,0);
});

test('atomic ledger enforces per-user/global concurrency, frequency, day/month money and unknown holds across stores',()=>{
  const directory=mkdtempSync(join(tmpdir(),'mathink-budget-'));const path=join(directory,'metadata.sqlite');const a=new QuotaStore(path),b=new QuotaStore(path);const config={...configFromEnv({}),installationDailyLimit:100,globalDailyLimit:100,globalMonthlyLimit:100,userDailyBudgetCny:1,userMonthlyBudgetCny:1,globalDailyBudgetCny:1,globalMonthlyBudgetCny:1,userConcurrency:1,globalConcurrency:1,userRequestsPerMinute:2};
  const reserve=(store:QuotaStore,key:string,principal='one')=>store.reserve({requestKey:key,requestId:key,installationHash:principal,fingerprint:key,now:100000,countQuota:true,budget:{principalHash:principal,amountCny:.5,provider:'deepseek',model:'fixture',operation:'test',deadlineMs:1000}},config);
  try{reserve(a,'a');assert.throws(()=>reserve(b,'b'),/正在运行/);a.settle('a',undefined,{status:'unknown',currency:'CNY',amount:null,priceDate:null,reserved:.5});reserve(b,'b');b.settle('b',undefined,{status:'unknown',currency:'CNY',amount:null,priceDate:null,reserved:.5});assert.throws(()=>reserve(a,'c'),/调用频率/);assert.throws(()=>reserve(a,'other','two'),/费用预算/);assert.equal(a.budgetUsage('one',100000,config).userDaily.usedCny,1);}finally{a.close();b.close();rmSync(directory,{recursive:true,force:true});}
});

test('request/output schema preserves source versions, exact evidence and original conditions',()=>{
  const config=configFromEnv({});assert.deepEqual(validateTaskRequest(context(),config),context());assert.deepEqual(validateTaskOutput(suggestions(),context()),suggestions());
  for(const mutate of [(s:any)=>s.suggestions[0].expectedVersion++, (s:any)=>s.suggestions[0].before='invented original', (s:any)=>s.suggestions[0].evidence[0].quote='not in source',(s:any)=>s.suggestions[0].blockId='other-note']){const s=suggestions();mutate(s);assert.throws(()=>validateTaskOutput(s,context()),/结构或来源/);}
  assert.throws(()=>validateTaskRequest({...context(),input:{...context().input,imageBase64:png()}},config),/任务格式/);
  assert.throws(()=>validateTaskRequest({...context(),input:{...context().input,blocks:[{...blocks()[0],text:'字'.repeat(20000)}]}},config),/任务格式/);
  const p=draft();(p.blocks[0] as any).bbox.x=.9;assert.throws(()=>validateTaskOutput(p,page()),/结构或来源/);
});

test('organization retains every block and links require exact citations for both endpoints',()=>{
  const organize={...context(),type:'organize' as const};const result={title:'实数与平方',outline:blocks().map(b=>({blockId:b.id,level:1,category:'text'})),summary:'一组条件与结论。',newExplanations:[]};assert.deepEqual(validateTaskOutput(result,organize),result);assert.throws(()=>validateTaskOutput({...result,outline:result.outline.slice(1)},organize),/结构或来源/);
  const relation={...context(),type:'knowledge-links' as const,input:{...context().input,blocks:[blocks()[1]],candidates:[blocks()[0]]}};const link={links:[{fromBlockId:'block-two',toBlockId:'block-one',relation:'dependency',reason:'结论依赖实数条件。',evidence:[{blockId:'block-two',version:3,quote:'x^2'},{blockId:'block-one',version:2,quote:'实数'}]}]};assert.deepEqual(validateTaskOutput(link,relation),link);assert.throws(()=>validateTaskOutput({links:[{...link.links[0],evidence:link.links[0].evidence.slice(1)}]},relation),/结构或来源/);
});

test('proof assistance never claims verified and cannot silently replace assumptions or existing steps',()=>{
  const request={...context(),type:'proof-assist' as const,input:{...context().input,domain:'calculus' as const,goal:'求导数',assumptions:['x 为实数'],steps:['f(x)=x^2']}};const result={domain:'calculus',goal:'求导数',assumptions:['x 为实数'],existingSteps:['f(x)=x^2'],nextSteps:['按幂函数求导法则计算。'],unresolved:[],verification:'unverified'};assert.deepEqual(validateTaskOutput(result,request),result);assert.throws(()=>validateTaskOutput({...result,verification:'proved'},request),/结构或来源/);assert.throws(()=>validateTaskOutput({...result,assumptions:['x>0']},request),/结构或来源/);assert.throws(()=>validateTaskRequest({...request,input:{...request.input,domain:'topology'}},configFromEnv({})),/任务格式/);
});

test('DeepSeek task modes have distinct prompts, bounded output, no tools, and carry cache/reasoning tokens into reviews',async()=>{
  const bodies:any[]=[];let output:any=draft();const model=new DeepSeekProvider({apiKey:'fixture-secret',taskMaxOutputTokens:2048,fetcher:async(_url,init)=>{bodies.push(JSON.parse(init!.body as string));return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}],usage:{prompt_tokens:100,completion_tokens:50,prompt_cache_hit_tokens:30,prompt_cache_miss_tokens:70,completion_tokens_details:{reasoning_tokens:20}}}),{status:200});}});
  const pageResult=await model.task(page(),new AbortController().signal);assert.equal(pageResult.usage?.cacheHitTokens,30);assert.equal(bodies[0].thinking.type,'disabled');assert.equal(bodies[0].temperature,0);assert.equal(bodies[0].max_tokens,2048);assert.equal(bodies[0].tools,undefined);assert.ok(Array.isArray(bodies[0].messages[1].content));
  output=suggestions();await model.task(context(),new AbortController().signal);assert.equal(bodies[1].thinking.type,'enabled');assert.equal(bodies[1].temperature,undefined);assert.equal(bodies[1].reasoning_effort,'low');assert.equal(typeof bodies[1].messages[1].content,'string');
  output={summary:'需核对',issues:[],suggestedLatex:null};const reviewed=await model.review('x',undefined,new AbortController().signal);assert.equal(reviewed.usage?.reasoningTokens,20);
});

test('bad generated structures are rejected after charging once and cached without another paid attempt',async t=>{
  let calls=0;const app=await fixture(t,{provider:provider({async task(){calls++;return {result:{latex:'whole page'} as any,usage:{inputTokens:4,outputTokens:2}};}})});const created=await app.send('/v1/tasks',page());const done=await app.poll(created.body.taskId);assert.equal(done.body.error.code,'TASK_BAD_RESPONSE');assert.equal(done.body.result,undefined);assert.equal(done.body.usage.inputTokens,4);await app.send('/v1/tasks',page());assert.equal(calls,1);
});

test('dated pricing rejects invalid rates and keeps unknown usage/pricing explicitly unknown',()=>{
  assert.equal(configFromEnv({}).priceConfig,null);assert.throws(()=>configFromEnv({AI_PRICE_CONFIG:'{"date":"2026-02-30","model":"m","currency":"CNY","inputPerMillion":1,"outputPerMillion":2}'}),/价格 JSON/);
  const config=configFromEnv({AI_PRICE_CONFIG:'{"date":"2026-10-24","model":"m","currency":"CNY","inputPerMillion":2,"outputPerMillion":4}'});assert.equal(estimateCost(undefined,'m',config.priceConfig,.5).status,'unknown');assert.equal(estimateCost({inputTokens:10,outputTokens:5,cacheHitTokens:2},'m',config.priceConfig,.5).status,'unknown');assert.equal(estimateCost({inputTokens:10,outputTokens:5},'different',config.priceConfig,.5).status,'unknown');assert.equal(reserveAmount(config,'m',100,50),.0004);assert.throws(()=>reserveAmount({...config,taskMaxCostCny:.0001},'m',100,50),/单任务预算/);
});

test('explicit operator reconciliation releases unknown holds with an audit trail and keeps request counts',()=>{
  const store=new QuotaStore(':memory:');const config=configFromEnv({});
  try{
    store.reserve({requestKey:'billing-key',requestId:'bill-request-1',installationHash:'user',fingerprint:'fingerprint',now:1000,budget:{principalHash:'user',amountCny:.5,provider:'deepseek',model:'fixture',operation:'page-transcribe',deadlineMs:1000}},config);
    assert.throws(()=>store.reconcile('bill-request-1',0,1500),/仍可能正在执行/);
    store.settle('billing-key',undefined,{status:'unknown',currency:'CNY',amount:null,priceDate:null,reserved:.5});
    assert.equal(store.budgetUsage('user',2000,config).userDaily.usedCny,.5);
    const result=store.reconcile('bill-request-1',.12,2000);assert.equal(result.actualCny,.12);assert.equal(store.budgetUsage('user',2000,config).userDaily.usedCny,.12);assert.equal(store.budgetUsage('user',2000,config).userDaily.requests,1);
    assert.equal(store.ledgerEntries()[0].state,'reconciled');assert.equal(store.ledgerEntries()[0].settledCny,.12);
    assert.deepEqual(store.reconcile('bill-request-1',.12,3000),result);assert.equal(store.ledgerEntries()[0].reconciliationCount,1);
    store.settle('billing-key',undefined,{status:'unknown',currency:'CNY',amount:null,priceDate:null,reserved:.5});assert.equal(store.ledgerEntries()[0].settledCny,.12);
    store.reconcile('bill-request-1',0,4000);assert.equal(store.budgetUsage('user',4000,config).userDaily.usedCny,0);assert.equal(store.ledgerEntries()[0].reconciliationCount,2);assert.equal(store.budgetUsage('user',4000,config).userDaily.requests,1);
    assert.throws(()=>store.reconcile('bill-request-1',-1),/实际金额/);
    assert.throws(()=>store.reconcile('bill-request-1',Infinity),/实际金额/);assert.throws(()=>store.reconcile('missing',0),/未找到/);
  }finally{store.close();}
});
