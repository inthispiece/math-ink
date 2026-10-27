import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newNote, createBackup, parseBackup, exportMarkdown, type Note } from '../src/model.ts';
import { createParagraphBlock, updateBlock } from '../src/page-model.ts';
import { ensureNotebook, visiblePages, addPage, selectPage, commitPageInk, movePage, duplicatePage, trashPage, restorePage, syncNativePages, addSnapshot, createDraft, editDraft, insertFormulaDraft, insertPageDraft, undoInsertion, trashDraft, restoreDraft, permanentDeleteDraft, draftSourceState, duplicateNote } from '../src/notebook-domain.ts';

const ink = (id: string, x = 1) => [{ id, color: '#111', width: 2, points: [{ x, y: 2, pressure: .7 }] }];
const image = 'data:image/png;base64,iVBORw0KGgo=';
test('real page storage restores page-specific ink and view while ordering/deletion keeps stable IDs', () => {
  const note = ensureNotebook(newNote()), first = note.currentPageId;
  commitPageInk(note, ink('first'), { zoom: 2, panX: 30, panY: 40 });
  const second = addPage(note, { afterPageId: first, paper: 'grid' }); selectPage(note, second.id);
  assert.equal(note.strokes.length, 0); commitPageInk(note, ink('second', 8));
  selectPage(note, first); assert.equal(note.strokes[0].id, 'first'); assert.equal(note.pageViews[first].zoom, 2);
  movePage(note, second.id, 0); assert.deepEqual(visiblePages(note).map(p => p.id), [second.id,first]);
  trashPage(note, first); assert.equal(visiblePages(note).length, 1); restorePage(note, first); selectPage(note, first); assert.equal(note.strokes[0].id, 'first');
  const copied = duplicatePage(note, first); assert.notEqual(note.pageStrokes[copied.id][0].id, note.strokes[0].id); assert.equal(note.pageStrokes[copied.id][0].points[0].x, 1);
  const restored = ensureNotebook(parseBackup(JSON.stringify(createBackup([note]))).notes[0]); assert.deepEqual(restored.pageOrder,note.pageOrder); assert.deepEqual(restored.pageStrokes,note.pageStrokes); assert.deepEqual(restored.pageViews,note.pageViews);
});
test('reading a shallow page cover cannot copy active-page ink into a different page',()=>{
  const n=ensureNotebook(newNote()),first=n.currentPageId;commitPageInk(n,ink('first'));const second=addPage(n);selectPage(n,second.id);commitPageInk(n,ink('second'));const original=structuredClone(n.pageStrokes);
  const cover={...n,pageOrder:[first],currentPageId:first};visiblePages(cover);assert.deepEqual(n.pageStrokes,original);assert.equal(n.pageStrokes[first][0].id,'first');assert.equal(n.pageStrokes[second.id][0].id,'second');
});
test('old formal Markdown stays accessible as legacy page and never becomes a draft', () => {
  const note: Note = { id: 'legacy', title: 'old', strokes: ink('ink'), formulas: [], tags: [], markdown: '**kept**', revision: 4, updatedAt: '2026-01-01T00:00:00Z' };
  const migrated = ensureNotebook(parseBackup(JSON.stringify({ format:'math-ink',schemaVersion:1,notes:[note] })).notes[0]);
  assert.equal(migrated.drafts.length, 0); assert.equal(migrated.strokes[0].id,'ink'); assert.equal(migrated.pages.find(p=>p.kind==='legacy')!.blockOrder.length,1); assert.match(exportMarkdown(migrated), /\*\*kept\*\*/);
});
test('native page enumeration adds previously unseen pages and preserves native order and stable host mappings', () => {
  const note = ensureNotebook(newNote()); const listed = syncNativePages(note,[{name:'default'},{name:'not-visited',revision:'ink-v1',pageRevision:'page-v1'},{name:'third'}]);
  assert.equal(listed.length,3); const ids=listed.map(p=>p.id); assert.deepEqual(note.pageOrder.slice(0,3),ids); syncNativePages(note,[{name:'third'},{name:'default'},{name:'not-visited'}]);
  assert.deepEqual(note.pageOrder.slice(0,3),[ids[2],ids[0],ids[1]]); assert.equal(note.butterflyPageRevisions?.['not-visited'],'ink-v1');
});
test('native archived pages retain stable mappings and paper settings while remaining outside active page navigation',()=>{
  const n=ensureNotebook(newNote()),pages=syncNativePages(n,[{name:'default',paper:'lined',deleted:false},{name:'archived',paper:'grid',deleted:true}]);assert.equal(pages[0].paper,'ruled');assert.equal(pages[1].paper,'grid');assert.ok(pages[1].deletedAt);assert.equal(visiblePages(n).length,1);const id=pages[1].id;syncNativePages(n,[{name:'default',deleted:false},{name:'archived',paper:'grid',deleted:false}]);assert.equal(visiblePages(n).length,2);assert.equal(n.pages.find(p=>p.nativePageId==='archived')!.id,id);
});
test('draft results and snapshots are isolated from formal contents and normal export; full backup roundtrip retains them', () => {
  const note = ensureNotebook(newNote()), before = exportMarkdown(note), resource=addSnapshot(note,image);
  assert.equal(addSnapshot(note,image),resource); assert.equal(Object.keys(note.resources).length,1);
  const draft=createDraft(note,{type:'formula',sourcePageId:note.currentPageId,snapshotIds:[resource],status:'completed',latex:'x^2'});
  assert.equal(note.formulas.length,0); assert.equal(note.blocks.length,0); assert.equal(exportMarkdown(note),before);
  const restored=ensureNotebook(parseBackup(JSON.stringify(createBackup([note]))).notes[0]); assert.equal(restored.drafts[0].id,draft.id); assert.equal(restored.resources[resource].dataUrl,image);
  assert.throws(()=>parseBackup(JSON.stringify({...createBackup([note]),schemaVersion:5})),/备份版本/);
});
test('formula insertion is idempotent per operation, independent per use, and undo keeps the reusable draft', () => {
  const note=ensureNotebook(newNote()), d=createDraft(note,{type:'formula',sourcePageId:note.currentPageId,status:'completed',latex:'x^2'});
  const first=insertFormulaDraft(note,d.id,note.currentPageId,{x:10,y:20},'operation-one'), again=insertFormulaDraft(note,d.id,note.currentPageId,{x:99,y:99},'operation-one');
  assert.equal(first.id,again.id); assert.equal(note.formulas.length,1); assert.equal(d.uses.length,1);
  editDraft(note,d.id,{latex:'x^3'}); const next=insertFormulaDraft(note,d.id,note.currentPageId,{x:20,y:30},'operation-two');
  assert.equal(first.latex,'x^2'); assert.equal(next.latex,'x^3'); assert.notEqual(first.id,next.id); assert.equal(d.uses.length,2);
  assert.equal(undoInsertion(note,'operation-one'),true); assert.equal(d.latex,'x^3'); assert.equal(note.drafts.length,1); assert.equal(note.formulas.length,1); assert.equal(undoInsertion(note,'operation-one'),false);
});
test('page draft insertion duplicates canonical block/formula identity without replacing original page or draft', () => {
  const note=ensureNotebook(newNote()), content=newNote(); createParagraphBlock(content,'original condition p > 1');
  const d=createDraft(note,{type:'page',sourcePageId:note.currentPageId,status:'completed',content}); const original=note.currentPageId;
  const first=insertPageDraft(note,d.id,original,'page-op'), second=insertPageDraft(note,d.id,original,'page-op'); assert.equal(first.id,second.id); assert.equal(note.pages.find(p=>p.id===first.pageId)!.kind,'typeset');
  assert.equal(note.pages.length,2); assert.notEqual(note.blocks[0].id,content.blocks![0].id); updateBlock(content,content.blocks![0].id,{content:{runs:[{type:'text',text:'edited draft'}]}}); assert.equal(note.blocks[0].content.runs![0].type==='text'&&note.blocks[0].content.runs![0].text,'original condition p > 1');
  assert.equal(undoInsertion(note,'page-op'),true); assert.equal(visiblePages(note).length,1); assert.equal(note.drafts.length,1);
});
test('changed or deleted sources keep historical snapshots but require explicit historical insertion', () => {
  const note=ensureNotebook(newNote()), page=note.currentPageId, d=createDraft(note,{type:'formula',sourcePageId:page,status:'completed',latex:'x',snapshotIds:[addSnapshot(note,image)]});
  commitPageInk(note,ink('changed')); assert.equal(draftSourceState(note,d),'modified'); assert.throws(()=>insertFormulaDraft(note,d.id,page,{x:0,y:0},'blocked'),/历史/);
  insertFormulaDraft(note,d.id,page,{x:0,y:0},'allowed',true); trashPage(note,page); assert.equal(draftSourceState(note,d),'deleted'); assert.equal(note.resources[d.snapshotIds[0]].dataUrl,image); restorePage(note,page);
});
test('draft recycle, permanent cleanup and notebook copy keep independent data without losing shared snapshots', () => {
  const note=ensureNotebook(newNote()), resource=addSnapshot(note,image), a=createDraft(note,{type:'formula',sourcePageId:note.currentPageId,status:'completed',latex:'a',snapshotIds:[resource]}), b=createDraft(note,{type:'formula',sourcePageId:note.currentPageId,status:'completed',latex:'b',snapshotIds:[resource]});
  trashDraft(note,a.id); restoreDraft(note,a.id); assert.equal(a.deletedAt,undefined); trashDraft(note,a.id); permanentDeleteDraft(note,a.id); assert.ok(note.resources[resource]);
  const copied=ensureNotebook(duplicateNote(note)); assert.notEqual(copied.id,note.id); editDraft(copied,b.id,{latex:'copied'}); assert.equal(b.latex,'b');
  trashDraft(note,b.id); permanentDeleteDraft(note,b.id); assert.equal(Object.keys(note.resources).length,0);
});
test('malformed page catalogs, missing resources and credentials in task snapshots reject entire backup', () => {
  const note=ensureNotebook(newNote()), d=createDraft(note,{type:'formula',sourcePageId:note.currentPageId}); const good=createBackup([note]);
  const bad=structuredClone(good); bad.notes[0].pageOrder!.push(note.currentPageId); assert.throws(()=>parseBackup(JSON.stringify(bad)),/目录/);
  d.snapshotIds=['snapshot-missing']; assert.throws(()=>createBackup([note]),/草稿/); d.snapshotIds=[];
  d.task={kind:'formula',clientRequestId:'id',provider:'deepseek',gateway:'http://localhost',installationId:'install',principal:'account-hash',phase:'pending',createdAt:d.createdAt,updatedAt:d.updatedAt,request:{nested:{authorization:'secret'}}}; assert.throws(()=>createBackup([note]),/凭据/);
});
test('known historical page tasks create a draft copy once, preserving existing formal blocks without reinsertion', () => {
  const note = newNote(); createParagraphBlock(note, 'previously formal');
  note.tasks!.push({ id:'history-task',type:'page-transcribe',provider:'deepseek',model:'fixture',pageId:note.pages![0].id,input:{contentRevision:0,sourceRevision:0,blocks:{},formulas:{}},status:'completed',steps:[{id:'generate',clientRequestId:'original-request',status:'completed',blockIds:[note.blocks![0].id]}],createdAt:note.updatedAt,updatedAt:note.updatedAt,result:{blocks:[]}});
  delete note.pageOrder; delete note.pageStrokes; delete note.currentPageId;
  const migrated=ensureNotebook(note); assert.equal(migrated.drafts.length,1); assert.equal(migrated.blocks.length,1); assert.equal(migrated.drafts[0].content!.blocks![0].content.runs![0].type==='text'&&migrated.drafts[0].content!.blocks![0].content.runs![0].text,'previously formal'); ensureNotebook(migrated); assert.equal(migrated.drafts.length,1); assert.doesNotThrow(()=>createBackup([migrated]));
});
test('inserted objects retain their own source snapshot reference when their reusable draft is permanently deleted', () => {
  const note=ensureNotebook(newNote()),resource=addSnapshot(note,image),d=createDraft(note,{type:'formula',sourcePageId:note.currentPageId,status:'completed',latex:'a',snapshotIds:[resource]}); insertFormulaDraft(note,d.id,note.currentPageId,{x:10,y:10},'insert-once'); trashDraft(note,d.id); permanentDeleteDraft(note,d.id); assert.ok(note.resources[resource]); assert.equal(note.placements.length,1); assert.equal(note.drafts.length,0); assert.doesNotThrow(()=>createBackup([note]));
});
test('task body fingerprints survive backup and reject malformed hashes without treating title changes as content',()=>{
  const n=ensureNotebook(newNote()),d=createDraft(n,{type:'formula',sourcePageId:n.currentPageId});d.task={kind:'formula',clientRequestId:'original-id',provider:'deepseek',gateway:'http://localhost',installationId:'installation',principal:'identity',phase:'pending',createdAt:d.createdAt,updatedAt:d.updatedAt,contentFingerprint:'a'.repeat(64)};const restored=createBackup([n]);assert.equal(restored.notes[0].drafts![0].task!.contentFingerprint,'a'.repeat(64));d.task.contentFingerprint='not-a-hash';assert.throws(()=>createBackup([n]),/指纹/);
});
test('legacy notebook engine choice preserves both archives and raw ink; copying a page keeps independent placed formulas',()=>{
  const n=ensureNotebook(newNote());assert.equal(n.inkEngine,'experimental');n.butterflyData=[1,2,3];delete n.inkEngine;ensureNotebook(n);assert.equal(n.inkEngine,'butterfly');n.inkEngine='experimental';ensureNotebook(n);assert.equal(n.inkEngine,'experimental');assert.deepEqual(n.butterflyData,[1,2,3]);const d=createDraft(n,{type:'formula',sourcePageId:n.currentPageId,status:'completed',latex:'x^2'});const original=insertFormulaDraft(n,d.id,n.currentPageId,{x:10,y:20},'original-placement'),page=duplicatePage(n,n.currentPageId),clone=n.placements.find(p=>p.pageId===page.id)!;assert.notEqual(clone.id,original.id);assert.notEqual(clone.operationId,original.operationId);assert.equal(clone.latex,'x^2');const sourceInstance=n.insertions.find(i=>i.operationId===original.operationId)!,copyInstance=n.insertions.find(i=>i.operationId===clone.operationId)!;assert.notEqual(sourceInstance.formulaId,copyInstance.formulaId);clone.latex='x^3';assert.equal(original.latex,'x^2');assert.equal(d.latex,'x^2');assert.equal(d.uses.length,2);assert.doesNotThrow(()=>createBackup([n]));
});
test('a native page removed by undo is not a restorable host-only page and native redo can revive its original identity',()=>{
  const n=ensureNotebook(newNote()),p=addPage(n,{nativePageId:'native-added'});p.nativeMissing=true;p.deletedAt=new Date().toISOString();assert.equal(visiblePages(n).some(x=>x.id===p.id),false);assert.throws(()=>restorePage(n,p.id),/原生页面已被撤销/);syncNativePages(n,[{name:'default',deleted:false},{name:'native-added',deleted:false}]);assert.equal(n.pages.find(x=>x.id===p.id)!.nativeMissing,undefined);assert.equal(visiblePages(n).some(x=>x.id===p.id),true);assert.doesNotThrow(()=>createBackup([n]));
});
test('duplicating a page cannot revive native undone canonical formula blocks as new visible content',()=>{
  const n=ensureNotebook(newNote()),d=createDraft(n,{type:'formula',sourcePageId:n.currentPageId,status:'completed',latex:'UNDONE_FORMULA'}),placement=insertFormulaDraft(n,d.id,n.currentPageId,{x:10,y:20},'undone-before-copy');placement.elementId='native-copy-element';undoInsertion(n,placement.operationId);const count=n.formulas.length,page=duplicatePage(n,n.currentPageId);assert.equal(n.formulas.length,count);assert.equal(page.blockOrder.length,0);assert.equal(n.blocks.some(b=>b.pageId===page.id),false);assert.equal(n.placements.some(p=>p.pageId===page.id),false);assert.doesNotThrow(()=>createBackup([n]));
});
