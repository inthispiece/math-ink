import test from 'node:test';
import assert from 'node:assert/strict';
import {newNote,newId,normalizeNote} from '../src/model.ts';
import {ensureNotebook,createDraft,insertPageDraft} from '../src/notebook-domain.ts';
import {createParagraphBlock,updateBlock} from '../src/page-model.ts';
import {formulaFor} from '../src/draft-content.ts';

test('inserting a page draft preserves sources referenced only by inline formulas',()=>{
  const owner=ensureNotebook(newNote()),content=ensureNotebook(newNote());
  const source={id:newId(),noteId:owner.id,pageId:owner.currentPageId,nativePageId:owner.pages[0].nativePageId,sourceRevision:owner.revision,strokeIds:[],kind:'manual' as const};content.sources.push(source);
  const formula=formulaFor(content,'x^2',source,true),paragraph=createParagraphBlock(content,'',content.currentPageId);updateBlock(content,paragraph.id,{content:{runs:[{type:'text',text:'条件 '},{type:'formula',formulaId:formula.id}]}});
  assert.deepEqual(paragraph.sourceRefIds,[]);
  const draft=createDraft(owner,{type:'page',sourcePageId:owner.currentPageId,content,status:'completed',version:1});insertPageDraft(owner,draft.id,owner.currentPageId,newId(),true);
  const restored=ensureNotebook(normalizeNote(owner)),copied=restored.formulas.find(f=>f.sourceRefId===source.id)!;assert.ok(copied);assert.notEqual(copied.id,formula.id);assert.deepEqual(restored.sources.find(s=>s.id===source.id),source);
});
