import test from 'node:test';
import assert from 'node:assert/strict';
import { newNote, createBackup } from '../src/model.ts';
import { createParagraphBlock, createSourceRef, updateBlock, orderedBlocks, ensurePageModel } from '../src/page-model.ts';
import { formulaFor, editableBlockText } from '../src/draft-content.ts';
import { editDraftBlockText, splitDraftParagraph, mergeDraftParagraphs } from '../src/draft-editing.ts';

function fixture() {
  const note=ensurePageModel(newNote()),page=note.pages[0];
  const source=createSourceRef(note,page.id,{x:10,y:20,width:300,height:50},['ink-one']);
  const f=formulaFor(note,'x^2',source,true),g=formulaFor(note,'y^2',source,true);
  const block=createParagraphBlock(note,'',page.id);
  updateBlock(note,block.id,{content:{runs:[{type:'text',text:'设 '},{type:'formula',formulaId:f.id},{type:'text',text:' 与 '},{type:'formula',formulaId:g.id},{type:'text',text:' 为实数。'}]},sourceRefIds:[source.id],needsReview:true});
  return {note,block,f,g,source};
}
test('draft text edits preserve both canonical inline identities and source while unchanged saves do nothing',()=>{
  const {note,block,f,g,source}=fixture(),revision=note.contentRevision;
  for(let i=0;i<3;i++)assert.equal(editDraftBlockText(note,block.id,'设 $x^2$ 与 $y^2$ 为实数。'),false);
  assert.equal(note.contentRevision,revision);assert.equal(note.formulas.length,2);
  assert.equal(editDraftBlockText(note,block.id,'若 $x^2$ 与 $y^2$ 非负。'),true);
  assert.deepEqual(block.content.runs?.filter(r=>r.type==='formula').map(r=>r.formulaId),[f.id,g.id]);
  assert.equal(editDraftBlockText(note,block.id,'若 $x^3$ 与 $y^2$ 非负。'),true);
  assert.equal(f.latex,'x^3');assert.equal(g.latex,'y^2');assert.equal(note.formulas.length,2);
  assert.deepEqual(block.sourceRefIds,[source.id]);assert.equal(f.sourceRefId,source.id);assert.equal(g.sourceRefId,source.id);
  createBackup([note]);
});
test('draft paragraph split and merge retain inline formulas and sources without creating extra canonical copies',()=>{
  const {note,block,f,g,source}=fixture(),text=editableBlockText(note,block),inside=text.indexOf('x^2')+1;
  const original=JSON.stringify(note);assert.throws(()=>splitDraftParagraph(note,block.id,inside),/行内公式之外/);assert.equal(JSON.stringify(note),original);
  const rightId=splitDraftParagraph(note,block.id,text.indexOf(' 与 ')+1);
  const right=note.blocks.find(b=>b.id===rightId)!;
  assert.deepEqual(block.content.runs?.filter(r=>r.type==='formula').map(r=>r.formulaId),[f.id]);
  assert.deepEqual(right.content.runs?.filter(r=>r.type==='formula').map(r=>r.formulaId),[g.id]);
  assert.deepEqual(right.sourceRefIds,[source.id]);assert.equal(note.formulas.length,2);
  mergeDraftParagraphs(note,block.id,rightId);
  assert.equal(orderedBlocks(note).length,1);assert.equal(note.formulas.length,2);
  assert.deepEqual(block.content.runs?.filter(r=>r.type==='formula').map(r=>r.formulaId),[f.id,g.id]);assert.deepEqual(block.sourceRefIds,[source.id]);
  createBackup([note]);
});
test('draft paragraph editing treats escaped dollars as text and keeps deleted inline formulas out of formal auto-blocks',()=>{
  const {note,block,f,g}=fixture();
  assert.equal(editDraftBlockText(note,block.id,'价格 \\$5 与 $y^2$。'),true);
  assert.equal(editableBlockText(note,block),'价格 \\$5 与 $y^2$。');
  assert.deepEqual(block.content.runs?.filter(r=>r.type==='formula').map(r=>r.formulaId),[g.id]);
  ensurePageModel(note);assert.equal(note.blocks.length,1);assert.equal(f.inline,true);assert.equal(g.inline,true);
  createBackup([note]);
});
