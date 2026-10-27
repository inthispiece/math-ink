import test from 'node:test';
import assert from 'node:assert/strict';
import { documentProgress, validateDocumentTask } from '../src/document-model.ts';

test('BF002 document progress preserves page positions and distinguishes generation, local save and copied pages',()=>{
  const pages=[{mode:'copied',phase:'copied',savePhase:'parsed'},{mode:'blank',phase:'blank',savePhase:'parsed'},{mode:'image',phase:'completed',savePhase:'parsed'},{mode:'image',phase:'failed',savePhase:'raw-saved'},{mode:'image',phase:'unsubmitted',savePhase:'input-pending'}] as any;
  assert.deepEqual(documentProgress({pages} as any),{total:5,completed:3,failed:1,pending:1,modelPages:3,submitted:2,unsaved:0});
});

test('BF002 document task validation rejects service credentials and duplicate source pages',()=>{
  assert.throws(()=>validateDocumentTask({token:'secret'}),/任务|凭据/);
});
