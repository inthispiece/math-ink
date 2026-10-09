import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SiYuanApi, type ExportRecord } from '../apps/host/src/siyuan-api.ts';
import type { Note } from '../apps/web/src/model.ts';
const note: Note = {
  id: 'note-source-001', title: '积分／证明', tags: ['分析'], revision: 2, updatedAt: '2026-10-09', markdown: '## 定理\n\n连续函数的积分。', strokes: [],
  formulas: [{ id: 'formula-001', latex: '\\int_0^1 x^2 dx=\\frac13', sourceStrokeIds: ['stroke-1'], sourceRevision: 1, sourceBounds: { x: 1, y: 2, width: 100, height: 30 }, createdAt: '2026-10-09', provider: 'mock', simulated: true }]
};
function fakeApi(fail?: string, occurrence = 1) {
  const calls: { path: string; body: any }[] = [];
  const api = new SiYuanApi(async (input, init) => {
    const path = String(input);
    const body = init?.body instanceof FormData ? init.body : JSON.parse(String(init?.body));
    calls.push({ path, body });
    if (fail === path && calls.filter(call => call.path === path).length === occurrence) return Response.json({ code: -1, msg: '磁盘写入失败', data: null });
    let data: unknown = null;
    if (path.endsWith('upload')) { const file = (body as FormData).get('file[]') as File; data = { succMap: { [file.name]: `assets/${file.name}` } }; }
    if (path.endsWith('createDocWithMd')) data = 'document-001';
    if (path.endsWith('appendBlock')) data = [{ doOperations: [{ id: body.data.startsWith('{{{row') ? 'body-001' : 'block-001', action: 'insert' }] }];
    return Response.json({ code: 0, msg: '', data });
  });
  return { api, calls };
}
test('保存原稿后创建公式块并记录可回溯的来源属性', async () => {
  const { api, calls } = fakeApi();
  const record = await api.exportNote(note, 'notebook-001');
  assert.equal(record.formulaBlockIds['formula-001'], 'block-001');
  assert.equal(calls[0].path, '/api/asset/upload');
  const attrs = calls.filter(call => call.path.endsWith('setBlockAttrs')).at(-1)!.body.attrs;
  assert.equal(attrs['custom-mathink-source-stale'], 'true');
  assert.equal(attrs['custom-mathink-source-revision'], '1');
  assert.deepEqual(JSON.parse(attrs['custom-mathink-source-strokes']), ['stroke-1']);
  assert.ok(!calls.some(call => call.path.includes('.sy')));
});
test('重新整理已有公式时更新相同块，不重复插入', async () => {
  const { api, calls } = fakeApi();
  const previous: ExportRecord = { documentId: 'document-001', notebookId: 'notebook-001', bodyBlockId: 'body-001', title: note.title, snapshotAsset: 'assets/old.json', formulaBlockIds: { 'formula-001': 'block-001' } };
  await api.exportNote(note, 'notebook-001', previous);
  assert.ok(calls.some(call => call.path.endsWith('updateBlock')));
  assert.ok(!calls.some(call => call.path.endsWith('appendBlock') || call.path.endsWith('createDocWithMd')));
  assert.ok(calls.find(call => call.path.endsWith('updateBlock') && call.body.id === 'body-001')!.body.data.includes(note.markdown));
});
test('上传失败时不创建笔记或公式块', async () => {
  const { api, calls } = fakeApi('/api/asset/upload');
  await assert.rejects(api.exportNote(note, 'notebook-001'), /磁盘写入失败/);
  assert.equal(calls.length, 1);
});
test('公式属性失败前持久保存块标识，重试不会新增另一块', async () => {
  let exported: ExportRecord | undefined;
  const { api } = fakeApi('/api/attr/setBlockAttrs', 3);
  await assert.rejects(api.exportNote(note, 'notebook-001', undefined, undefined, async record => { exported = structuredClone(record); }));
  assert.equal(exported!.documentId, 'document-001');
  assert.equal(exported!.formulaBlockIds['formula-001'], 'block-001');
  const retry = fakeApi();
  await retry.api.exportNote(note, 'notebook-001', exported);
  assert.equal(retry.calls.filter(call => call.path.endsWith('createDocWithMd')).length, 0);
  assert.equal(retry.calls.filter(call => call.path.endsWith('appendBlock')).length, 0);
});
