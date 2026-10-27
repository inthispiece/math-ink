import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DraftTaskManager } from '../src/draft-tasks.ts';
import { newNote,createBackup } from '../src/model.ts';
import { ensureNotebook, createDraft,addPage,addSnapshot, type Notebook, type NotebookTask } from '../src/notebook-domain.ts';
import { createSourceRef } from '../src/page-model.ts';
import type { Connection, ConnectionVault } from '../src/connection-vault.ts';
import {manuscriptDigest} from '../src/source-copy.ts';

const deferred = <T>() => { let resolve!: (value:T)=>void; const promise=new Promise<T>(r=>resolve=r); return {promise,resolve}; };
const response=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
const ok=(patch:Record<string,unknown>={})=>({taskId:'remote-original',provider:'deepseek',sourceRevision:7,status:'ok',result:{provider:'deepseek',simulated:false,latex:'\\int x^2\\,dx',uncertainSymbols:[]},...patch});

function fixture(t:TestContext,options:{knownId?:boolean;token?:()=>Promise<string|null>;validateStore?:boolean;throwUI?:boolean}={}) {
  const globals=globalThis as unknown as {window?:Window},oldWindow=globals.window,oldFetch=globalThis.fetch;
  globals.window=new EventTarget() as unknown as Window;
  t.after(()=>{globalThis.fetch=oldFetch;if(oldWindow)globals.window=oldWindow;else Reflect.deleteProperty(globals,'window');});
  let stored=ensureNotebook(newNote()); const page=stored.pages[0],source=createSourceRef(stored,page.id,{x:0,y:0,width:100,height:60},['original-ink']);
  const at=new Date().toISOString(); const task:NotebookTask={kind:'formula',clientRequestId:'original-request',...(options.knownId===false?{}:{remoteId:'remote-original'}),provider:'deepseek',gateway:'https://fixture.invalid',installationId:'installation-fixture',principal:'local:fixture',phase:'running',sourceRevision:7,createdAt:at,updatedAt:at,request:{}};
  const draft=createDraft(stored,{type:'formula',sourcePageId:page.id,source,sourceRevision:3,status:'running',task});
  const completed:Notebook[]=[],notices:string[]=[],calls:{url:string;method:string;signal:AbortSignal|null|undefined}[]=[],states:string[]=[],extraNotes:Notebook[]=[];
  let beforeUpdate:((latest:Notebook)=>void)|undefined,beforeRead:(()=>void)|undefined;
  const repository={
    async loadNotes(){return structuredClone([stored,...extraNotes]);},
    async getNote(id:string){beforeRead?.();return id===stored.id?structuredClone(stored):null;},
    async updateNote(id:string,change:(latest:Notebook)=>unknown){if(id!==stored.id)return null;const latest=structuredClone(stored);beforeUpdate?.(latest);change(latest);latest.storageRevision++;if(options.validateStore)createBackup([latest]);stored=latest;return structuredClone(stored);},
  };
  let request:(url:string,init:RequestInit)=>Promise<Response>=async()=>{throw new Error('Unexpected fixture request; real networking is forbidden');};
  globalThis.fetch=async(input,init={})=>{const url=String(input);calls.push({url,method:init.method||'GET',signal:init.signal});return request(url,init);};
  const vault={tokenFor:options.token||(async()=> 'fixture-token')} as unknown as ConnectionVault;
  const manager=new DraftTaskManager({vault,saved:(note,_id,done)=>{if(done)completed.push(note);if(options.throwUI)throw new Error('fixture UI refresh failed');},notify:message=>{notices.push(message);if(options.throwUI)throw new Error('fixture notification failed');},stateChanged:(noteId,draftId)=>{states.push(manager.resultState(noteId,draftId)?.phase||'cleared');if(options.throwUI)throw new Error('fixture state UI failed');}},repository);
  return {manager,noteId:stored.id,draftId:draft.id,source,page,completed,notices,calls,
    note:()=>structuredClone(stored),draft:()=>structuredClone(stored.drafts.find(d=>d.id===draft.id)!),
    mutate:(change:(note:Notebook)=>void)=>change(stored),request:(fn:typeof request)=>request=fn,
    beforeUpdate:(fn:typeof beforeUpdate)=>beforeUpdate=fn,beforeRead:(fn:typeof beforeRead)=>beforeRead=fn,repository,extraNotes,states,
  };
}

test('known task GET accepts only its original remote identity, provider and exact source revision without generating again',async t=>{
  for(const [label,patch] of Object.entries({identity:{taskId:'another-remote'},provider:{provider:'ollama'},revision:{sourceRevision:8},missingRevision:{sourceRevision:undefined}})) {
    await t.test(label,async t=>{const f=fixture(t);f.request(async()=>response(ok(patch)));await f.manager.query(f.noteId,f.draftId);assert.equal(f.draft().status,'unknown');assert.equal(f.draft().latex,undefined);assert.equal(f.draft().task!.remoteId,'remote-original');assert.equal(f.draft().task!.sourceRevision,7);assert.equal(f.completed.length,0);assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'GET');});
  }
  await t.test('valid response uses task source revision rather than the page-local revision',async t=>{const f=fixture(t);f.request(async()=>response(ok()));await f.manager.query(f.noteId,f.draftId);assert.equal(f.draft().status,'completed');assert.equal(f.draft().latex,'\\int x^2\\,dx');assert.equal(f.completed.length,1);assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'GET');});
});

test('BF001-01 a page reply is committed through recursive integrity validation when another owner page has a thumbnail',async t=>{
  const f=fixture(t,{validateStore:true});f.mutate(n=>{const id=addSnapshot(n,'data:image/png;base64,AA==');addPage(n).thumbnailId=id;n.drafts[0].type='page';n.drafts[0].task!.kind='page';n.drafts[0].snapshotIds=[id];});
  f.request(async()=>response(ok({result:{blocks:[{kind:'paragraph',segments:[{type:'text',text:'已收到的普通文字'}],bbox:{x:0,y:0,width:1,height:1},uncertainties:[]}],warnings:[]}})));
  await f.manager.query(f.noteId,f.draftId);assert.equal(f.draft().status,'completed');assert.equal(f.manager.hasUnsaved(f.noteId,f.draftId),false);assert.equal(f.note().blocks.length,0);assert.equal(f.calls.length,1);assert.doesNotThrow(()=>createBackup([f.note()]));
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

test('BF001-01 save failure exposes a safe received preview and retry/import preserve new ink and manual draft edits exactly once',async t=>{
  const f=fixture(t,{validateStore:true});f.mutate(n=>n.drafts[0].task!.contentFingerprint=manuscriptDigest(JSON.stringify([null,null])));f.beforeUpdate(()=>{throw new Error('fixture storage full');});f.request(async()=>response(ok()));await f.manager.query(f.noteId,f.draftId);
  assert.equal(f.draft().status,'running','a failed storage transaction cannot persist a status');assert.equal(f.manager.resultState(f.noteId,f.draftId)!.phase,'save-failed');assert.equal(f.manager.resultState(f.noteId,f.draftId)!.preview!.latex,'\\int x^2\\,dx');assert.deepEqual(f.states,['received','saving','save-failed']);const raw=f.manager.unsavedResult(f.noteId,f.draftId)!;
  f.mutate(n=>{n.pageStrokes[n.currentPageId].push({id:'new-ink',color:'#000',width:2,points:[{x:20,y:30,pressure:.8}]});n.drafts[0].latex='manual newer text';n.drafts[0].version=1;createDraft(n,{type:'formula',sourcePageId:n.currentPageId,latex:'another draft',status:'completed',version:1});});f.beforeUpdate(undefined);
  await Promise.all([f.manager.retrySaving(f.noteId,f.draftId),f.manager.retrySaving(f.noteId,f.draftId)]);let saved=f.note();assert.equal(saved.drafts.length,3);assert.equal(f.draft().latex,'manual newer text');const target=f.manager.resultState(f.noteId,f.draftId)!.savedDraftId!;assert.equal(saved.drafts.find(d=>d.id===target)!.latex,'\\int x^2\\,dx');assert.equal(saved.drafts.find(d=>d.id===target)!.version,1);assert.equal(saved.pageStrokes[saved.currentPageId][0].id,'new-ink');assert.equal(f.calls.length,1);
  await f.manager.retrySaving(f.noteId,f.draftId);await f.manager.restoreReceivedResult(raw);saved=f.note();assert.equal(saved.drafts.length,3);assert.equal(saved.drafts.find(d=>d.id===target)!.version,1);assert.equal(f.calls.length,1);assert.equal(f.manager.hasUnsaved(f.noteId,f.draftId),false);
});

test('BF001-01 a committed transaction stays saved when state refresh, completion rendering and notifications all throw',async t=>{
  const f=fixture(t,{throwUI:true,validateStore:true});f.request(async()=>response(ok()));await f.manager.query(f.noteId,f.draftId);assert.equal(f.draft().status,'completed');assert.equal(f.draft().version,1);assert.equal(f.manager.resultState(f.noteId,f.draftId)!.phase,'saved');assert.equal(f.manager.hasUnsaved(f.noteId,f.draftId),false);assert.equal(f.manager.unsavedResult(f.noteId,f.draftId),undefined);
  await f.manager.retrySaving(f.noteId,f.draftId);assert.equal(f.draft().version,1);assert.equal(f.calls.length,1);
});

test('BF001-01 old raw Reply restores only its original task after memory loss, without credentials or any network request',async t=>{
  const f=fixture(t,{validateStore:true});f.beforeUpdate(()=>{throw new Error('fixture full');});f.request(async()=>response(ok()));await f.manager.query(f.noteId,f.draftId);const raw=JSON.parse(JSON.stringify(f.manager.unsavedResult(f.noteId,f.draftId)));f.beforeUpdate(undefined);const other=ensureNotebook(newNote());f.extraNotes.push(other);
  const restarted=new DraftTaskManager({vault:{tokenFor:async()=>{throw new Error('must not authenticate or upload');}} as unknown as ConnectionVault,saved:()=>{},notify:()=>{}},f.repository);const result=await restarted.restoreReceivedResult(raw);assert.equal(result.noteId,f.noteId);assert.equal(result.draftId,f.draftId);assert.equal(result.saved,true);assert.equal(f.draft().latex,'\\int x^2\\,dx');assert.equal(f.calls.length,1);assert.equal(other.drafts.length,0);
  const version=f.draft().version;await restarted.restoreReceivedResult(raw);assert.equal(f.draft().version,version);assert.equal(f.calls.length,1);
});

test('BF001-01 result recovery rejects missing, wrong-provider, wrong-revision and ambiguous original task identities',async t=>{
  for(const [name,change]of Object.entries({unknown:(f:ReturnType<typeof fixture>,raw:Record<string,unknown>)=>{raw.taskId='no-original';},provider:(_f:ReturnType<typeof fixture>,raw:Record<string,unknown>)=>{raw.provider='ollama';},revision:(_f:ReturnType<typeof fixture>,raw:Record<string,unknown>)=>{raw.sourceRevision=8;},ambiguous:(f:ReturnType<typeof fixture>)=>{const copy=f.note();copy.id='another-note';copy.drafts[0].noteId=copy.id;copy.drafts[0].task!.gateway='https://another-fixture.invalid';copy.drafts[0].task!.principal='local:another';f.extraNotes.push(copy);}}))await t.test(name,async t=>{const f=fixture(t),raw=ok() as Record<string,unknown>;change(f,raw);await assert.rejects(f.manager.restoreReceivedResult(raw));assert.equal(f.draft().status,'running');assert.equal(f.draft().latex,undefined);assert.equal(f.calls.length,0);});
});

test('BF001-01 malformed received content stays inspectably invalid and exportable while local retry never generates',async t=>{
  const f=fixture(t);f.request(async()=>response(ok({result:{provider:'deepseek',simulated:false,latex:''}})));await f.manager.query(f.noteId,f.draftId);const state=f.manager.resultState(f.noteId,f.draftId)!;assert.equal(state.phase,'invalid');assert.equal(state.preview,undefined);assert.match(state.error!,/无法解析/);assert.ok(f.manager.unsavedResult(f.noteId,f.draftId));assert.equal(f.draft().latex,undefined);await f.manager.retrySaving(f.noteId,f.draftId);assert.equal(f.calls.length,1);
});

test('BF001-01 a completed by-request reply survives a failed metadata write and binds its remote ID on local retry',async t=>{
  const f=fixture(t,{knownId:false});f.beforeUpdate(()=>{throw new Error('fixture metadata write full');});f.request(async()=>response(ok()));await f.manager.query(f.noteId,f.draftId);assert.equal(f.manager.resultState(f.noteId,f.draftId)!.phase,'save-failed');assert.equal(f.manager.unsavedResult(f.noteId,f.draftId)!.taskId,'remote-original');assert.equal(f.draft().task!.remoteId,undefined);f.beforeUpdate(undefined);await f.manager.retrySaving(f.noteId,f.draftId);assert.equal(f.draft().task!.remoteId,'remote-original');assert.equal(f.draft().status,'completed');assert.equal(f.calls.length,1);
});

test('BF001-01 a result remains exportable when local reads fail immediately after the validated GET',async t=>{
  const f=fixture(t);let reads=0;f.beforeRead(()=>{if(++reads>=2)throw new Error('fixture database temporarily unavailable');});f.request(async()=>response(ok()));await f.manager.query(f.noteId,f.draftId);assert.ok(f.manager.unsavedResult(f.noteId,f.draftId));assert.equal(f.manager.resultState(f.noteId,f.draftId)!.phase,'save-failed');f.beforeRead(undefined);await f.manager.retrySaving(f.noteId,f.draftId);assert.equal(f.draft().status,'completed');assert.equal(f.calls.length,1);
});

test('BF001-01 a simulated or malformed successful reply records failed when storage works without persisting its invalid content',async t=>{
  for(const result of [{provider:'deepseek',simulated:true,latex:'made-up-example'},{provider:'deepseek',simulated:false,latex:''}])await t.test(result.simulated?'simulated':'malformed',async t=>{const f=fixture(t,{validateStore:true});f.request(async()=>response(ok({result})));await f.manager.query(f.noteId,f.draftId);assert.equal(f.draft().status,'failed');assert.equal(f.draft().task!.phase,'failed');assert.equal(f.draft().latex,undefined);assert.equal(f.draft().result,undefined);assert.equal(f.manager.resultState(f.noteId,f.draftId)!.phase,'invalid');assert.deepEqual(f.manager.unsavedResult(f.noteId,f.draftId)!.result,result);assert.equal(f.calls.length,1);});
});
