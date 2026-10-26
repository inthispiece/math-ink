import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync } from 'fflate';
import { newNote, exportMarkdown } from '../src/model.ts';
import { ensureNotebook, addPage, createDraft, insertFormulaDraft, duplicatePage } from '../src/notebook-domain.ts';
import { rebindNativePageCopy, synchronizeNativeInstances } from '../src/native-state.ts';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const math = (id = 'element-one', text = '$x^2$', x = 10, y = 20) => ({
  id, type: 'markdown', text, position: { x, y }, extra: { mathink: { latex: 'STALE_METADATA', operationId: 'original-operation' } },
});
const nativePage = (id: string | undefined, content: unknown[] = []) => ({
  layers: [{ id: 'layer-one', content }], extra: id === undefined ? {} : { mathinkPage: { id } },
});
function archive(pages: Record<string, unknown>, extras: Record<string, Uint8Array> = {}): number[] {
  const files: Record<string, Uint8Array> = { 'META-INF/butterfly.json': encode({ type: 'document', fileVersion: 13 }), ...extras };
  for (const [name, page] of Object.entries(pages)) files['BFLY/pages/' + name + '.json'] = encode(page);
  return [...zipSync(files)];
}
function fixture() {
  const note = ensureNotebook(newNote());
  note.inkEngine = 'butterfly';
  const page = note.pages.find(page => page.id === note.currentPageId)!;
  const draft = createDraft(note, { type: 'formula', sourcePageId: page.id, status: 'completed', latex: 'x^2', reviewed: true });
  const placement = insertFormulaDraft(note, draft.id, page.id, { x: 10, y: 20 }, 'operation-one');
  placement.elementId = 'element-one';
  const insertion = note.insertions.find(insertion => insertion.operationId === placement.operationId)!;
  const formula = note.formulas.find(formula => formula.id === insertion.formulaId)!;
  note.butterflyData = archive({ '0.first': nativePage(page.nativePageId, [math()]) });
  return { note, page, draft, placement, insertion, formula };
}

test('native undo/redo preserves canonical and draft identities, filters ghost exports and restores independent actual text', () => {
  const { note, page, draft, placement, insertion, formula } = fixture();
  const originalDraft = structuredClone(draft), originalBlocks = note.blocks.map(block => block.id);
  const updatedAt = note.updatedAt, storageRevision = note.storageRevision;
  note.butterflyData = archive({ '0.first': nativePage(page.nativePageId) });
  const rawMissing = note.butterflyData;
  const result = synchronizeNativeInstances(note);
  assert.equal(result.changed, true);
  assert.deepEqual(result.missingElementIds, ['element-one']);
  assert.ok(placement.deletedAt); assert.equal(insertion.undoneAt, placement.deletedAt);
  assert.equal(draft.uses[0].undoneAt, placement.deletedAt);
  assert.equal(note.formulas[0], formula); assert.deepEqual(note.blocks.map(block => block.id), originalBlocks);
  assert.doesNotMatch(exportMarkdown(note), /x\^2/);
  assert.equal(note.butterflyData, rawMissing);
  assert.equal(note.updatedAt, updatedAt); assert.equal(note.storageRevision, storageRevision);
  const missing = structuredClone(note);
  assert.equal(synchronizeNativeInstances(note).changed, false); assert.deepEqual(note, missing);

  note.butterflyData = archive({ '0.first': nativePage(page.nativePageId, [math('element-one', '$$\\int x^2\\,dx$$', 91, -33)]) });
  const rawRestored = note.butterflyData;
  const restored = synchronizeNativeInstances(note);
  assert.equal(restored.changed, true); assert.equal(placement.deletedAt, undefined);
  assert.equal(insertion.undoneAt, undefined); assert.equal(draft.uses[0].undoneAt, undefined);
  assert.equal(formula.latex, '\\int x^2\\,dx'); assert.equal(placement.latex, formula.latex);
  assert.equal(placement.x, 91); assert.equal(placement.y, -33); assert.equal(insertion.x, 91); assert.equal(insertion.y, -33);
  assert.deepEqual(draft, originalDraft); assert.deepEqual(note.blocks.map(block => block.id), originalBlocks);
  assert.equal(note.butterflyData, rawRestored); assert.equal(note.updatedAt, updatedAt);
  assert.match(exportMarkdown(note), /int x\^2/); assert.equal(synchronizeNativeInstances(note).changed, false);
});

test('bindings are scoped to stable native page IDs, including unvisited pages and old archive names', () => {
  const { note, page, placement, formula } = fixture();
  const second = addPage(note, { nativePageId: 'unvisited' });
  note.butterflyData = archive({ '3.first': nativePage(page.nativePageId), '99.unvisited': nativePage(second.nativePageId, [math()]) });
  assert.deepEqual(synchronizeNativeInstances(note).missingElementIds, ['element-one']);
  assert.ok(placement.deletedAt);
  page.nativePageId = '3.first'; note.butterflyPage = '3.first'; formula.sourcePage = '3.first';
  note.sources.filter(source => source.pageId === page.id).forEach(source => source.nativePageId = '3.first');
  note.butterflyData = archive({ '3.first': nativePage(undefined, [math()]), '99.unvisited': nativePage(second.nativePageId) });
  assert.deepEqual(synchronizeNativeInstances(note).missingPageIds, []); assert.equal(placement.deletedAt, undefined);
});

test('reports missing native host pages without silently changing page deletion status', () => {
  const { note, page, placement } = fixture();
  const second = addPage(note, { nativePageId: 'only-survivor' });
  note.butterflyData = archive({ '0.survivor': nativePage(second.nativePageId) });
  const result = synchronizeNativeInstances(note);
  assert.deepEqual(result.missingPageIds, [page.id]); assert.ok(placement.deletedAt);
  assert.equal(page.deletedAt, undefined); assert.equal(page.nativeMissing, undefined);
});

test('a malformed unvisited page rejects whole synchronization before any host changes', () => {
  const { note, page } = fixture();
  note.butterflyData = archive({ '0.first': nativePage(page.nativePageId, [math('element-one', '$CHANGED$', 70, 80)]), '1.bad': { layers: 'corrupt' } });
  const before = structuredClone(note);
  assert.throws(() => synchronizeNativeInstances(note), /页面结构无效/);
  assert.deepEqual(note, before);
});

test('strict native identities, object shape, wrapped math and finite geometry reject atomically', () => {
  const mutations: { pages?: Record<string, unknown>; element?: unknown; error: RegExp }[] = [
    { pages: { first: nativePage('duplicate'), second: nativePage('duplicate') }, error: /页面身份重复/ },
    { element: [math(), math()], error: /对象身份重复/ },
    { element: [{ ...math(), type: 'future-invalid-type' }], error: /对象身份重复或无效/ },
    { element: [{ ...math(), type: 'text' }], error: /已不是/ },
    { element: [math('element-one', 'ordinary paragraph')], error: /普通文本/ },
    { element: [math('element-one', '$x$', Infinity)], error: /位置无效/ },
    { element: [{ ...math(), extra: {} }], error: /已不是/ },
  ];
  for (const mutation of mutations) {
    const { note, page } = fixture();
    note.butterflyData = archive(mutation.pages || { first: nativePage(page.nativePageId, mutation.element as unknown[]) });
    const before = structuredClone(note);
    assert.throws(() => synchronizeNativeInstances(note), mutation.error); assert.deepEqual(note, before);
  }
});

test('invalid ZIP, metadata and oversized page JSON reject without interpreting data as an empty page', () => {
  const { note, page } = fixture();
  const badArchives = [
    [1, 2, 3],
    archive({ first: nativePage(page.nativePageId) }, { 'META-INF/butterfly.json': encode({ type: 'unknown' }) }),
    archive({ first: { ...nativePage(page.nativePageId), excess: 'x'.repeat(8 * 1024 * 1024) } }),
  ];
  for (const bad of badArchives) {
    note.butterflyData = bad; const before = structuredClone(note);
    assert.throws(() => synchronizeNativeInstances(note), /原生原稿无法安全核对/); assert.deepEqual(note, before);
  }
});

test('unbound experimental placements are untouched and missing native archives are explicit errors only for bound objects', () => {
  const { note, placement } = fixture();
  delete note.butterflyData;
  const before = structuredClone(note);
  assert.throws(() => synchronizeNativeInstances(note), /缺少/); assert.deepEqual(note, before);
  delete placement.elementId;
  const unbound = structuredClone(note);
  assert.equal(synchronizeNativeInstances(note).changed, false); assert.deepEqual(note, unbound);
});

test('independent math edits never update reusable drafts, source raw ink or another placement instance', () => {
  const { note, page, draft, placement, formula } = fixture();
  const sibling = insertFormulaDraft(note, draft.id, page.id, { x: 50, y: 60 }, 'operation-two');
  sibling.elementId = 'element-two';
  const siblingBefore = structuredClone(sibling), draftBefore = structuredClone(draft);
  note.butterflyData = archive({ first: nativePage(page.nativePageId, [math('element-one', '\\(x^3\\)', 11, 22), math('element-two', '$x^2$', 50, 60), { type: 'pen', id: 'raw-ink', points: [{ x: 1, y: 2, pressure: 0.8 }] }]) });
  const raw = note.butterflyData;
  assert.deepEqual(synchronizeNativeInstances(note).updatedPlacementIds, [placement.id]);
  assert.equal(formula.latex, 'x^3'); assert.deepEqual(sibling, siblingBefore); assert.deepEqual(draft, draftBefore); assert.equal(note.butterflyData, raw);
});

test('copied native pages rebind regenerated IDs by verified full element order and preserve independent canonical identities', () => {
  const { note, page, placement, draft } = fixture();
  const copied = duplicatePage(note, page.id, 'native-copy');
  const targetPlacement = note.placements.find(placement => placement.pageId === copied.id)!;
  const before = math(), after = { ...math('copy-one'), position: { y: 20, x: 10 } };
  const pen = { type: 'pen', id: 'raw-source', points: [{ x: 10, y: 20 }] };
  note.butterflyData = archive({ first: nativePage(page.nativePageId, [pen, before]), second: nativePage(copied.nativePageId, [{ ...pen, id: 'raw-clone' }, after]) });
  const sourceInsertion = note.insertions.find(insertion => insertion.operationId === placement.operationId)!;
  const copyInsertion = note.insertions.find(insertion => insertion.operationId === targetPlacement.operationId)!;
  const draftBefore = structuredClone(draft), raw = note.butterflyData;
  assert.notEqual(sourceInsertion.formulaId, copyInsertion.formulaId);
  assert.deepEqual(rebindNativePageCopy(note, page.id, copied.id), { changed: true, updatedPlacementIds: [targetPlacement.id] });
  assert.equal(targetPlacement.elementId, 'copy-one'); assert.equal(placement.elementId, 'element-one');
  assert.equal(rebindNativePageCopy(note, page.id, copied.id).changed, false);
  assert.equal(synchronizeNativeInstances(note).changed, false); assert.deepEqual(draft, draftBefore); assert.equal(note.butterflyData, raw);
});

test('copy geometry or order mismatch rejects all rebinding without guessing at visually similar equations', () => {
  for (const target of [[math('copy-one', '$x^2$', 999, 20)], [math('copy-one'), math('extra')]]) {
    const { note, page } = fixture();
    const copied = duplicatePage(note, page.id, 'native-copy');
    note.butterflyData = archive({ first: nativePage(page.nativePageId, [math()]), second: nativePage(copied.nativePageId, target) });
    const before = structuredClone(note);
    assert.throws(() => rebindNativePageCopy(note, page.id, copied.id), /对象顺序或内容已改变|对象数量不一致/); assert.deepEqual(note, before);
  }
});
