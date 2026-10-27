import test from 'node:test';
import assert from 'node:assert/strict';
import {newNote,createBackup,parseBackup} from '../src/model.ts';
import {ensureNotebook,addPage,addSnapshot,createDraft} from '../src/notebook-domain.ts';
import {createParagraphBlock,createSourceRef} from '../src/page-model.ts';
import {shadowDocument,pageDraftContent} from '../src/draft-content.ts';

test('BF001-01 selected shadow excludes thumbnails from all owner pages while retaining their source IDs and resources',()=>{
  const owner=ensureNotebook(newNote()),first=owner.pages[0],other=addPage(owner),snapshot=addSnapshot(owner,'data:image/png;base64,AA==');
  first.thumbnailId=other.thumbnailId=snapshot;owner.pageViews[first.id]={zoom:2,panX:80,panY:30};
  const block=createParagraphBlock(owner,'条件完整保留',first.id),source=createSourceRef(owner,first.id),before=structuredClone(owner);
  const content=shadowDocument(owner,source,[block]);createDraft(owner,{type:'review',sourcePageId:first.id,status:'completed',content});
  assert.doesNotThrow(()=>createBackup([owner]));assert.equal(content.pages!.some(p=>p.thumbnailId),false);assert.deepEqual(content.resources,{});assert.deepEqual(content.pages!.map(p=>p.id),before.pages.map(p=>p.id));assert.equal(owner.resources[snapshot].dataUrl,before.resources[snapshot].dataUrl);assert.equal(owner.pages[0].thumbnailId,snapshot);assert.equal(content.pageViews?.[first.id].panX,0);
});

test('BF001-01 plain page results save and round-trip when only another page has a thumbnail',async()=>{
  const owner=ensureNotebook(newNote()),first=owner.pages[0],other=addPage(owner),snapshot=addSnapshot(owner,'data:image/png;base64,AA==');other.thumbnailId=snapshot;
  const source=createSourceRef(owner,first.id,{x:0,y:0,width:100,height:80},[]),draft=createDraft(owner,{type:'page',sourcePageId:first.id,source,snapshotIds:[snapshot],status:'running'});
  const result={blocks:[{kind:'paragraph',segments:[{type:'text',text:'收到的结果'}],bbox:{x:0,y:0,width:1,height:1},uncertainties:[]}],warnings:[]};
  draft.content=await pageDraftContent(owner,draft,result,{page:first.nativePageId,revision:'0',strokeIds:[],bounds:source.bounds!,imageUrl:owner.resources[snapshot].dataUrl,imageBase64:'AA==',transform:{scaleX:1,scaleY:1,offsetX:0,offsetY:0}});draft.status='completed';
  const restored=parseBackup(JSON.stringify(createBackup([owner]))).notes[0];assert.equal(restored.drafts![0].content!.blocks![0].content.runs![0].type,'text');assert.equal(restored.pages!.find(p=>p.id===other.id)!.thumbnailId,snapshot);assert.equal(restored.resources![snapshot].dataUrl,owner.resources[snapshot].dataUrl);assert.equal(owner.blocks.length,0);
});
