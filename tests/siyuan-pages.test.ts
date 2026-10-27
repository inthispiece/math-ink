import test from 'node:test';
import assert from 'node:assert/strict';
import { SiYuanApi, type ExportRecord } from '../apps/host/src/siyuan-api.ts';
import { newNote } from '../apps/web/src/model.ts';
import { createParagraphBlock, createFormulaBlock, ensurePageModel } from '../apps/web/src/page-model.ts';

test('structured export preserves reading order, native block identities and schema-2 provenance', async () => {
  const note = newNote(), n = ensurePageModel(note);
  note.formulas.push({id:'formula-inline',latex:'x^2',sourceStrokeIds:[],sourceRevision:0,sourceBounds:{x:0,y:0,width:10,height:10},createdAt:new Date().toISOString(),provider:'manual',simulated:false});
  const first = createParagraphBlock(note,'中文 English');
  const math = createFormulaBlock(note,'formula-inline');
  const last = createParagraphBlock(note,'因此条件需要保留。');
  n.pages[0].blockOrder = [first.id,math.id,last.id];
  const calls:{path:string;body:any}[] = [];
  let serial = 0, snapshot: any;
  const api = new SiYuanApi(async (input,init) => {
    const path=String(input);
    const body=init?.body instanceof FormData?init.body:JSON.parse(String(init?.body));
    calls.push({path,body});
    let data: unknown=null;
    if(path.endsWith('upload')) {
      const file=(body as FormData).get('file[]') as File; snapshot=JSON.parse(await file.text());
      data={succMap:{[file.name]:'assets/source.mathink.json'}};
    }
    if(path.endsWith('createDocWithMd')) data='document-1';
    if(path.endsWith('appendBlock')) data=[{doOperations:[{id:'native-'+(++serial),action:'insert'}]}];
    return Response.json({code:0,msg:'',data});
  });
  const result=await api.exportNote(note,'book-1');
  assert.equal(snapshot.schemaVersion,4);
  assert.deepEqual(snapshot.notes[0].pages[0].blockOrder,[first.id,math.id,last.id]);
  assert.equal(result.formulaBlockIds['formula-inline'],result.contentBlockIds![math.id]);
  const moves=calls.filter(c=>c.path.endsWith('moveBlock')).map(c=>c.body);
  assert.deepEqual(moves.map(m=>m.id),[first.id,math.id,last.id].map(id=>result.contentBlockIds![id]));
  assert.equal(moves[0].previousID,result.bodyBlockId);
  assert.equal(moves[1].previousID,moves[0].id);
  const attrs=calls.filter(c=>c.path.endsWith('setBlockAttrs')).map(c=>c.body.attrs);
  assert.ok(attrs.some(a=>a['custom-mathink-block-id']===math.id && a['custom-mathink-formula-id']==='formula-inline'));
  calls.length=0;
  const again=await api.exportNote(note,'book-1',result);
  assert.deepEqual(again.contentBlockIds,result.contentBlockIds);
  assert.equal(calls.some(c=>c.path.endsWith('appendBlock')||c.path.endsWith('createDocWithMd')),false);
});
