import test from 'node:test';
import assert from 'node:assert/strict';
import {newNote} from '../src/model.ts';
import {ensureNotebook,createDraft,insertFormulaDraft,undoInsertion,editDraft} from '../src/notebook-domain.ts';
import {captureInsertion,restoreInsertion} from '../src/insertion-history.ts';
test('explicit redo restores the exact independent formula version after its draft changes',()=>{const n=ensureNotebook(newNote()),d=createDraft(n,{type:'formula',sourcePageId:n.currentPageId,status:'completed',version:1,latex:'x^2'}),p=insertFormulaDraft(n,d.id,n.currentPageId,{x:10,y:20},'placement-once');const before=captureInsertion(n,'placement-once')!;assert.ok(undoInsertion(n,'placement-once'));editDraft(n,d.id,{latex:'x^3'});restoreInsertion(n,before);assert.equal(n.placements.find(p=>p.operationId==='placement-once')!.latex,'x^2');assert.equal(n.formulas.find(f=>f.id===before.insertion.formulaId)!.latex,'x^2');assert.equal(n.drafts[0].latex,'x^3');assert.equal(n.drafts[0].uses.length,1);assert.throws(()=>restoreInsertion(n,before));assert.equal(n.placements.filter(x=>!x.deletedAt).length,1);assert.equal(n.placements[0].id,p.id);});
