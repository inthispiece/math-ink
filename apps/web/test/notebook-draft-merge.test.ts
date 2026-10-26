import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync } from 'fflate';
import { newNote, createBackup } from '../src/model.ts';
import { createParagraphBlock } from '../src/page-model.ts';
import { ensureNotebook, createDraft, editDraft, insertFormulaDraft, insertPageDraft, undoInsertion, duplicatePage, trashDraft, permanentDeleteDraft } from '../src/notebook-domain.ts';
import { mergeEditorDrafts } from '../src/notebook-repository.ts';
import { synchronizeNativeInstances } from '../src/native-state.ts';

const clone=<T>(value:T):T=>structuredClone(value);
function archive(nativePageId:string,content:unknown[]){const encode=(v:unknown)=>new TextEncoder().encode(JSON.stringify(v));return [...zipSync({'META-INF/butterfly.json':encode({type:'document',fileVersion:13}),'BFLY/pages/0.first.json':encode({layers:[{id:'layer',content}],extra:{mathinkPage:{id:nativePageId}}})})];}
const nativeMath={id:'native-element',type:'markdown',text:'$x^2$',position:{x:10,y:20},extra:{mathink:{latex:'x^2'}}};

test('editor merge derives independent usage versions and undo/copy state while the latest draft body stays authoritative',()=>{
  const original=ensureNotebook(newNote()),draft=createDraft(original,{type:'formula',sourcePageId:original.currentPageId,status:'completed',latex:'x^2',version:1,reviewed:true});
  let editor=clone(original),latest=clone(original);insertFormulaDraft(editor,draft.id,editor.currentPageId,{x:10,y:20},'use-version-one');editDraft(latest,draft.id,{latex:'x^3'});editor.drafts=mergeEditorDrafts(editor,latest);
  assert.equal(editor.drafts[0].latex,'x^3');assert.equal(editor.drafts[0].version,2);assert.equal(editor.drafts[0].reviewed,false);assert.equal(latest.drafts[0].uses.length,0);assert.equal(editor.drafts[0].uses[0].version,1);
  insertFormulaDraft(editor,draft.id,editor.currentPageId,{x:30,y:40},'use-version-two');latest=clone(editor);editDraft(latest,draft.id,{latex:'x^4'});undoInsertion(editor,'use-version-one');const copied=duplicatePage(editor,editor.currentPageId);const copiedPlacement=editor.placements.find(p=>p.pageId===copied.id)!;editor.drafts=mergeEditorDrafts(editor,latest);
  const saved=editor.drafts[0];assert.equal(saved.latex,'x^4');assert.equal(saved.version,3);assert.equal(saved.uses.length,3);assert.equal(saved.uses.find(u=>u.operationId==='use-version-one')!.version,1);assert.ok(saved.uses.find(u=>u.operationId==='use-version-one')!.undoneAt);assert.equal(saved.uses.find(u=>u.operationId==='use-version-two')!.version,2);assert.equal(saved.uses.find(u=>u.operationId==='use-version-two')!.undoneAt,undefined);assert.equal(saved.uses.find(u=>u.operationId===copiedPlacement.operationId)!.pageId,copied.id);assert.equal(saved.uses.find(u=>u.operationId===copiedPlacement.operationId)!.version,2);assert.notEqual(saved.uses[1].instanceId,saved.uses[2].instanceId);assert.doesNotThrow(()=>createBackup([editor]));
});

test('native archive undo and redo persist the actual instance usage without reverting newer draft content or task state',()=>{
  const editor=ensureNotebook(newNote()),draft=createDraft(editor,{type:'formula',sourcePageId:editor.currentPageId,status:'completed',latex:'x^2',version:1}),placement=insertFormulaDraft(editor,draft.id,editor.currentPageId,{x:10,y:20},'native-use');placement.elementId=nativeMath.id;let latest=clone(editor);latest.drafts[0].uses=[];editDraft(latest,draft.id,{latex:'x^9'});latest.drafts[0].task={kind:'formula',clientRequestId:'original-request',remoteId:'original-task',provider:'deepseek',gateway:'http://localhost',installationId:'installation',principal:'local:hash',phase:'completed',createdAt:draft.createdAt,updatedAt:draft.updatedAt};
  const page=editor.pages.find(p=>p.id===editor.currentPageId)!;editor.butterflyData=archive(page.nativePageId,[]);synchronizeNativeInstances(editor);editor.drafts=mergeEditorDrafts(editor,latest);assert.ok(editor.drafts[0].uses[0].undoneAt);assert.equal(editor.drafts[0].uses[0].version,1);assert.equal(editor.drafts[0].latex,'x^9');assert.equal(editor.drafts[0].task!.remoteId,'original-task');latest=clone(editor);
  editor.butterflyData=archive(page.nativePageId,[nativeMath]);synchronizeNativeInstances(editor);editor.drafts=mergeEditorDrafts(editor,latest);assert.equal(editor.drafts[0].uses.length,1);assert.equal(editor.drafts[0].uses[0].undoneAt,undefined);assert.equal(editor.drafts[0].uses[0].placementId,placement.id);assert.equal(editor.drafts[0].uses[0].instanceId,editor.insertions[0].formulaId);assert.equal(editor.drafts[0].latex,'x^9');assert.equal(editor.drafts[0].task!.remoteId,'original-task');assert.doesNotThrow(()=>createBackup([editor]));
});

test('an old editor never revives a permanently deleted draft even when its independent insertion survives',()=>{
  const original=ensureNotebook(newNote()),draft=createDraft(original,{type:'formula',sourcePageId:original.currentPageId,status:'completed',latex:'x',version:1});insertFormulaDraft(original,draft.id,original.currentPageId,{x:10,y:20},'kept-instance');const oldEditor=clone(original),latest=clone(original);trashDraft(latest,draft.id);permanentDeleteDraft(latest,draft.id);oldEditor.drafts=mergeEditorDrafts(oldEditor,latest);assert.equal(oldEditor.drafts.length,0);assert.equal(oldEditor.insertions.length,1);assert.equal(oldEditor.placements.length,1);assert.equal(oldEditor.formulas[0].latex,'x');assert.doesNotThrow(()=>createBackup([oldEditor]));
});

test('page draft usage is derived from the inserted page and retains its historical version after undo',()=>{
  const editor=ensureNotebook(newNote()),content=newNote();createParagraphBlock(content,'original condition');const draft=createDraft(editor,{type:'page',sourcePageId:editor.currentPageId,status:'completed',content,version:4}),latest=clone(editor),insertion=insertPageDraft(editor,draft.id,editor.currentPageId,'page-insertion');undoInsertion(editor,insertion.operationId);editor.drafts=mergeEditorDrafts(editor,latest);const use=editor.drafts[0].uses[0];assert.equal(use.instanceId,insertion.pageId);assert.equal(use.version,4);assert.equal(use.kind,'page');assert.ok(use.undoneAt);assert.doesNotThrow(()=>createBackup([editor]));
});
