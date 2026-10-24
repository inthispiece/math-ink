import test from 'node:test';
import assert from 'node:assert/strict';
import { assess, characterErrorRate, normalizeFormula, validateManifest, wordErrorRate } from '../apps/gateway/src/evaluation.ts';

test('evaluation split rejects the same writer or source across debug and acceptance', () => {
  const s = { id: 'page1', kind: 'page', split: 'debug', writerGroup: 'writer', sourceGroup: 'book', imagePath: 'private.png' };
  assert.throws(()=>validateManifest({version:1,samples:[s,{...s,id:'page2',split:'acceptance'}]}),/数据泄漏/);
  assert.equal(validateManifest({version:1,samples:[]}).samples.length,0);
});
test('character and word error rates preserve errors instead of claiming exact recognition', () => {
  assert.deepEqual(characterErrorRate('连续函数','连续函教'),{errors:1,units:4});
  assert.deepEqual(wordErrorRate('Holder inequality applies', 'Holder inequality may apply'),{errors:2,units:3});
  assert.equal(characterErrorRate('','some text'),null);
  assert.equal(normalizeFormula('\\left( x \\, + 1\\right)'),'('+ 'x+1)');
  assert.notEqual(normalizeFormula('\\int x^2 dx'),normalizeFormula('\\int_0^1 x^2 dx'));
});
test('missing human judgments and costs are unknown rather than invented pass rates or free calls', () => {
  const manifest = validateManifest({version:1,samples:[{id:'integral',kind:'review',split:'acceptance',writerGroup:'expert',sourceGroup:'test',latex:'x',expected:{hasError:true},humanVerified:true}]});
  const report = assess([{sampleId:'integral',status:'ok',elapsedMs:100}],manifest);
  assert.deepEqual(report.reviewDetection,{numerator:0,denominator:0});
  assert.equal(report.estimatedCny,null); assert.equal(report.unknownCostAttempts,1);
  assert.equal(report.timeReductionMedian,null); assert.equal(report.billingReconciled,false);
});
