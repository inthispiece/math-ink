import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackup, newNote, parseBackup, exportMarkdown, type Note, type Formula } from '../src/model.ts';
import { applyCheckedSuggestions, applySuggestion, blockText, captureContext, createParagraphBlock, createSuggestion, ensurePageModel, exportLatex, isSuggestionStale, moveBlock, rejectSuggestion, undoSuggestion, updateBlock, updateFormulaLatex, updateLegacyMarkdown } from '../src/page-model.ts';

const formula = (): Formula => ({ id: 'formula-original', latex: '\\int x^2\\,dx', sourceStrokeIds: ['ink-original'], sourceRevision: 3, sourceBounds: { x: 1, y: 2, width: 80, height: 40 }, sourcePage: 'analysis', sourceButterflyRevision: 'native-3', createdAt: '2026-10-01T00:00:00Z', provider: 'deepseek', simulated: false });
function legacy(): Note { return { id: 'note-original', title: '分析', tags: ['积分'], markdown: '## 原文\n\n**不修改** $x$ 与 [[链接]]', formulas: [formula()], strokes: [{ id: 'ink-original', color: '#000', width: 2, points: [{ x: 5, y: 10, pressure: .5 }] }], revision: 3, updatedAt: '2026-10-01T00:00:00Z', butterflyPage: 'analysis', butterflyRevision: 'native-3', butterflyData: [1, 2, 255] }; }
test('schema 1 migration preserves IDs, original Markdown, ink and native source; schema 3 roundtrip is lossless', () => {
  const original = legacy(); const before = structuredClone(original);
  const migrated = parseBackup(JSON.stringify({ format: 'math-ink', schemaVersion: 1, exportedAt: '2026-10-01', notes: [original] }));
  assert.equal(migrated.schemaVersion, 3); const n = ensurePageModel(migrated.notes[0]);
  assert.equal(n.id, before.id); assert.equal(n.formulas[0].id, before.formulas[0].id); assert.deepEqual(n.strokes, before.strokes); assert.deepEqual(n.butterflyData, before.butterflyData);
  assert.equal(n.blocks.find(b => b.type === 'legacy-markdown')!.content.markdown, before.markdown);
  assert.equal(n.sources[0].strokeIds[0], 'ink-original'); assert.equal(n.sources[0].nativeRevision, 'native-3'); assert.equal(n.formulas[0].sourceRefId, n.sources[0].id); assert.equal(n.contentRevision, 0);
  const restored = parseBackup(JSON.stringify(createBackup([n]))); assert.deepEqual(restored.notes[0], n);
  assert.deepEqual(original, before, 'parsing does not mutate caller data');
});
test('strict imports reject bad references, duplicate IDs and future versions without altering original notes', () => {
  const n = newNote(), block = createParagraphBlock(n, 'safe'); const good = createBackup([n]), before = structuredClone(n);
  const bad = structuredClone(good); bad.notes[0].blocks![0].content = { runs: [{ type: 'formula', formulaId: 'missing' }] };
  assert.throws(() => parseBackup(JSON.stringify(bad)), /行内公式/); assert.deepEqual(n, before);
  const dangling = structuredClone(good); dangling.notes[0].pages![0].blockOrder = ['missing']; assert.throws(() => parseBackup(JSON.stringify(dangling)), /页面顺序/);
  const duplicated = structuredClone(good); duplicated.notes[0].blocks!.push(structuredClone(block)); assert.throws(() => parseBackup(JSON.stringify(duplicated)), /重复/);
  assert.throws(() => parseBackup(JSON.stringify({ ...good, schemaVersion: 4 })), /备份版本/);
  const duplicateLatex = structuredClone(good); (duplicateLatex.notes[0].blocks![0].content as Record<string, unknown>).latex = 'untracked'; assert.throws(() => parseBackup(JSON.stringify(duplicateLatex)), /LaTeX/);
});
test('Markdown and saved formula edits increase independent content and block revisions; ink revision is retained', () => {
  const n = ensurePageModel(legacy()), inkRevision = n.revision, markdownBlock = n.blocks.find(b => b.type === 'legacy-markdown')!, formulaBlock = n.blocks.find(b => b.type === 'formula')!;
  updateLegacyMarkdown(n, 'edited'); assert.equal(n.contentRevision, 1); assert.equal(markdownBlock.revision, 1); assert.equal(n.revision, inkRevision);
  updateFormulaLatex(n, n.formulas[0].id, 'x^2'); assert.equal(n.contentRevision, 2); assert.equal(formulaBlock.revision, 1); assert.equal(n.revision, inkRevision);
  n.markdown = 'direct legacy UI edit'; n.formulas[0].latex = 'x^3'; ensurePageModel(n); assert.equal(n.contentRevision, 3); assert.equal(markdownBlock.revision, 2); assert.equal(formulaBlock.revision, 2);
  ensurePageModel(n); assert.equal(n.contentRevision, 3, 'normalizing an unchanged note is idempotent');
});
test('inline formula uses the single editable Formula source; editing it invalidates contextual suggestions', () => {
  const n = ensurePageModel(legacy()), paragraph = createParagraphBlock(n, 'Let '), other = createParagraphBlock(n, 'then');
  updateBlock(n, paragraph.id, { content: { runs: [{ type: 'text', text: 'Let ' }, { type: 'formula', formulaId: n.formulas[0].id }] } });
  const s = createSuggestion(n, { targetBlockId: other.id, proposed: { runs: [{ type: 'text', text: 'therefore' }] }, reason: 'context', contextBlockIds: [paragraph.id] });
  updateFormulaLatex(n, n.formulas[0].id, 'y^2'); assert.equal(blockText(n, paragraph), 'Let y^2'); assert.equal(isSuggestionStale(n, s), true); assert.equal(applySuggestion(n, s.id), false);
  assert.match(exportMarkdown(n), /Let \$y\^2\$/); assert.doesNotMatch(JSON.stringify(paragraph.content), /y\^2/);
});
test('suggestion apply is explicit, rejection preserves content, undo restores original without overwriting newer edits', () => {
  const n = newNote(), block = createParagraphBlock(n, 'original');
  const proposal = () => createSuggestion(n, { targetBlockId: block.id, proposed: { runs: [{ type: 'text', text: 'corrected' }] }, reason: 'test' });
  const rejected = proposal(); assert.equal(blockText(n, block), 'original'); assert.equal(rejectSuggestion(n, rejected.id), true); assert.equal(applySuggestion(n, rejected.id), false);
  const accepted = proposal(); assert.equal(applySuggestion(n, accepted.id), true); assert.equal(blockText(n, block), 'corrected'); assert.equal(undoSuggestion(n, accepted.id), true); assert.equal(blockText(n, block), 'original');
  const accepted2 = proposal(); assert.equal(applySuggestion(n, accepted2.id), true); updateBlock(n, block.id, { content: { runs: [{ type: 'text', text: 'newer human edit' }] } }); assert.equal(undoSuggestion(n, accepted2.id), false); assert.equal(blockText(n, block), 'newer human edit');
});
test('formula suggestion changes only canonical LaTeX and can undo; newer formula edits prevent undo', () => {
  const n = ensurePageModel(legacy()), block = n.blocks.find(b => b.type === 'formula')!;
  const s = createSuggestion(n, { targetBlockId: block.id, proposed: block.content, proposedLatex: '\\frac{x^3}{3}+C', reason: 'integral' });
  assert.equal(applySuggestion(n, s.id), true); assert.equal(n.formulas[0].latex, '\\frac{x^3}{3}+C'); assert.equal(undoSuggestion(n, s.id), true); assert.equal(n.formulas[0].latex, '\\int x^2\\,dx');
  const next = createSuggestion(n, { targetBlockId: block.id, proposed: block.content, proposedLatex: 'x^3', reason: 'second' }); assert.equal(applySuggestion(n, next.id), true); updateFormulaLatex(n, n.formulas[0].id, 'human'); assert.equal(undoSuggestion(n, next.id), false); assert.equal(n.formulas[0].latex, 'human');
});
test('only checked valid suggestions apply; context changes and deletions invalidate snapshots', () => {
  const n = newNote(), a = createParagraphBlock(n, 'a'), b = createParagraphBlock(n, 'b');
  const sa = createSuggestion(n, { targetBlockId: a.id, proposed: { runs: [{ type: 'text', text: 'A' }] }, reason: 'a' }); const sb = createSuggestion(n, { targetBlockId: b.id, proposed: { runs: [{ type: 'text', text: 'B' }] }, reason: 'b' });
  const result = applyCheckedSuggestions(n, [sa.id]); assert.deepEqual(result.applied, [sa.id]); assert.equal(sb.status, 'pending'); assert.equal(blockText(n, b), 'b');
  const snap = captureContext(n, [b.id]); assert.equal(snap.blocks[b.id], b.revision); updateBlock(n, b.id, { content: { runs: [{ type: 'text', text: 'new' }] } }); assert.deepEqual(applyCheckedSuggestions(n, [sb.id]).skipped, [sb.id]);
});
test('batch accepts independently targeted suggestions sharing a valid initial context; same target conflicts skip', () => {
  const n = newNote(), a = createParagraphBlock(n, 'a'), b = createParagraphBlock(n, 'b');
  const sa = createSuggestion(n, { targetBlockId: a.id, proposed: { runs: [{ type: 'text', text: 'A' }] }, reason: 'a', contextBlockIds: [a.id, b.id] });
  const sb = createSuggestion(n, { targetBlockId: b.id, proposed: { runs: [{ type: 'text', text: 'B' }] }, reason: 'b', contextBlockIds: [a.id, b.id] });
  const conflict = createSuggestion(n, { targetBlockId: a.id, proposed: { runs: [{ type: 'text', text: 'another A' }] }, reason: 'conflict' });
  assert.deepEqual(applyCheckedSuggestions(n, [sa.id, sb.id, conflict.id]), { applied: [sa.id, sb.id], skipped: [conflict.id] });
  assert.equal(blockText(n, a), 'A'); assert.equal(blockText(n, b), 'B');
});
test('inline-only formulas do not generate duplicate standalone blocks', () => {
  const n = newNote(), f = formula(); f.inline = true; n.formulas.push(f); const paragraph = createParagraphBlock(n, '');
  updateBlock(n, paragraph.id, { content: { runs: [{ type: 'text', text: 'Inline ' }, { type: 'formula', formulaId: f.id }] } });
  assert.equal(ensurePageModel(n).blocks.length, 1); assert.equal(blockText(n, paragraph), `Inline ${f.latex}`); assert.equal((exportMarkdown(n).match(/\\int/g) || []).length, 1);
});
test('Butterfly text-only source changes invalidate suggestions without changing original ink revision', () => {
  const n = ensurePageModel(legacy()); n.butterflyContentRevisions = { analysis: 'full-before' }; const target = n.blocks.find(b => b.type === 'legacy-markdown')!;
  const suggestion = createSuggestion(n, { targetBlockId: target.id, proposed: { markdown: 'changed' }, reason: 'page context' });
  assert.deepEqual(suggestion.snapshot.sourcePages, { analysis: 'full-before' }); const inkRevision = n.revision; n.butterflyContentRevisions.analysis = 'full-text-only-change';
  assert.equal(n.revision, inkRevision); assert.equal(isSuggestionStale(n, suggestion), true); assert.equal(applySuggestion(n, suggestion.id), false); assert.deepEqual(applyCheckedSuggestions(n, [suggestion.id]).skipped, [suggestion.id]);
  const roundtrip = parseBackup(JSON.stringify(createBackup([n]))); assert.deepEqual(roundtrip.notes[0].butterflyContentRevisions, n.butterflyContentRevisions); assert.deepEqual(roundtrip.notes[0].suggestions![0].snapshot.sourcePages, { analysis: 'full-before' });
});
test('adding a context block or changing reading order invalidates earlier suggestions', () => {
  const n = newNote(), a = createParagraphBlock(n, 'first'), b = createParagraphBlock(n, 'second');
  const suggestion = () => createSuggestion(n, { targetBlockId: a.id, proposed: { runs: [{ type: 'text', text: 'new' }] }, reason: 'page context', contextBlockIds: [a.id, b.id] });
  const beforeAdd = suggestion(); createParagraphBlock(n, 'new missing condition'); assert.equal(isSuggestionStale(n, beforeAdd), true);
  const beforeMove = suggestion(), version = b.revision; moveBlock(n, b.id, -1); assert.equal(b.revision, version + 1); assert.equal(applySuggestion(n, beforeMove.id), false);
});
test('ordered exports preserve source IDs and user block order', () => {
  const n = ensurePageModel(legacy()), tail = createParagraphBlock(n, 'last'); moveBlock(n, tail.id, -100);
  assert.ok(exportMarkdown(n).indexOf('last') < exportMarkdown(n).indexOf('## 原文')); assert.match(exportMarkdown(n), /来源标识/); assert.match(exportLatex(n, { includeSources: true }), /MathInk block/); assert.match(exportLatex(n), /\\int x\^2/);
});

function inlineNote() {
  const n = newNote(), first = { ...formula(), id: 'inline-one', latex: 'x^2', inline: true }, second = { ...formula(), id: 'inline-two', latex: 'y^2', inline: true };
  n.formulas.push(first, second);
  const target = createParagraphBlock(n, '');
  updateBlock(n, target.id, { content: { runs: [{ type: 'text', text: 'Given ' }, { type: 'formula', formulaId: first.id }, { type: 'text', text: ' and ' }, { type: 'formula', formulaId: second.id }] } });
  return { n: ensurePageModel(n), target, first, second };
}
test('inline mathematical suggestions preview without mutation and atomically update canonical formulas, shared revisions and undo', () => {
  const { n, target, first, second } = inlineNote(), shared = createParagraphBlock(n, '');
  updateBlock(n, shared.id, { content: { runs: [{ type: 'formula', formulaId: first.id }] } });
  const originalContent = structuredClone(target.content), originalInkRevision = n.revision;
  const proposed = { runs: [{ type: 'text' as const, text: 'Therefore ' }, { type: 'formula' as const, formulaId: first.id }, { type: 'text' as const, text: ' and ' }, { type: 'formula' as const, formulaId: second.id }] };
  const changes = [{ formulaId: first.id, originalLatex: 'x^2', proposedLatex: 'x^3' }, { formulaId: second.id, originalLatex: 'y^2', proposedLatex: 'y^3' }];
  const s = createSuggestion(n, { targetBlockId: target.id, proposed, inlineFormulaChanges: changes, category: 'mathematics', reason: 'explicit inline mathematical correction' });
  assert.equal(first.latex, 'x^2'); assert.equal(second.latex, 'y^2'); assert.deepEqual(target.content, originalContent);
  assert.deepEqual(s.snapshot.formulas, { [first.id]: 'x^2', [second.id]: 'y^2' });
  changes[0].proposedLatex = 'caller mutation'; assert.equal(s.inlineFormulaChanges![0].proposedLatex, 'x^3');
  const version = n.contentRevision, targetVersion = target.revision, sharedVersion = shared.revision;
  assert.equal(applySuggestion(n, s.id), true); assert.equal(first.latex, 'x^3'); assert.equal(second.latex, 'y^3');
  assert.equal(blockText(n, target), 'Therefore x^3 and y^3'); assert.equal(blockText(n, shared), 'x^3');
  assert.equal(n.contentRevision, version + 1); assert.equal(target.revision, targetVersion + 1); assert.equal(shared.revision, sharedVersion + 1); assert.equal(n.revision, originalInkRevision);
  ensurePageModel(n); assert.equal(n.contentRevision, version + 1, 'all formula-dependent hashes are committed together');
  assert.doesNotMatch(JSON.stringify(target.content), /x\^3|y\^3/); assert.equal(first.sourceStrokeIds[0], 'ink-original');
  assert.equal(undoSuggestion(n, s.id), true); assert.equal(first.latex, 'x^2'); assert.equal(second.latex, 'y^2'); assert.deepEqual(target.content, originalContent); assert.equal(blockText(n, shared), 'x^2');
  ensurePageModel(n); assert.equal(n.contentRevision, version + 2);
});
test('inline suggestion edits reject foreign, duplicated, stale and structural formula changes before creating a proposal', () => {
  const { n, target, first, second } = inlineNote(), initialCount = n.suggestions.length;
  const base = { targetBlockId: target.id, proposed: target.content, reason: 'test' };
  for (const inlineFormulaChanges of [
    [{ formulaId: 'not-referenced', originalLatex: 'x', proposedLatex: 'z' }],
    [{ formulaId: first.id, originalLatex: 'old', proposedLatex: 'z' }],
    [{ formulaId: first.id, originalLatex: 'x^2', proposedLatex: 'z' }, { formulaId: first.id, originalLatex: 'x^2', proposedLatex: 'different' }],
  ]) assert.throws(() => createSuggestion(n, { ...base, inlineFormulaChanges }), /行内公式/);
  for (const runs of [
    [{ type: 'text' as const, text: 'flattened x^2 y^2' }],
    [{ type: 'formula' as const, formulaId: second.id }, { type: 'formula' as const, formulaId: first.id }],
    [...target.content.runs!, { type: 'formula' as const, formulaId: first.id }],
  ]) assert.throws(() => createSuggestion(n, { ...base, proposed: { runs } }), /新增、删除或重排/);
  assert.equal(n.suggestions.length, initialCount); assert.equal(first.latex, 'x^2'); assert.equal(second.latex, 'y^2');
});
test('inline suggestion apply and undo refuse stale or conflicting formulas without partially changing another formula or paragraph', () => {
  const { n, target, first, second } = inlineNote();
  const make = () => createSuggestion(n, { targetBlockId: target.id, proposed: { runs: [{ type: 'text', text: 'edited ' }, { type: 'formula', formulaId: first.id }, { type: 'formula', formulaId: second.id }] }, inlineFormulaChanges: [{ formulaId: first.id, originalLatex: first.latex, proposedLatex: 'X' }, { formulaId: second.id, originalLatex: second.latex, proposedLatex: 'Y' }], reason: 'test' });
  const stale = make(), original = structuredClone(target.content); updateFormulaLatex(n, second.id, 'new human formula');
  assert.equal(applySuggestion(n, stale.id), false); assert.equal(first.latex, 'x^2'); assert.deepEqual(target.content, original);
  const conflict = make(); conflict.inlineFormulaChanges![1].originalLatex = 'tampered expected value';
  assert.equal(applySuggestion(n, conflict.id), false); assert.equal(first.latex, 'x^2'); assert.equal(second.latex, 'new human formula'); assert.deepEqual(target.content, original);
  const accepted = make(); assert.equal(applySuggestion(n, accepted.id), true); updateFormulaLatex(n, second.id, 'human after adoption');
  assert.equal(undoSuggestion(n, accepted.id), false); assert.equal(first.latex, 'X'); assert.equal(second.latex, 'human after adoption'); assert.equal(blockText(n, target), 'edited Xhuman after adoption');
});
test('checked inline proposals atomically skip shared-formula conflicts while applying independently targeted formulas', () => {
  const { n, first, second } = inlineNote();
  const block = (formulaId: string) => { const b = createParagraphBlock(n, ''); updateBlock(n, b.id, { content: { runs: [{ type: 'formula', formulaId }] } }); return b; };
  const a = block(first.id), b = block(first.id), c = block(second.id);
  const proposal = (target: typeof a, formulaId: string, originalLatex: string, proposedLatex: string) => createSuggestion(n, { targetBlockId: target.id, proposed: target.content, inlineFormulaChanges: [{ formulaId, originalLatex, proposedLatex }], reason: 'checked inline edit' });
  const sa = proposal(a, first.id, 'x^2', 'x^3'), sb = proposal(b, first.id, 'x^2', 'x^4'), sc = proposal(c, second.id, 'y^2', 'y^3');
  assert.deepEqual(applyCheckedSuggestions(n, [sa.id, sb.id, sc.id]), { applied: [sa.id, sc.id], skipped: [sb.id] });
  assert.equal(first.latex, 'x^3'); assert.equal(second.latex, 'y^3'); assert.equal(sb.status, 'pending'); assert.equal(blockText(n, b), 'x^3');
});
test('undo cannot change a hidden formula through a tampered accepted inline patch', () => {
  const { n, target, first, second } = inlineNote();
  const hidden = { ...formula(), id: 'foreign-canonical', latex: 'hidden', inline: true }; n.formulas.push(hidden); ensurePageModel(n);
  const suggestion = createSuggestion(n, { targetBlockId: target.id, proposed: target.content, inlineFormulaChanges: [{ formulaId: first.id, originalLatex: 'x^2', proposedLatex: 'X' }], reason: 'test' });
  assert.equal(applySuggestion(n, suggestion.id), true);
  suggestion.inlineFormulaChanges!.push({ formulaId: hidden.id, originalLatex: 'malicious hidden restore', proposedLatex: 'hidden' });
  assert.equal(undoSuggestion(n, suggestion.id), false); assert.equal(hidden.latex, 'hidden'); assert.equal(first.latex, 'X'); assert.equal(second.latex, 'y^2');
});
