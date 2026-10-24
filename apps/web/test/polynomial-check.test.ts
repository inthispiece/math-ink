import test from 'node:test';
import assert from 'node:assert/strict';
import {checkPolynomial} from '../src/polynomial-check.ts';
test('exact polynomial tool detects the erroneous integral missed by the small model',()=>{
  const result=checkPolynomial('antiderivative','x^2','x^3/2+C');
  assert.equal(result.status,'disproved');
  assert.deepEqual(result.counterexample,{x:'1',left:'1',right:'3/2'});
  assert.equal(checkPolynomial('antiderivative','x^2','x^3/3+C').status,'verified');
});
test('rational identities and unary precedence are exact, not sampled numerical proofs',()=>{
  assert.equal(checkPolynomial('identity','(x+1)^2','x^2+2*x+1').status,'verified');
  assert.equal(checkPolynomial('identity','-x^2','-(x*x)').status,'verified');
  assert.equal(checkPolynomial('identity','0.5*x+x/2','x').status,'verified');
  assert.equal(checkPolynomial('identity','(x-1)*(x-2)','0').status,'disproved');
});
test('unsupported domains and malicious expressions cannot execute or acquire a proof label',()=>{
  for(const expression of ['sin(x)','x/x','x^100000','process.exit()','x^2;fetch(1)','1/0','('.repeat(40)+'x'+')'.repeat(40)]) {
    assert.equal(checkPolynomial('identity',expression,'1').status,'unsupported');
  }
});
