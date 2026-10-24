import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createBackup, newNote, parseBackup, type Formula } from '../src/model.ts';
import { createParagraphBlock, createSourceRef, ensurePageModel, updateBlock } from '../src/page-model.ts';
import { manuscriptDigest, rememberSourceCopies, resolveSourceLocation } from '../src/source-copy.ts';
import { activeFormulas } from '../src/formula-activity.ts';

function fixture() {
  const original=ensurePageModel(newNote());original.title='原始手稿';original.revision=7;original.strokes=[{id:'source-ink',color:'#111',width:3,points:[{x:10,y:20,pressure:.5},{x:40,y:60,pressure:.7}]}];
  const block=createParagraphBlock(original,'原条件');const source=createSourceRef(original,original.pages[0].id,{x:0,y:0,width:100,height:100},['source-ink']);source.nativeRevision='7';updateBlock(original,block.id,{sourceRefIds:[source.id]});
  const draft=structuredClone(original);draft.id='draft-note';draft.pages.forEach(page=>page.noteId=draft.id);rememberSourceCopies(original,draft);return {original,draft,source};
}
test('LAN-safe SHA-256 matches Node on empty, boundary, Unicode and large manuscript strings',()=>{
  for(const text of ['', 'abc', 'a'.repeat(55),'a'.repeat(56),'a'.repeat(64),'中文 ∫x² dx 😀'.repeat(10000)])assert.equal(manuscriptDigest(text),createHash('sha256').update(text).digest('hex'));
});
test('standalone draft backup preserves original source identity and locates only a proven identical copy',()=>{
  const {original,draft,source}=fixture();assert.equal(draft.sourceCopyProofs?.length,1);
  const imported=parseBackup(JSON.stringify(createBackup([draft]))).notes[0];const resolved=resolveSourceLocation([imported],imported,imported.sources![0]);
  assert.equal(resolved?.copy,true);assert.equal(resolved?.note.id,draft.id);assert.equal(imported.sources![0].noteId,original.id);assert.equal(imported.sources![0].id,source.id);assert.equal(source.noteId,original.id);
  assert.equal(resolveSourceLocation([original,imported],imported,source)?.copy,false);
});
test('same revision and stroke IDs cannot authorize changed geometry, missing proof or altered source identity',()=>{
  const {draft,source}=fixture();const changed=structuredClone(draft);changed.strokes[0].points[0].x++;assert.equal(changed.revision,source.sourceRevision);assert.equal(resolveSourceLocation([changed],changed,source),null);
  const noProof=structuredClone(draft);delete noProof.sourceCopyProofs;assert.equal(resolveSourceLocation([noProof],noProof,source),null);
  assert.equal(resolveSourceLocation([draft],draft,{...source,bounds:{x:999,y:0,width:10,height:10}}),null);
  const wrongPage=structuredClone(draft);wrongPage.pages[0].nativePageId='unrelated';assert.equal(resolveSourceLocation([wrongPage],wrongPage,source),null);
});
test('Butterfly copy needs complete page revision and rejects changed image/archive or ink-only matching',()=>{
  const {original,source}=fixture();original.butterflyData=[80,75,3,4,42];source.nativeRevision='complete-page-image-hash';source.nativeInkRevision='ink-hash';original.butterflyContentRevisions={default:source.nativeRevision};original.butterflyPageRevisions={default:source.nativeInkRevision};
  const draft=structuredClone(original);draft.id='bf-copy';draft.pages.forEach(page=>page.noteId=draft.id);rememberSourceCopies(original,draft);assert.equal(resolveSourceLocation([draft],draft,source)?.copy,true);
  const imageChanged=structuredClone(draft);imageChanged.butterflyData![4]++;assert.equal(resolveSourceLocation([imageChanged],imageChanged,source),null);
  const fullChanged=structuredClone(draft);fullChanged.butterflyContentRevisions!.default='changed-image-same-ink';assert.equal(resolveSourceLocation([fullChanged],fullChanged,source),null);
  const inkOnly=structuredClone(draft);delete inkOnly.butterflyContentRevisions;assert.equal(resolveSourceLocation([inkOnly],inkOnly,source),null);
  assert.equal(draft.sources[0].nativeRevision,'complete-page-image-hash');
});
test('historical inline canonical formulas stay available for undo while active counts hide removed references',()=>{
  const n=ensurePageModel(newNote()),block=createParagraphBlock(n,'');
  const base:Formula={id:'active-inline',latex:'x',inline:true,sourceStrokeIds:[],sourceRevision:0,sourceBounds:{x:0,y:0,width:1,height:1},createdAt:new Date().toISOString(),provider:'manual',simulated:false};
  n.formulas.push(base,{...base,id:'history-inline',latex:'y'},{...base,id:'standalone',inline:false});updateBlock(n,block.id,{content:{runs:[{type:'formula',formulaId:base.id}]}});
  assert.deepEqual(activeFormulas(n).map(f=>f.id),['active-inline','standalone']);assert.equal(n.formulas.length,3);
  updateBlock(n,block.id,{content:{runs:[{type:'text',text:'removed'}]}});assert.deepEqual(activeFormulas(n).map(f=>f.id),['standalone']);assert.equal(n.formulas.length,3);
});
