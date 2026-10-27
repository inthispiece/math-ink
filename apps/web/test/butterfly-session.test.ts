import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ButterflySession, LifecycleEpoch, type ButterflyDocument } from '../src/butterfly-session.ts';

const ready = { type: 'mathinkReady', message: { version: 1 } };
const document: ButterflyDocument = { data: [80, 75, 3, 4, 42], revision: 'ink-revision', page: 'default' };
function fixture(initialData?: number[]) {
  const sent: { type: 'mathink'; message: { requestId: string; method: string; payload: unknown } }[] = [];
  const writes: ButterflyDocument[] = [], errors: string[] = [];
  let id = 0;
  const session = new ButterflySession({ newId: () => String(++id), initialData, send: packet => sent.push(packet), persist: async value => { writes.push(value); }, onState: () => {}, onError: error => errors.push(error.message), timeoutMs: 100 });
  const reply = (method: string, result: unknown) => { const request = sent.findLast(packet => packet.message.method === method)!; session.receive({ type: 'mathink', message: { requestId: request.message.requestId, ok: true, result } }); };
  return { session, sent, writes, errors, reply };
}
async function turn(): Promise<void> { await new Promise(resolve => setTimeout(resolve, 0)); }
test('a late manifest epoch cannot activate a frame for a previously selected note or mode', () => {
  const epochs = new LifecycleEpoch(); const original = epochs.begin(); const latest = epochs.begin();
  assert.equal(epochs.current(original), false); assert.equal(epochs.current(latest), true);
  epochs.begin(); assert.equal(epochs.current(latest), false);
});
test('restoring waits for setDocument acknowledgement AND a rebuilt frame ready event before saving', async () => {
  const env = fixture([80, 75, 3, 4, 99]);
  try {
    env.session.receive(ready); assert.equal(env.sent[0].message.method, 'setDocument');
    env.reply('setDocument', { accepted: true }); await turn();
    assert.equal(env.session.ready, false); assert.equal(env.writes.length, 0);
    assert.equal(env.sent.some(packet => packet.message.method === 'getDocument'), false, 'the initial blank document must never overwrite the saved original');
    env.session.receive(ready); await turn(); env.reply('getDocument', document);
    await env.session.whenReady(); assert.equal(env.session.ready, true); assert.deepEqual(env.writes, [document]);
  } finally { env.session.dispose(); }
});
test('a fast rebuilt ready event arriving before the acknowledgement is retained', async () => {
  const env = fixture([80, 75, 3, 4, 99]);
  try { env.session.receive(ready); env.session.receive(ready); env.reply('setDocument', { accepted: true }); await turn(); env.reply('getDocument', document); await env.session.whenReady(); assert.deepEqual(env.writes, [document]); }
  finally { env.session.dispose(); }
});
test('disposed old frames ignore ready events and reject old correlated requests', async () => {
  const env = fixture([80, 75]);
  env.session.receive(ready); env.session.dispose(); env.session.receive(ready); await turn();
  assert.equal(env.session.phase, 'closed'); assert.equal(env.writes.length, 0); assert.equal(env.sent.length, 1); assert.equal(env.errors.length, 0);
});
test('a save in flight persists to its captured note even after the visible note changes', async () => {
  let visible = 'note-a'; const writes: string[] = [];
  const env = fixture();
  try {
    env.session.receive(ready); env.reply('getDocument', document); await env.session.whenReady();
    const target = visible;
    const pending = env.session.save().then(() => writes.push(target)); await turn(); visible = 'note-b';
    env.reply('getDocument', { ...document, data: [...document.data, 7] }); await pending;
    assert.equal(visible, 'note-b'); assert.deepEqual(writes, ['note-a']); assert.equal(env.writes.at(-1)!.data.at(-1), 7);
  } finally { env.session.dispose(); }
});
test('failed final saves keep the session available for retry instead of disposing the original', async () => {
  const env = fixture();
  try {
    env.session.receive(ready); env.reply('getDocument', document); await env.session.whenReady();
    const failed = env.session.flush(); await turn(); const call = env.sent.at(-1)!;
    env.session.receive({ type: 'mathink', message: { requestId: call.message.requestId, ok: false, error: '保存失败' } });
    await assert.rejects(failed, /保存失败/); assert.equal(env.session.ready, true); assert.deepEqual(env.writes, [document]);
    const retry = env.session.flush(); await turn(); env.reply('getDocument', { ...document, data: [...document.data, 8] }); await retry; assert.equal(env.writes.at(-1)!.data.at(-1), 8);
  } finally { env.session.dispose(); }
});

test('a failed durable save prevents sending a native page switch', async () => {
  let writes=0,id=0;
  const sent:string[]=[];
  let session:ButterflySession;
  session=new ButterflySession({
    newId:()=>String(++id),timeoutMs:100,
    send:packet=>{sent.push(packet.message.method);queueMicrotask(()=>session.receive({type:'mathink',message:{requestId:packet.message.requestId,ok:true,result:document}}));},
    persist:async()=>{if(++writes>1)throw new Error('Storage is full');},onState:()=>{},onError:()=>{},
  });
  try {
    session.receive(ready);await session.whenReady();
    await assert.rejects(session.switchPage('page-two'),/Storage is full/);
    assert.equal(sent.includes('switchPage'),false);
    assert.equal(session.ready,true);
  } finally {session.dispose();}
});

test('page mutations serialize flush, command and final durable persistence', async () => {
  const events:string[]=[];let id=0;
  let session:ButterflySession;
  session=new ButterflySession({
    newId:()=>String(++id),timeoutMs:100,
    send:packet=>{events.push(packet.message.method);queueMicrotask(()=>session.receive({type:'mathink',message:{requestId:packet.message.requestId,ok:true,result:packet.message.method==='getDocument'?document:{page:'page-two'}}}));},
    persist:async()=>{events.push('persist');},onState:()=>{},onError:()=>{},
  });
  try {
    session.receive(ready);await session.whenReady();events.length=0;
    await Promise.all([session.mutate('createPage',{id:'page-two'}),session.switchPage('page-two')]);
    assert.deepEqual(events,['finishInput','getDocument','persist','createPage','getDocument','persist','finishInput','getDocument','persist','switchPage','getDocument','persist']);
  } finally {session.dispose();}
});

test('invalid duplicated native page identities are rejected before host adoption', async () => {
  const env=fixture();
  try {
    env.session.receive(ready);env.reply('getDocument',document);await env.session.whenReady();
    const pending=env.session.listPages();await turn();
    const row={id:'same',name:'0.first',title:'first',index:0,paper:'blank',deleted:false,revision:'ink',pageRevision:'full'};
    env.reply('listPages',{pages:[row,{...row,name:'1.second',index:1}],currentPage:'same'});
    await assert.rejects(pending,/页面目录无效/);
    assert.deepEqual(env.writes,[document]);
  } finally {env.session.dispose();}
});

test('failed destination persistence returns the native canvas to its previously saved page', async () => {
  let writes=0,id=0,nativePage='default';
  const switched:string[]=[];
  let session:ButterflySession;
  session=new ButterflySession({
    newId:()=>String(++id),timeoutMs:100,
    send:packet=>{
      if(packet.message.method==='switchPage'){nativePage=(packet.message.payload as {page:string}).page;switched.push(nativePage);}
      queueMicrotask(()=>session.receive({type:'mathink',message:{requestId:packet.message.requestId,ok:true,result:packet.message.method==='getDocument'?{...document,page:nativePage}:{page:nativePage}}}));
    },
    persist:async()=>{if(++writes===3)throw new Error('Destination storage failed');},onState:()=>{},onError:()=>{},
  });
  try {
    session.receive(ready);await session.whenReady();
    await assert.rejects(session.switchPage('page-two'),/Destination storage failed/);
    assert.equal(nativePage,'default');
    assert.deepEqual(switched,['page-two','default']);
    assert.equal(session.ready,true);
  } finally {session.dispose();}
});

test('an executed native undo with failed storage retries persistence without consuming another history entry', async () => {
  let id=0,undoCalls=0,failAfterUndo=true;
  let session:ButterflySession;
  session=new ButterflySession({
    newId:()=>String(++id),timeoutMs:100,
    send:packet=>{
      if(packet.message.method==='undo')undoCalls++;
      const result=packet.message.method==='getDocument'?{...document,revision:undoCalls?'after-undo':'before-undo'}:{page:'default',affectedPageIds:['source-page']};
      queueMicrotask(()=>session.receive({type:'mathink',message:{requestId:packet.message.requestId,ok:true,result}}));
    },
    persist:async()=>{if(undoCalls&&failAfterUndo)throw new Error('QuotaExceededError');},onState:()=>{},onError:()=>{},
  });
  try{
    session.receive(ready);await session.whenReady();
    await assert.rejects(session.mutate('undo',{}),/QuotaExceededError/);
    assert.equal(undoCalls,1);assert.equal(session.pendingMutation?.method,'undo');
    assert.deepEqual(session.pendingMutation?.affectedPageIds,['source-page']);
    failAfterUndo=false;
    const result=await session.retryPersistence<{affectedPageIds:string[]}>();
    assert.deepEqual(result?.affectedPageIds,['source-page']);assert.equal(undoCalls,1);assert.equal(session.pendingMutation,undefined);
  }finally{session.dispose();}
});

test('concurrent duplicate native undo clicks share the same mutation and one durable write boundary', async()=>{
  let id=0,undoCalls=0;
  let session:ButterflySession;
  session=new ButterflySession({newId:()=>String(++id),timeoutMs:100,
    send:packet=>{if(packet.message.method==='undo')undoCalls++;queueMicrotask(()=>session.receive({type:'mathink',message:{requestId:packet.message.requestId,ok:true,result:packet.message.method==='getDocument'?document:{page:'default',affectedPageIds:['default']}}}));},
    persist:async()=>{},onState:()=>{},onError:()=>{},
  });
  try{session.receive(ready);await session.whenReady();const a=session.mutate('undo',{}),b=session.mutate('undo',{});assert.equal(a,b);await Promise.all([a,b]);assert.equal(undoCalls,1);}
  finally{session.dispose();}
});

test('selection capability flags are explicit and absent flags from an old native bundle remain disabled', async()=>{
  const env=fixture();
  try{
    env.session.receive(ready);env.reply('getDocument',document);await env.session.whenReady();
    const old=env.session.capabilities();await turn();env.reply('getCapabilities',{tools:true,history:true});
    assert.equal((await old).selection,false);assert.equal((await old).selectionTransform,false);
    const current=env.session.capabilities();await turn();env.reply('getCapabilities',{tools:true,selection:true,selectionTransform:true});
    const caps=await current;assert.equal(caps.selection,true);assert.equal(caps.selectionTransform,true);
  }finally{env.session.dispose();}
});
