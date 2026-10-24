import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizedSourceBounds, parseButterflyPage } from '../src/page-render.ts';

test('a normalized source maps to the complete offscreen page coordinates', () => {
  const page = { bounds: { x: -500, y: 700, width: 2000, height: 4000 } };
  assert.deepEqual(normalizedSourceBounds(page, { x: 0.5, y: 0.25, width: 0.2, height: 0.1 }), { x: 500, y: 1700, width: 400, height: 400 });
  assert.throws(() => normalizedSourceBounds(page, { x: 0.9, y: 0.2, width: 0.2, height: 0.1 }), /坐标无效/);
});
test('full page bridge requires a coordinate transform and provenance', () => {
  const valid = { pngBase64: 'AAAA', bounds: { x: 10, y: 30, width: 500, height: 700 }, strokeIds: ['offscreen'], page: 'page-two', revision: 'whole-page-revision', inkRevision: 'ink-revision', transform: { offsetX: 10, offsetY: 30, scaleX: 2, scaleY: 2 } };
  assert.equal(parseButterflyPage(valid).page, 'page-two');
  assert.equal(parseButterflyPage(valid).inkRevision, 'ink-revision');
  assert.throws(() => parseButterflyPage({ ...valid, transform: undefined }), /完整页/);
  assert.throws(() => parseButterflyPage({ ...valid, page: '' }), /完整页/);
});
