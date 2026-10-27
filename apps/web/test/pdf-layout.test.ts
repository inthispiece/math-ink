import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePageRange,paginateBlocks,PDF_QUALITY} from '../src/pdf-layout.ts';
test('PDF ranges preserve document order, remove duplicates and reject silent omissions',()=>{assert.deepEqual(parsePageRange('3,1-2,2',5),[0,1,2]);assert.deepEqual(parsePageRange('',3),[0,1,2]);for(const v of ['0','6','2-1','1,a','1.5'])assert.throws(()=>parsePageRange(v,5));});
test('long typeset blocks continue at physical readable scale without shrinking the logical page',()=>{const slices=paginateBlocks([{id:'a',height:120},{id:'b',height:1300},{id:'c',height:80}],700);assert.deepEqual(slices.map(p=>p.map(s=>[s.id,s.offset,s.height])),[[['a',0,120]],[['b',0,700]],[['b',700,600],['c',0,80]]]);assert.equal(PDF_QUALITY.print,3);});

test('paragraph line groups that fit one sheet move together rather than splitting at a page boundary',()=>{
 const pages=paginateBlocks([{id:'prior',height:70},{id:'a1',groupId:'paragraph',height:20},{id:'a2',groupId:'paragraph',height:20}],100);
 assert.deepEqual(pages.map(page=>page.map(unit=>unit.id)),[['prior'],['a1','a2']]);
});
test('oversized paragraphs continue at complete line boundaries while keeping font size',()=>{
 const pages=paginateBlocks([{id:'a1',groupId:'long',height:60},{id:'a2',groupId:'long',height:60},{id:'a3',groupId:'long',height:60}],100);
 assert.deepEqual(pages.map(page=>page.map(unit=>unit.id)),[['a1'],['a2'],['a3']]);
 assert.ok(pages.flat().every(unit=>unit.offset===0&&unit.height===60));
});
