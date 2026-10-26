import test from 'node:test';
import assert from 'node:assert/strict';
import { newNote } from '../src/model.ts';
import { ensureNotebook,addPage,createDraft,draftSourceState,type NotebookTask } from '../src/notebook-domain.ts';
import { createParagraphBlock,createFormulaBlock,updateBlock,removeBlock } from '../src/page-model.ts';
import { assertLinkEvidenceCurrent } from '../src/link-evidence.ts';

function fixture(wrapped=true){
  const owner=ensureNotebook(newNote()),target=ensureNotebook(newNote()),page=addPage(owner,{kind:'typeset'}),targetPage=addPage(target,{kind:'typeset'});
  const from=createParagraphBlock(owner,'假设 x > 0',page.id),to=createParagraphBlock(target,'定理要求 x > 0',targetPage.id),at=new Date().toISOString();
  const input={noteId:owner.id,blocks:[{id:from.id,version:from.revision,text:'假设 x > 0'}],candidates:[{id:to.id,version:to.revision,text:'定理要求 x > 0'}]};
  const request=wrapped?{input,candidateOwners:{[to.id]:target.id}}:input;
  const task:NotebookTask={kind:'links',clientRequestId:'fixture-request',provider:'deepseek',gateway:'https://fixture.invalid',installationId:'fixture',principal:'local:fixture',phase:'completed',request,createdAt:at,updatedAt:at};
  const draft=createDraft(owner,{type:'links',sourcePageId:page.id,sourceRevision:page.revision||0,status:'completed',task});
  const link={fromBlockId:from.id,toBlockId:to.id,reason:'定理适用于此假设',evidence:[{blockId:from.id,version:from.revision,quote:'x > 0'},{blockId:to.id,version:to.revision,quote:'x > 0'}]};
  const savedTask=draft.task!,sentInput=(wrapped?(savedTask.request as {input:typeof input}).input:savedTask.request) as typeof input;
  return {owner,target,page,targetPage,from,to,input:sentInput,task:savedTask,draft,link,check:()=>assertLinkEvidenceCurrent(owner,target,draft,link)};
}

test('wrapped and unwrapped original request versions permit a current link without mutating any inputs',()=>{
  for(const wrapped of [true,false]){const f=fixture(wrapped),before=JSON.stringify(f);assert.doesNotThrow(f.check);assert.equal(JSON.stringify(f),before);}
});

test('formal source changes invalidate evidence even when its page revision and draft source state are unchanged',()=>{
  const f=fixture();updateBlock(f.owner,f.from.id,{content:{runs:[{type:'text',text:'假设 x < 0'}]}});
  assert.equal(f.page.revision||0,0);assert.equal(draftSourceState(f.owner,f.draft),'unchanged');assert.throws(f.check,/来源内容.*已修改.*重新检查/);assert.equal(f.owner.links.length,0);
});

test('a modified target cannot be adopted as the newly current revision of an old generated relation',()=>{
  const f=fixture();updateBlock(f.target,f.to.id,{content:{runs:[{type:'text',text:'定理现在要求 x < 0'}]}});
  assert.throws(f.check,/目标内容.*已修改.*重新检查/);assert.equal(f.owner.links.length,0);assert.equal(f.input.candidates[0].version,0);assert.equal(f.to.revision,1);
});

test('deleted source or target notes, pages and blocks cannot supply live evidence',async t=>{
  for(const [name,remove]of Object.entries({
    sourceNote:(f:ReturnType<typeof fixture>):void=>{f.owner.deletedAt=new Date().toISOString();},
    targetNote:(f:ReturnType<typeof fixture>):void=>{f.target.deletedAt=new Date().toISOString();},
    sourcePage:(f:ReturnType<typeof fixture>):void=>{f.page.deletedAt=new Date().toISOString();},
    targetPage:(f:ReturnType<typeof fixture>):void=>{f.targetPage.deletedAt=new Date().toISOString();},
    nativeMissing:(f:ReturnType<typeof fixture>):void=>{f.targetPage.nativeMissing=true;},
    removedSourceBlock:(f:ReturnType<typeof fixture>):void=>{removeBlock(f.owner,f.from.id);},
    removedTargetBlock:(f:ReturnType<typeof fixture>):void=>{removeBlock(f.target,f.to.id);},
  }))await t.test(name,()=>{const f=fixture();remove(f);assert.throws(f.check,/已删除|有效页面/);assert.equal(f.owner.links.length,0);});
});

test('missing, ambiguous or invalid original sent versions require a new check even when model evidence claims to be current',async t=>{
  for(const [name,change]of Object.entries({
    missingRequest:(f:ReturnType<typeof fixture>):void=>{f.task.request=undefined;},
    missingSource:(f:ReturnType<typeof fixture>):void=>{f.input.blocks=[];},
    missingCandidate:(f:ReturnType<typeof fixture>):void=>{f.input.candidates=[];},
    duplicateCandidate:(f:ReturnType<typeof fixture>):void=>{f.input.candidates.push({...f.input.candidates[0]});},
    negativeVersion:(f:ReturnType<typeof fixture>):void=>{f.input.blocks[0].version=-1;},
    missingVersion:(f:ReturnType<typeof fixture>):void=>{Reflect.deleteProperty(f.input.blocks[0],'version');},
  }))await t.test(name,()=>{const f=fixture();change(f);assert.throws(f.check,/原始.*版本|原始发送范围/);});
});

test('conflicting model evidence versions are rejected while request-only evidence remains sufficient',()=>{
  for(const index of [0,1]){const f=fixture();f.link.evidence[index].version++;assert.throws(f.check,/引文版本.*不一致/);}
  const f=fixture();f.link.evidence=[];assert.doesNotThrow(f.check);
});

test('note and candidate identity mismatches are rejected even if both blocks have matching revisions',()=>{
  let f=fixture();f.draft.noteId='other-owner';assert.throws(f.check,/不属于当前笔记/);
  f=fixture();f.input.noteId='other-owner';assert.throws(f.check,/发送记录.*不匹配/);
  f=fixture();(f.task.request as {candidateOwners:Record<string,string>}).candidateOwners[f.to.id]='other-target';assert.throws(f.check,/目标.*候选笔记不匹配/);
  f=fixture();f.draft.deletedAt=new Date().toISOString();assert.throws(f.check,/草稿已删除/);
});

test('editing unrelated content does not invalidate an unchanged pair of explicitly sent blocks',()=>{
  const f=fixture();createParagraphBlock(f.owner,'另一段证明',f.page.id);createParagraphBlock(f.target,'另一个定理',f.targetPage.id);assert.doesNotThrow(f.check);
});

test('a formula changed without a normalized block version is detected using a copy and leaves the caller untouched',()=>{
  const f=fixture();f.target.formulas.push({id:'fixture-formula',latex:'x>0',sourceStrokeIds:[],sourceBounds:{x:0,y:0,width:1,height:1},sourceRevision:0,createdAt:new Date().toISOString(),provider:'manual',simulated:false,inline:true});
  const block=createFormulaBlock(f.target,'fixture-formula',f.targetPage.id);f.input.candidates=[{id:block.id,version:block.revision,text:'x>0'}];f.link.toBlockId=block.id;f.link.evidence[1]={blockId:block.id,version:block.revision,quote:'x>0'};
  f.target.formulas[0].latex='x<0';const before=JSON.stringify(f.target);assert.throws(f.check,/目标内容.*已修改/);assert.equal(JSON.stringify(f.target),before);
});
