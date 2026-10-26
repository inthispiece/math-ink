import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DraftTaskManager } from '../src/draft-tasks.ts';
import { newNote } from '../src/model.ts';
import { ensureNotebook, createDraft, type Notebook, type NotebookTask } from '../src/notebook-domain.ts';
import { createSourceRef } from '../src/page-model.ts';
import type { Connection, ConnectionVault } from '../src/connection-vault.ts';

const deferred = <T>() => { let resolve!: (value:T)=>void; const promise=new Promise<T>(r=>resolve=r); return {promise,resolve}; };
const response=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
const ok=(patch:Record<string,unknown>={})=>({taskId:'remote-original',provider:'deepseek',sourceRevision:7,status:'ok',result:{provider:'deepseek',simulated:false,latex:'\\int x^2\\,dx',uncertainSymbols:[]},...patch});

function fixture(t:TestContext,options:{knownId?:boolean;token?:()=>Promise<string|null>}={}) {
  const globals=globalThis as unknown as {window?:Window},oldWindow=globals.window,oldFetch=globalThis.fetch;
  globals.window=new EventTarget() as unknown as Window;
  t.after(()=>{globalThis.fetch=oldFetch;if(oldWindow)globals.window=oldWindow;else Reflect.deleteProperty(globals,'window');});
  let stored=ensureNotebook(newNote()); const page=stored.pages[0],source=createSourceRef(stored,page.id,{x:0,y:0,width:100,height:60},['original-ink']);
  const at=new Date().toISOString(); const task:NotebookTask={kind:'formula',clientRequestId:'original-request',...(options.knownId===false?{}:{remoteId:'remote-original'}),provider:'deepseek',gateway:'https://fixture.invalid',installationId:'installation-fixture',principal:'local:fixture',phase:'running',sourceRevision:7,createdAt:at,updatedAt:at,request:{}};
  const draft=createDraft(stored,{type:'formula',sourcePageId:page.id,source,sourceRevision:3,status:'running',task});
  const completed:Notebook[]=[],notices:string[]=[],calls:{url:string;method:string;signal:AbortSignal|null|undefined}[]=[];
  let beforeUpdate:((latest:Notebook)=>void)|undefined,beforeRead:(()=>void)|undefined;
  const repository={
    async getNote(id:string){beforeRead?.();return id===stored.id?structuredClone(stored):null;},
    async updateNote(id:string,change:(latest:Notebook)=>unknown){if(id!==stored.id)return null;const latest=structuredClone(stored);beforeUpdate?.(latest);change(latest);latest.storageRevision++;stored=latest;return structuredClone(stored);},
  };
  let request:(url:string,init:RequestInit)=>Promise<Response>=async()=>{throw new Error('Unexpected fixture request; real networking is forbidden');};
  globalThis.fetch=async(input,init={})=>{const url=String(input);calls.push({url,method:init.method||'GET',signal:init.signal});return request(url,init);};
  const vault={tokenFor:options.token||(async()=> 'fixture-token')} as unknown as ConnectionVault;
  const manager=new DraftTaskManager({vault,saved:(note,_id,done)=>{if(done)completed.push(note);},notify:message=>notices.push(message)},repository);
  return {manager,noteId:stored.id,draftId:draft.id,source,page,completed,notices,calls,
    note:()=>structuredClone(stored),draft:()=>structuredClone(stored.drafts.find(d=>d.id===draft.id)!),
    mutate:(change:(note:Notebook)=>void)=>change(stored),request:(fn:typeof request)=>request=fn,
    beforeUpdate:(fn:typeof beforeUpdate)=>beforeUpdate=fn,beforeRead:(fn:typeof beforeRead)=>beforeRead=fn,
  };
}

test('known task GET accepts only its original remote identity, provider and exact source revision without generating again',async t=>{
  for(const [label,patch] of Object.entries({identity:{taskId:'another-remote'},provider:{provider:'ollama'},revision:{sourceRevision:8},missingRevision:{sourceRevision:undefined}})) {
    await t.test(label,async t=>{const f=fixture(t);f.request(async()=>response(ok(patch)));await f.manager.query(f.noteId,f.draftId);assert.equal(f.draft().status,'unknown');assert.equal(f.draft().latex,undefined);assert.equal(f.draft().task!.remoteId,'remote-original');assert.equal(f.draft().task!.sourceRevision,7);assert.equal(f.completed.length,0);assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'GET');});
  }
  await t.test('valid response uses task source revision rather than the page-local revision',async t=>{const f=fixture(t);f.request(async()=>response(ok()));await f.manager.query(f.noteId,f.draftId);assert.equal(f.draft().status,'completed');assert.equal(f.draft().latex,'\\int x^2\\,dx');assert.equal(f.completed.length,1);assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'GET');});
});

test('by-request recovery pins a remote ID only after revision validation and never POSTs on a mismatch',async t=>{
  for(const valid of [false,true])await t.test(valid?'matching lookup':'wrong revision lookup',async t=>{const f=fixture(t,{knownId:false});f.request(async()=>response(ok({sourceRevision:valid?7:9})));await f.manager.query(f.noteId,f.draftId);assert.match(f.calls[0].url,/by-request\/original-request\?/);assert.equal(f.calls[0].method,'GET');assert.equal(f.calls.length,1);assert.equal(f.draft().task!.remoteId,valid?'remote-original':undefined);assert.equal(f.draft().status,valid?'completed':'unknown');assert.equal(f.completed.length,valid?1:0);});
});

test('receive rechecks persisted remote identity after GET and refuses a reply whose binding changed during the request',async t=>{
  const f=fixture(t);let reads=0;f.beforeRead(()=>{if(++reads===2)f.mutate(n=>n.drafts[0].task!.remoteId='remote-rebound');});f.request(async()=>response(ok()));
  await f.manager.query(f.noteId,f.draftId);assert.equal(f.draft().status,'unknown');assert.equal(f.draft().task!.remoteId,'remote-rebound');assert.equal(f.draft().latex,undefined);assert.equal(f.completed.length,0);assert.equal(f.calls.length,1);
});

test('cancellation is durably saved before aborting the response or asking the remote service and a late reply stays ignored',async t=>{
  const f=fixture(t),entered=deferred<void>(),late=deferred<Response>(),cancelEntered=deferred<void>(),cancelReply=deferred<Response>();let stateAtAbort='';
  f.request(async(url,init)=>{if(url.includes('/cancel')){assert.equal(f.draft().status,'cancelled');cancelEntered.resolve();return cancelReply.promise;}init.signal!.addEventListener('abort',()=>stateAtAbort=f.draft().status);entered.resolve();return late.promise;});
  const querying=f.manager.query(f.noteId,f.draftId);await entered.promise;const cancelling=f.manager.cancel(f.noteId,f.draftId);await cancelEntered.promise;
  assert.equal(stateAtAbort,'cancelled');assert.equal(f.draft().task!.phase,'cancelled');assert.equal(f.draft().latex,undefined);
  late.resolve(response(ok()));await querying;cancelReply.resolve(response({status:'error'}));await cancelling;
  assert.equal(f.draft().status,'cancelled');assert.equal(f.draft().latex,undefined);assert.equal(f.completed.length,0);assert.equal(f.calls.filter(c=>c.method==='GET').length,1);assert.equal(f.calls.filter(c=>c.method==='POST'&&c.url.includes('/cancel')).length,1);assert.equal(f.notices.some(n=>n.includes('已存入草稿箱')),false);
});

test('an atomic cancellation committed after result preparation prevents the final transaction from adopting it',async t=>{
  const f=fixture(t);f.request(async()=>response(ok()));f.beforeUpdate(latest=>{latest.drafts[0].status='cancelled';latest.drafts[0].task!.phase='cancelled';});
  await f.manager.query(f.noteId,f.draftId);assert.equal(f.draft().status,'cancelled');assert.equal(f.draft().latex,undefined);assert.equal(f.draft().result,undefined);assert.equal(f.completed.length,0);assert.equal(f.manager.hasUnsaved(f.noteId,f.draftId),false);
});

test('failed cancellation storage does not abort or POST and leaves the pending result recoverable',async t=>{
  const f=fixture(t),entered=deferred<void>(),late=deferred<Response>();let signal:AbortSignal|null|undefined;
  f.request(async(_url,init)=>{signal=init.signal;entered.resolve();return late.promise;});const querying=f.manager.query(f.noteId,f.draftId);await entered.promise;
  f.beforeUpdate(()=>{throw new Error('fixture quota exhausted');});await assert.rejects(f.manager.cancel(f.noteId,f.draftId),/quota exhausted/);assert.equal(signal!.aborted,false);assert.equal(f.draft().status,'running');assert.equal(f.calls.length,1);
  f.beforeUpdate(undefined);late.resolve(response(ok()));await querying;assert.equal(f.draft().status,'completed');assert.equal(f.completed.length,1);
});

test('cancelling a saved pending submission while its credential resolves prevents the first generation POST',async t=>{
  const token=deferred<string|null>(),entered=deferred<void>(),f=fixture(t,{token:async()=>{entered.resolve();return token.promise;}});
  const connection={gateway:'https://fixture.invalid',provider:'deepseek',installationId:'installation-fixture',principal:'local:fixture',token:'fixture-token',status:{provider:'deepseek',configured:true,simulated:false}} as Connection;
  const id=await f.manager.start({noteId:f.noteId,kind:'formula',title:'not yet sent',connection,source:f.source,sourcePageId:f.page.id,sourceRevision:0});await entered.promise;
  await f.manager.cancel(f.noteId,id);token.resolve('fixture-token');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.note().drafts.find(d=>d.id===id)!.status,'cancelled');assert.equal(f.calls.length,0);assert.equal(f.completed.length,0);
});

test('cancel removes an unsaved received result so retry-save cannot later overwrite the cancelled draft',async t=>{
  const f=fixture(t);f.request(async()=>response(ok()));f.beforeUpdate(()=>{throw new Error('fixture storage full');});await f.manager.query(f.noteId,f.draftId);assert.equal(f.manager.hasUnsaved(f.noteId,f.draftId),true);
  f.beforeUpdate(undefined);f.request(async(url)=>{assert.match(url,/\/cancel\?/);return response({status:'error'});});await f.manager.cancel(f.noteId,f.draftId);await f.manager.retrySaving(f.noteId,f.draftId);
  assert.equal(f.draft().status,'cancelled');assert.equal(f.draft().latex,undefined);assert.equal(f.manager.hasUnsaved(f.noteId,f.draftId),false);assert.equal(f.completed.length,0);assert.equal(f.calls.length,2);
});
