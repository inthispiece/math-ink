import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newNote } from '../src/model.ts';
import { createParagraphBlock, ensurePageModel, removeBlock, updateBlock } from '../src/page-model.ts';
import { addLink, backlinks, linkState, resolveLink, searchNotes } from '../src/knowledge.ts';
test('local full text searches body, formula and tags and obeys selected note scope', () => {
  const a = newNote(), b = newNote(); a.title = '微积分'; a.tags = ['分析']; b.title = '线性代数'; createParagraphBlock(a, '积分 integral'); createParagraphBlock(b, '矩阵 matrix');
  assert.equal(searchNotes([a, b], 'integral')[0].noteId, a.id); assert.equal(searchNotes([a, b], '分析')[0].noteId, a.id); assert.equal(searchNotes([a, b], 'matrix', { noteIds: [a.id] }).length, 0);
  const formulaId = 'norm'; b.formulas.push({ id: formulaId, latex: '\\lVert A \\rVert', sourceStrokeIds: [], sourceBounds: { x: 0, y: 0, width: 1, height: 1 }, sourceRevision: 0, createdAt: new Date().toISOString(), provider: 'manual', simulated: false }); ensurePageModel(b); assert.equal(searchNotes([a, b], 'lVert')[0].noteId, b.id);
});
test('manual links resolve stable blocks, show backlinks and become changed or broken without stale search results', () => {
  const a = newNote(), b = newNote(), source = createParagraphBlock(a, 'proof'), target = createParagraphBlock(b, 'theorem-original');
  const link = addLink(a, { sourceBlockId: source.id, targetNoteId: b.id, targetBlockId: target.id, relation: 'theorem', targetRevision: target.revision });
  assert.equal(linkState([a, b], link), 'valid'); assert.equal(resolveLink([a, b], link)!.block.id, target.id); assert.deepEqual(backlinks([a, b], b.id, target.id), [link]);
  updateBlock(b, target.id, { content: { runs: [{ type: 'text', text: 'new theorem' }] } }); assert.equal(linkState([a, b], link), 'changed'); assert.equal(searchNotes([a, b], 'theorem-original').length, 0);
  removeBlock(b, target.id); assert.equal(linkState([a, b], link), 'broken'); assert.equal(resolveLink([a, b], link), null); assert.equal(backlinks([a, b], b.id).length, 1, 'keep inspectable broken relation'); assert.equal(searchNotes([a, b], 'new theorem').length, 0);
});
