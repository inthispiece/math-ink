import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm,stat,mkdir,cp,writeFile} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {unzipSync,zipSync} from 'fflate';
import {chromium} from '@playwright/test';
import {newNote} from '../apps/web/src/model.ts';
import {ensureNotebook,syncNativePages,createDraft,insertFormulaDraft,duplicatePage} from '../apps/web/src/notebook-domain.ts';
import {synchronizeNativeInstances,rebindNativePageCopy} from '../apps/web/src/native-state.ts';

const root=resolve('.');
const pause=ms=>new Promise(done=>setTimeout(done,ms));
async function poll(check,description,timeout=20000){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){const value=await check();if(value)return value;await pause(100);}
  throw new Error('Timed out: '+description);
}
async function bridge(page,method,payload={}){
  return page.evaluate(({method,payload})=>new Promise((resolve,reject)=>{
    const frame=document.getElementById('butterfly-frame'),requestId=crypto.randomUUID();
    const timer=setTimeout(()=>{window.removeEventListener('message',receive);reject(new Error('Bridge timeout: '+method));},20000);
    function receive(event){
      if(event.origin!==location.origin||event.source!==frame.contentWindow||event.data?.type!=='mathink'||event.data.message?.requestId!==requestId)return;
      clearTimeout(timer);window.removeEventListener('message',receive);
      if(event.data.message.ok===false)reject(new Error(event.data.message.error||'Bridge failed'));else resolve(event.data.message.result);
    }
    window.addEventListener('message',receive);
    frame.contentWindow.postMessage({type:'mathink',message:{requestId,method,payload}},location.origin);
  }),{method,payload});
}
function unpack(document,pageId=document.page){
  const files=unzipSync(new Uint8Array(document.data));
  const row=document.pages.find(row=>row.id===pageId);assert.ok(row,'No native directory entry for '+pageId);
  const path='BFLY/pages/'+row.name+'.json';assert.ok(files[path]);
  const page=JSON.parse(Buffer.from(files[path]).toString());
  const elements=(page.layers||[]).flatMap(layer=>layer.content||[]);
  return {files,path,page,elements,pens:elements.filter(element=>element.type==='pen'),math:elements.filter(element=>element.type==='markdown'&&element.extra?.mathink)};
}
async function draw(page,points){
  const box=await page.locator('#butterfly-frame').boundingBox();assert.ok(box);
  await page.mouse.move(box.x+points[0][0],box.y+points[0][1]);await page.mouse.down();
  for(const [x,y] of points.slice(1))await page.mouse.move(box.x+x,box.y+y,{steps:10});
  await page.mouse.up();
}
async function replace(page,document){
  const ready=await page.evaluate(()=>window.__nativeReady);
  assert.equal((await bridge(page,'setDocument',{data:document.data})).accepted,true);
  await page.waitForFunction(previous=>window.__nativeReady>previous,ready,{timeout:30000});
  return bridge(page,'getDocument');
}

test('real Butterfly page catalog, native ordering, independent placements and offline archive restore',{timeout:180000},async t=>{
  const webRoot=resolve(process.env.MATHINK_BUTTERFLY_WEB_ROOT||'dist/web');
  await stat(join(webRoot,'vendor/butterfly/main.dart.js'));
  const temporary=await mkdtemp(join(tmpdir(),'mathink-native-pages-'));
  let servingRoot=webRoot;
  try{await stat(join(servingRoot,'index.html'));}
  catch(error){
    if(error.code!=='ENOENT')throw error;
    servingRoot=join(temporary,'web');
    await mkdir(join(servingRoot,'vendor'),{recursive:true});
    await cp(join(webRoot,'vendor/butterfly'),join(servingRoot,'vendor/butterfly'),{recursive:true});
    await writeFile(join(servingRoot,'index.html'),'<!doctype html><title>Isolated native bridge verification</title>');
  }
  const env={...process.env,GATEWAY_HOST:'127.0.0.1',GATEWAY_PORT:'0',GATEWAY_AUTH_MODE:'local',GATEWAY_PAIRING_TOKEN:'',GATEWAY_DATABASE_PATH:join(temporary,'gateway.sqlite'),OCR_PROVIDER:'mock',DEEPSEEK_API_KEY:'',MATHPIX_APP_ID:'',MATHPIX_APP_KEY:''};
  const server=spawn(process.execPath,['scripts/serve-preview.mjs','--web-root',servingRoot],{cwd:root,env,stdio:['ignore','pipe','pipe'],windowsHide:true});
  let output='',browser,page,finished=false;
  server.stdout.on('data',chunk=>output+=chunk);server.stderr.on('data',chunk=>output+=chunk);
  t.after(async()=>{
    if(!finished&&page&&!page.isClosed()){
      await mkdir(resolve('artifacts'),{recursive:true});await page.screenshot({path:resolve('artifacts/butterfly-pages-failure.png')}).catch(()=>{});
      try{const doc=await bridge(page,'getDocument');console.log('Native test failure state:',JSON.stringify({page:doc.page,pages:doc.pages,math:unpack(doc).math}));}catch(error){console.log('Native failure state unavailable:',error.message);}
    }
    await browser?.close();
    if(server.exitCode===null){const exited=once(server,'exit');server.kill();await exited;}
    const checked=resolve(temporary);assert.ok(checked.startsWith(resolve(tmpdir())+sep)&&checked.includes('mathink-native-pages-'));await rm(checked,{recursive:true,force:true});
  });
  const base=await poll(async()=>{
    if(server.exitCode!==null)throw new Error(output);
    const match=/http:\/\/127\.0\.0\.1:(\d+)/.exec(output);if(!match)return false;
    const base='http://127.0.0.1:'+match[1];try{return(await fetch(base+'/health')).ok?base:false;}catch{return false;}
  },'isolated production static server');
  browser=await chromium.launch({channel:'msedge',headless:true,args:['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1']});
  const context=await browser.newContext({viewport:{width:1400,height:1000}});
  const outside=[],pageErrors=[];let generationRequests=0;
  context.on('request',request=>{const url=new URL(request.url());if(request.method()==='POST'&&/^\/v1\/(?:recognize|review|tasks)/.test(url.pathname))generationRequests++;});
  await context.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(['http:','https:'].includes(url.protocol)&&!['127.0.0.1','localhost'].includes(url.hostname)){outside.push(url.href);return route.abort();}
    if(url.pathname==='/native-bridge-host')return route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"></head><body style="margin:0"><iframe id="butterfly-frame" title="Native test" style="width:100vw;height:100vh;border:0" src="/vendor/butterfly/index.html#/embed?save=false&language=zh-Hans&fullScreen=forced"></iframe></body></html>'});
    return route.continue();
  });
  page=await context.newPage();page.on('pageerror',error=>pageErrors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')console.log('Native browser:',message.text().slice(0,1500));});
  await page.addInitScript(()=>{window.__nativeReady=0;window.addEventListener('message',event=>{if(event.origin===location.origin&&event.source===document.getElementById('butterfly-frame')?.contentWindow&&event.data?.type==='mathinkReady')window.__nativeReady++;});});
  await page.goto(base+'/native-bridge-host');await page.waitForFunction(()=>window.__nativeReady>0,null,{timeout:60000});
  const capabilities=await bridge(page,'getCapabilities');assert.equal(capabilities.pages,true);assert.equal(capabilities.operationIdempotency,true);
  const initial=await bridge(page,'getDocument'),first=initial.page;
  assert.equal(initial.pages.length,1);
  await assert.rejects(bridge(page,'deletePage',{page:first}),/LAST_PAGE/);
  await bridge(page,'setView',{x:12,y:25,zoom:1.25});assert.deepEqual(await bridge(page,'getView'),{x:12,y:25,zoom:1.25});
  await bridge(page,'setView',{x:0,y:0,zoom:1});
  await bridge(page,'setFingerWriting',{enabled:false});
  await bridge(page,'setTool',{tool:'pen',color:'#223b31',width:3});
  await draw(page,[[180,260],[210,230],[250,275]]);
  const written=await poll(async()=>{const doc=await bridge(page,'getDocument');return unpack(doc).pens.length===1?doc:false;},'real first-page ink');
  const firstPen=unpack(written).pens[0];assert.ok(firstPen.points.length>2);
  const penBeforeUndo=written.revision;
  await bridge(page,'undo');assert.equal(unpack(await bridge(page,'getDocument')).pens.length,0);
  await bridge(page,'redo');assert.equal(unpack(await bridge(page,'getDocument')).pens.length,1);
  assert.equal((await bridge(page,'getDocument')).revision,penBeforeUndo);
  const created=await bridge(page,'createPage',{id:'native-second',paper:'grid',index:1});
  assert.equal(created.page,'native-second');assert.equal(unpack(await bridge(page,'getDocument')).pens.length,0);
  await bridge(page,'setTool',{tool:'pen',color:'#223b31',width:3});await draw(page,[[350,260],[370,310],[410,280]]);
  const secondWritten=await poll(async()=>{const doc=await bridge(page,'getDocument');return unpack(doc).pens.length===1?doc:false;},'separate second-page ink');
  assert.notEqual(unpack(secondWritten).pens[0].id,firstPen.id);
  await bridge(page,'duplicatePage',{page:first,id:'native-copy',index:2});
  const copied=unpack(await bridge(page,'getDocument'));assert.equal(copied.pens.length,1);assert.notEqual(copied.pens[0].id,firstPen.id);
  await bridge(page,'reorderPages',{pages:['native-second',first,'native-copy']});
  const ordered=await bridge(page,'listPages');assert.deepEqual(ordered.pages.filter(row=>!row.deleted).map(row=>row.id),['native-second',first,'native-copy']);
  await bridge(page,'locateInk',{page:first,strokeIds:[firstPen.id],bounds:{x:150,y:200,width:150,height:150}});
  assert.equal((await bridge(page,'getDocument')).page,first);
  assert.equal(unpack(await bridge(page,'getDocument')).pens[0].id,firstPen.id);
  await bridge(page,'deletePage',{page:first});assert.equal((await bridge(page,'listPages')).pages.find(row=>row.id===first).deleted,true);
  await assert.rejects(bridge(page,'switchPage',{page:first}),/SOURCE_PAGE_MISSING/);
  await bridge(page,'restorePage',{page:first,index:1});
  assert.deepEqual((await bridge(page,'listPages')).pages.filter(row=>!row.deleted).map(row=>row.id),['native-second',first,'native-copy']);
  const placement={page:'native-second',position:{x:300,y:400},operationId:'placement-once',latex:'x^2',source:{draftId:'draft-one',version:1}};
  const inserted=await bridge(page,'insertMath',placement);assert.equal(inserted.inserted,true);
  const renderedMath=await bridge(page,'renderPage',{page:'native-second'});
  const visibleMath=await page.evaluate(async image=>{
    const bitmap=new Image();bitmap.src='data:image/png;base64,'+image.pngBase64;await bitmap.decode();
    const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;
    const context=canvas.getContext('2d');context.drawImage(bitmap,0,0);
    const {offsetX,offsetY,scaleX,scaleY}=image.transform;
    const x=Math.max(0,Math.floor((300-offsetX)*scaleX)),y=Math.max(0,Math.floor((400-offsetY)*scaleY));
    const width=Math.min(canvas.width-x,Math.ceil(150*scaleX)),height=Math.min(canvas.height-y,Math.ceil(100*scaleY));
    if(width<=0||height<=0)return false;
    const pixels=context.getImageData(x,y,width,height).data;let dark=0;
    for(let index=0;index<pixels.length;index+=4)if(pixels[index+3]>50&&pixels[index]<100&&pixels[index+1]<100&&pixels[index+2]<100)dark++;
    return dark>5;
  },renderedMath);
  assert.equal(visibleMath,true,'the placed equation must be rendered into real PNG pixels, not only stored in archive JSON');
  const duplicate=await bridge(page,'insertMath',placement);assert.equal(duplicate.id,inserted.id);assert.equal(duplicate.duplicate,true);
  assert.equal(unpack(await bridge(page,'getDocument')).math.length,1);
  await assert.rejects(bridge(page,'insertMath',{...placement,latex:'x^3'}),/OPERATION_MISMATCH/);
  await bridge(page,'updateMath',{page:'native-second',elementId:inserted.id,latex:'x^4',position:{x:400,y:500}});
  assert.equal(unpack(await bridge(page,'getDocument')).math[0].extra.mathink.latex,'x^4');
  const another=await bridge(page,'insertMath',{...placement,operationId:'placement-undo'});
  assert.notEqual(another.id,inserted.id);
  await bridge(page,'undo');
  const undoneRetry=await bridge(page,'insertMath',{...placement,operationId:'placement-undo'});
  assert.equal(undoneRetry.removed,true);
  assert.equal(unpack(await bridge(page,'getDocument')).math.some(element=>element.id===another.id),false);
  await bridge(page,'removeMath',{page:'native-second',elementId:inserted.id});
  const removedRetry=await bridge(page,'insertMath',placement);assert.equal(removedRetry.removed,true);
  assert.equal(unpack(await bridge(page,'getDocument')).math.length,0);
  const saved=await bridge(page,'getDocument');
  const source=unpack(saved,first),extra=structuredClone(source.page);
  extra.extra={...extra.extra,mathinkPage:{id:'never-visited',paper:'lined'}};
  extra.layers.forEach(layer=>{layer.id='unvisited-'+layer.id;layer.content.forEach(element=>element.id='unvisited-'+element.id);});
  source.files['BFLY/pages/999.never-visited.json']=new TextEncoder().encode(JSON.stringify(extra));
  const archival={data:Array.from(zipSync(source.files))};
  await context.setOffline(true);
  const restored=await replace(page,archival);
  assert.equal(restored.pages.length,4);
  assert.ok(restored.pages.some(row=>row.id==='never-visited'));
  assert.notEqual(restored.page,'never-visited','archive enumeration must not require visiting the page');
  const afterReload=await bridge(page,'insertMath',placement);assert.equal(afterReload.removed,true,'operation receipt persists across native document replacement');
  await bridge(page,'switchPage',{page:'never-visited'});
  const unseen=unpack(await bridge(page,'getDocument'));assert.equal(unseen.pens.length,1);assert.match(unseen.pens[0].id,/^unvisited-/);
  assert.equal((await bridge(page,'setPaper',{page:'never-visited',paper:'lined'})).pages.find(row=>row.id==='never-visited').paper,'lined');
  // Reconcile actual release archive bytes, not only generated JSON fixtures.
  await bridge(page,'createPage',{id:'helper-source',paper:'blank'});
  const nativeMath=await bridge(page,'insertMath',{page:'helper-source',position:{x:60,y:90},operationId:'helper-original',latex:'x^2'});
  const nativeState=await bridge(page,'getDocument'),host=ensureNotebook(newNote());
  syncNativePages(host,nativeState.pages);host.butterflyData=nativeState.data;host.butterflyPage=nativeState.page;
  const sourceHost=host.pages.find(row=>row.nativePageId==='helper-source');assert.ok(sourceHost);
  host.currentPageId=sourceHost.id;host.strokes=host.pageStrokes[sourceHost.id];
  const reusable=createDraft(host,{type:'formula',sourcePageId:sourceHost.id,status:'completed',latex:'x^2'});
  const originalPlacement=insertFormulaDraft(host,reusable.id,sourceHost.id,{x:60,y:90},'helper-original');originalPlacement.elementId=nativeMath.id;
  assert.equal(synchronizeNativeInstances(host).changed,false);
  await bridge(page,'updateMath',{page:'helper-source',elementId:nativeMath.id,latex:'x^5',position:{x:100,y:120}});
  host.butterflyData=(await bridge(page,'getDocument')).data;
  assert.equal(synchronizeNativeInstances(host).changed,true);assert.equal(originalPlacement.latex,'x^5');assert.equal(reusable.latex,'x^2');
  await bridge(page,'duplicatePage',{page:'helper-source',id:'helper-copy'});
  host.butterflyData=(await bridge(page,'getDocument')).data;
  const copyHost=duplicatePage(host,sourceHost.id,'helper-copy'),copyPlacement=host.placements.find(item=>item.pageId===copyHost.id);assert.ok(copyPlacement);
  assert.equal(rebindNativePageCopy(host,sourceHost.id,copyHost.id).changed,true);assert.notEqual(copyPlacement.elementId,originalPlacement.elementId);
  assert.equal(synchronizeNativeInstances(host).changed,false);
  await bridge(page,'removeMath',{page:'helper-copy',elementId:copyPlacement.elementId});host.butterflyData=(await bridge(page,'getDocument')).data;
  assert.equal(synchronizeNativeInstances(host).changed,true);assert.ok(copyPlacement.deletedAt);assert.equal(originalPlacement.deletedAt,undefined);
  await bridge(page,'undo');host.butterflyData=(await bridge(page,'getDocument')).data;
  assert.equal(synchronizeNativeInstances(host).changed,true);assert.equal(copyPlacement.deletedAt,undefined);assert.equal(reusable.latex,'x^2');
  await bridge(page,'createPage',{id:'history-receipt-page',paper:'blank'});
  const receiptA=await bridge(page,'insertMath',{page:'history-receipt-page',position:{x:60,y:90},operationId:'receipt-history-a',latex:'a'});
  const receiptB=await bridge(page,'insertMath',{page:'history-receipt-page',position:{x:160,y:90},operationId:'receipt-history-b',latex:'b'});
  await bridge(page,'getDocument');
  await bridge(page,'removeMath',{page:'history-receipt-page',elementId:receiptA.id});
  await bridge(page,'undo');assert.deepEqual(new Set(unpack(await bridge(page,'getDocument')).math.map(element=>element.id)),new Set([receiptA.id,receiptB.id]));
  await bridge(page,'undo');assert.deepEqual(unpack(await bridge(page,'getDocument')).math.map(element=>element.id),[receiptA.id]);
  await bridge(page,'undo');assert.deepEqual(unpack(await bridge(page,'getDocument')).math,[],'bookkeeping cannot consume an extra user history step between two insertions');
  assert.equal((await bridge(page,'insertMath',{page:'history-receipt-page',position:{x:160,y:90},operationId:'receipt-history-b',latex:'b'})).removed,true);
  // BF001: real mixed selection, one native history event per pointer gesture,
  // stale-selection guards and persistent formula scale without a model call.
  await bridge(page,'createPage',{id:'selection-page',paper:'blank'});
  await bridge(page,'setView',{x:0,y:0,zoom:1});
  await bridge(page,'setTool',{tool:'pen',width:4,noteId:'bf001-native-owner'});
  await draw(page,[[140,200],[160,220],[180,240]]);
  await draw(page,[[400,300],[420,320],[450,340]]);
  const selectedMath=await bridge(page,'insertMath',{page:'selection-page',position:{x:250,y:220},operationId:'bf001-selection-math',latex:'x^2'});
  await bridge(page,'setTool',{tool:'lasso',noteId:'bf001-native-owner'});
  const all=await bridge(page,'selectAll',{noteId:'bf001-native-owner'});
  assert.equal(all.noteId,'bf001-native-owner');assert.equal(all.pageId,'selection-page');
  assert.equal(all.objectIds.length,3);assert.equal(all.inkIds.length,2);assert.deepEqual(all.mathIds,[selectedMath.id]);
  await assert.rejects(bridge(page,'getSelectedInk',{page:'selection-page',generation:all.generation}),/MIXED_SELECTION/);
  await assert.rejects(bridge(page,'renderSelectedInk',{strokeIds:all.inkIds,generation:all.generation}),/MIXED_SELECTION/);
  await bridge(page,'setTool',{tool:'lasso',noteId:'bf001-native-owner'});
  assert.equal((await bridge(page,'getSelection',{noteId:'bf001-native-owner'})).generation,all.generation,'re-entering lasso cannot discard an existing selection');
  const sameSet=await bridge(page,'selectAll',{noteId:'bf001-native-owner'});
  assert.ok(sameSet.generation>all.generation,'a new selection of the same IDs must invalidate an earlier callback token');
  assert.equal((await bridge(page,'clearSelection',{generation:all.generation,pageId:all.pageId})).cleared,false);
  await bridge(page,'clearSelection',{generation:sameSet.generation,pageId:sameSet.pageId});
  const again=await bridge(page,'selectAll',{noteId:'bf001-native-owner'});
  const late=await bridge(page,'clearSelection',{generation:all.generation,pageId:all.pageId});
  assert.equal(late.cleared,false);assert.deepEqual(late.objectIds,again.objectIds);
  await bridge(page,'clearSelection',{});
  await draw(page,[[100,150],[330,150],[330,285],[100,285],[100,150]]);
  const group=await bridge(page,'getSelection',{noteId:'bf001-native-owner'});
  assert.equal(group.objectIds.length,2);assert.equal(group.inkIds.length,1);assert.deepEqual(group.mathIds,[selectedMath.id]);
  const originalGroup=unpack(await bridge(page,'getDocument'));
  const selectedPen=originalGroup.pens.find(pen=>pen.id===group.inkIds[0]),unselectedPen=originalGroup.pens.find(pen=>pen.id!==group.inkIds[0]);
  assert.ok(selectedPen&&unselectedPen);
  const center={x:group.bounds.x+group.bounds.width/2,y:group.bounds.y+group.bounds.height/2};
  await draw(page,[[center.x,center.y],[center.x+30,center.y+20],[center.x+60,center.y+40]]);
  const moved=unpack(await bridge(page,'getDocument'));
  assert.deepEqual(moved.pens.find(pen=>pen.id===unselectedPen.id),unselectedPen);
  const movedPen=moved.pens.find(pen=>pen.id===selectedPen.id),movedMath=moved.math.find(element=>element.id===selectedMath.id);
  assert.equal(movedPen.points[0].x,selectedPen.points[0].x+60);assert.equal(movedPen.points[0].y,selectedPen.points[0].y+40);
  assert.equal(movedMath.position.x,310);assert.equal(movedMath.position.y,260);
  const undoneMove=await bridge(page,'undo');assert.ok(undoneMove.affectedPageIds.includes('selection-page'));
  assert.deepEqual(unpack(await bridge(page,'getDocument')).elements,originalGroup.elements,'one undo must restore the entire group gesture');
  assert.deepEqual((await bridge(page,'getSelection',{})).objectIds,[]);
  await bridge(page,'redo');assert.deepEqual(unpack(await bridge(page,'getDocument')).elements,moved.elements);
  // Select the same independent pair again, then drag the real resize handle.
  await draw(page,[[150,185],[395,185],[395,330],[150,330],[150,185]]);
  const resize=await bridge(page,'getSelection',{});assert.equal(resize.objectIds.length,2);
  const corner={x:resize.bounds.x+resize.bounds.width,y:resize.bounds.y+resize.bounds.height};
  await draw(page,[[corner.x,corner.y],[corner.x+resize.bounds.width*.4,corner.y+resize.bounds.height*.4],[corner.x+resize.bounds.width*.8,corner.y+resize.bounds.height*.8]]);
  const scaled=unpack(await bridge(page,'getDocument')),scaledMath=scaled.math.find(element=>element.id===selectedMath.id),scaledPen=scaled.pens.find(pen=>pen.id===selectedPen.id);
  assert.ok(scaledMath.scale>1.2&&scaledMath.scale<=20);assert.equal(scaledMath.text,movedMath.text);
  assert.ok(Math.abs(scaledPen.property.strokeWidth-selectedPen.property.strokeWidth*scaledMath.scale)<1e-6);
  assert.deepEqual(scaledPen.points.map(point=>point.pressure),selectedPen.points.map(point=>point.pressure));
  assert.deepEqual(scaled.pens.find(pen=>pen.id===unselectedPen.id),unselectedPen);
  await bridge(page,'undo');assert.deepEqual(unpack(await bridge(page,'getDocument')).elements,moved.elements);
  await bridge(page,'redo');assert.deepEqual(unpack(await bridge(page,'getDocument')).elements,scaled.elements);
  await bridge(page,'setTool',{tool:'pen',width:4});
  await draw(page,[[120,650],[170,650],[220,650]]);
  await bridge(page,'setTool',{tool:'lasso'});
  await draw(page,[[80,610],[260,610],[260,690],[80,690],[80,610]]);
  const flat=await bridge(page,'getSelection',{});assert.equal(flat.inkIds.length,1);assert.equal(flat.mathIds.length,0);
  const flatBefore=unpack(await bridge(page,'getDocument')),flatPen=flatBefore.pens.find(element=>element.id===flat.inkIds[0]);
  assert.ok(flatPen);assert.ok(flatPen.points.every(point=>point.y===flatPen.points[0].y));
  await draw(page,[[170,650],[190,665],[210,680]]);
  const flatAfter=unpack(await bridge(page,'getDocument')).pens.find(element=>element.id===flatPen.id);
  assert.equal(flatAfter.points[0].x,flatPen.points[0].x+40);assert.equal(flatAfter.points[0].y,flatPen.points[0].y+30);
  await bridge(page,'undo');assert.deepEqual(unpack(await bridge(page,'getDocument')).elements,flatBefore.elements);
  await bridge(page,'switchPage',{page:first});
  const navigationUndo=await bridge(page,'undo');assert.equal(navigationUndo.page,'selection-page');
  assert.ok(navigationUndo.affectedPageIds.includes(first));assert.ok(navigationUndo.affectedPageIds.includes('selection-page'));
  assert.equal(generationRequests,0);assert.deepEqual(outside,[]);assert.deepEqual(pageErrors,[]);
  finished=true;
});
