import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newNote } from '../src/model.ts';
import { createParagraphBlock, updateBlock } from '../src/page-model.ts';
import { ensureNotebook, addPage, trashPage, restorePage, trashNote, restoreNote, createDraft, insertFormulaDraft, undoInsertion } from '../src/notebook-domain.ts';
import { addLink, backlinks, linkState, resolveLink, searchNotes } from '../src/knowledge.ts';

test('local knowledge search and stable links follow page and notebook recycle state without a stale index', () => {
  const source=ensureNotebook(newNote()),target=ensureNotebook(newNote()),sourcePage=addPage(source,{kind:'typeset'}),targetPage=addPage(target,{kind:'typeset'});
  const from=createParagraphBlock(source,'source-proof',sourcePage.id),to=createParagraphBlock(target,'target-theorem-original',targetPage.id);
  const link=addLink(source,{sourceBlockId:from.id,targetNoteId:target.id,targetBlockId:to.id,relation:'theorem',targetRevision:to.revision});
  assert.equal(linkState([source,target],link),'valid');assert.equal(searchNotes([source,target],'target-theorem-original').length,1);assert.equal(backlinks([source,target],target.id).length,1);
  trashPage(target,targetPage.id);assert.equal(searchNotes([source,target],'target-theorem-original').length,0);assert.equal(resolveLink([source,target],link),null);assert.equal(linkState([source,target],link),'broken');
  restorePage(target,targetPage.id);assert.equal(linkState([source,target],link),'valid');updateBlock(target,to.id,{content:{runs:[{type:'text',text:'target-theorem-edited'}]}});assert.equal(linkState([source,target],link),'changed');assert.equal(searchNotes([source,target],'target-theorem-original').length,0);assert.equal(searchNotes([source,target],'target-theorem-edited').length,1);
  trashNote(target);assert.equal(searchNotes([source,target],'target-theorem-edited').length,0);assert.equal(linkState([source,target],link),'broken');restoreNote(target);assert.equal(linkState([source,target],link),'changed');
  trashPage(source,sourcePage.id);assert.equal(linkState([source,target],link),'broken');restorePage(source,sourcePage.id);assert.equal(linkState([source,target],link),'changed');trashNote(source);assert.equal(linkState([source,target],link),'broken');assert.equal(backlinks([source,target],target.id).length,0);restoreNote(source);assert.equal(backlinks([source,target],target.id).length,1);
});

test('undoing a native formula insertion hides it from local search and marks both link endpoints broken until redo',()=>{
  const source=ensureNotebook(newNote()),target=ensureNotebook(newNote()),from=createParagraphBlock(source,'source-proof');
  const draft=createDraft(target,{type:'formula',sourcePageId:target.currentPageId,status:'completed',latex:'\\lVert f \\rVert_{L^p}'}),placement=insertFormulaDraft(target,draft.id,target.currentPageId,{x:10,y:20},'native-knowledge-insertion');placement.elementId='native-knowledge-element';
  const insertion=target.insertions[0],block=target.blocks.find(b=>b.content.formulaId===insertion.formulaId)!;
  const incoming=addLink(source,{sourceBlockId:from.id,targetNoteId:target.id,targetBlockId:block.id,targetRevision:block.revision}),outgoing=addLink(target,{sourceBlockId:block.id,targetNoteId:source.id,targetBlockId:from.id,targetRevision:from.revision});
  assert.equal(searchNotes([source,target],'lVert').length,1);assert.equal(linkState([source,target],incoming),'valid');assert.equal(linkState([source,target],outgoing),'valid');undoInsertion(target,insertion.operationId);
  assert.ok(target.blocks.some(b=>b.id===block.id));assert.equal(searchNotes([source,target],'lVert').length,0);assert.equal(linkState([source,target],incoming),'broken');assert.equal(linkState([source,target],outgoing),'broken');assert.equal(resolveLink([source,target],incoming),null);
  delete insertion.undoneAt;delete placement.deletedAt;assert.equal(searchNotes([source,target],'lVert').length,1);assert.equal(linkState([source,target],incoming),'valid');assert.equal(linkState([source,target],outgoing),'valid');
});
