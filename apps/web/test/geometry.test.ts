import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundsOf, containsPoint, distanceToSegment, hitStroke, selectedStrokes } from '../src/geometry.ts';
import { bumpRevision, exportMarkdown, isStale, newId, parseBackup, type Formula, type Note } from '../src/model.ts';

const stroke = (id: string, x: number) => ({ id, color: '#111', width: 3, points: [{ x, y: 10, pressure: 0.5 }, { x: x + 8, y: 20, pressure: 0.7 }] });
test('lasso chooses intended ink and leaves unrelated strokes out', () => {
  const polygon = [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 40 }, { x: 0, y: 40 }];
  assert.equal(containsPoint({ x: 15, y: 15 }, polygon), true);
  assert.equal(containsPoint({ x: 50, y: 15 }, polygon), false);
  assert.deepEqual(selectedStrokes([stroke('inside', 10), stroke('outside', 100)], polygon).map(s => s.id), ['inside']);
  assert.deepEqual(selectedStrokes([stroke('inside', 10)], polygon.slice(0, 2)), []);
});
test('cropping bounds cover selected ink with padding only', () => {
  assert.equal(boundsOf([]), null);
  const bounds = boundsOf([stroke('inside', 10)], 10)!;
  assert.equal(bounds.x, -1.5);
  assert.equal(bounds.y, -1.5);
  assert.equal(bounds.width, 31);
  assert.equal(bounds.height, 33);
});
test('lasso includes a sparse line crossing the selection even when endpoints lie outside', () => {
  const crossing = { id: 'cross', color: '#111', width: 3, points: [{ x: -10, y: 15, pressure: 0.5 }, { x: 50, y: 15, pressure: 0.5 }] };
  const polygon = [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 30 }, { x: 0, y: 30 }];
  assert.deepEqual(selectedStrokes([crossing], polygon).map(s => s.id), ['cross']);
});
test('large handwriting pages do not overflow argument stack', () => {
  const ink = stroke('large', 0);
  ink.points = Array.from({ length: 180000 }, (_, index) => ({ x: index, y: index % 20, pressure: 0.5 }));
  assert.equal(boundsOf([ink], 0)!.width, 180002);
});
test('eraser removes strokes touching a path, including a single-point dot', () => {
  assert.equal(distanceToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 3);
  assert.equal(hitStroke(stroke('line', 10), { x: 12, y: 12 }, 2), true);
  assert.equal(hitStroke(stroke('line', 10), { x: 100, y: 12 }, 2), false);
  assert.equal(hitStroke({ id: 'dot', color: '#111', width: 3, points: [{ x: 5, y: 5, pressure: 0.5 }] }, { x: 5, y: 5 }, 1), true);
});
const formula: Formula = { id: 'formula-1', latex: '\\int_0^1 x^2 dx', sourceStrokeIds: ['stroke-1'], sourceRevision: 3, sourceBounds: { x: 10, y: 10, width: 30, height: 30 }, createdAt: '2026-10-09T00:00:00Z', provider: 'mock', simulated: true };
const example: Note = { id: 'note-1', title: '积分', tags: ['分析'], strokes: [stroke('stroke-1', 10)], formulas: [formula], markdown: '## 定义\n正文', revision: 3, updatedAt: '2026-10-09T00:00:00Z' };
test('formula retains source revision and becomes stale only after ink revision changes', () => {
  const note = structuredClone(example); assert.equal(isStale(note, formula), false); note.title = '标题修改'; assert.equal(isStale(note, formula), false); bumpRevision(note); assert.equal(isStale(note, formula), true); assert.equal(formula.sourceRevision, 3);
});
test('backup validation preserves editable strokes and source references', () => {
  const backup = parseBackup(JSON.stringify({ format: 'math-ink', schemaVersion: 1, exportedAt: '2026-10-09', notes: [example] }));
  assert.equal(backup.notes[0].strokes[0].id, formula.sourceStrokeIds[0]);
  assert.throws(() => parseBackup('{"format":"math-ink","schemaVersion":2,"notes":[]}'), /备份版本/);
  const malformed = structuredClone(example); malformed.strokes[0].points[0].x = NaN;
  assert.throws(() => parseBackup(JSON.stringify({ format: 'math-ink', schemaVersion: 1, notes: [malformed] })), /无效笔迹/);
  assert.throws(() => parseBackup(JSON.stringify({ format: 'math-ink', schemaVersion: 1, notes: [{ ...example, updatedAt: null }] })), /无效的笔记/);
  assert.throws(() => parseBackup(JSON.stringify({ format: 'math-ink', schemaVersion: 1, notes: [example, example] })), /重复/);
});
test('Markdown export includes formulas and original revision for source tracing', () => {
  const text = exportMarkdown(example); assert.match(text, /# 积分/); assert.match(text, /\\int_0\^1/); assert.match(text, /修订 3/);
});
test('new source-page metadata round trips while older schema-1 formulas remain compatible', () => {
  const current = structuredClone(example); current.formulas[0].sourcePage = 'lecture-2'; current.formulas[0].sourceButterflyRevision = 'f'.repeat(64);
  const restored = parseBackup(JSON.stringify({ format: 'math-ink', schemaVersion: 1, notes: [current] }));
  assert.equal(restored.notes[0].formulas[0].sourcePage, 'lecture-2');
  assert.match(exportMarkdown(restored.notes[0]), /页 lecture-2/);
  assert.equal(parseBackup(JSON.stringify({ format: 'math-ink', schemaVersion: 1, notes: [example] })).notes[0].formulas[0].sourcePage, undefined);
});
test('Butterfly source staleness compares ink revisions within its original page', () => {
  const note = structuredClone(example);
  const hash = 'a'.repeat(64);
  const source = { ...formula, butterfly: true, sourcePage: 'lecture-1', sourceButterflyRevision: hash };
  note.butterflyPageRevisions = { 'lecture-1': hash, 'lecture-2': 'b'.repeat(64) };
  note.butterflyPage = 'lecture-2'; note.butterflyRevision = 'b'.repeat(64); bumpRevision(note);
  assert.equal(isStale(note, source), false, 'navigating to another page or editing that page must not change the original source');
  note.butterflyPageRevisions['lecture-1'] = 'c'.repeat(64);
  assert.equal(isStale(note, source), true);
  assert.equal(isStale(note, formula), true, 'legacy formulas still compare numeric revisions');
});
test('backup rejects path-bearing note IDs before they can become plugin storage names', () => {
  assert.throws(() => parseBackup(JSON.stringify({ format: 'math-ink', schemaVersion: 1, notes: [{ ...example, id: '../note' }] })), /无效的笔记/);
});
test('IDs are standard random UUIDs suitable for insecure LAN origins', () => {
  const id = newId(); assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/); assert.notEqual(newId(), id);
});
test('LAN fallback creates valid IDs when randomUUID is unavailable', () => {
  const previous = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
  Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
  try { assert.match(newId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/); }
  finally { if (previous) Object.defineProperty(crypto, 'randomUUID', previous); else delete (crypto as Partial<Crypto>).randomUUID; }
});
