import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadExportRecord, saveExportRecord, validateExportRecord } from '../src/plugin-storage.ts';
import type { ExportRecord } from '../src/siyuan-api.ts';

const record: ExportRecord = { documentId: '20261009100000-abcd123', notebookId: '20261009100001-abcd123', snapshotAsset: 'assets/mathink-source.json', formulaBlockIds: { 'formula-1': '20261009100002-abcd123' } };
test('plugin storage treats the public API HTTP 202 code 404 as a missing record', async () => {
  const loaded = await loadExportRecord('math-ink', 'notebook-note', { request: async () => Response.json({ code: 404, msg: '', data: null }, { status: 202 }) });
  assert.equal(loaded, undefined);
});
test('plugin storage validates the actual file content and preserves managed body identifiers', async () => {
  const managed = { ...record, bodyBlockId: '20261009100003-abcd123' };
  const loaded = await loadExportRecord('math-ink', 'notebook-note', { request: async () => Response.json(managed) });
  assert.deepEqual(loaded, managed);
  assert.throws(() => validateExportRecord({ ...record, formulaBlockIds: { broken: null } }), /损坏/);
  await assert.rejects(loadExportRecord('math-ink', 'notebook-note', { request: async () => Response.json({ code: 403, msg: '无访问权限' }, { status: 202 }) }), /无访问权限/);
});
test('plugin storage checks nonzero write result instead of marking it durable', async () => {
  await assert.rejects(saveExportRecord('math-ink', 'notebook-note', record, { request: async () => Response.json({ code: -1, msg: '磁盘写入失败' }) }), /磁盘写入失败/);
});
test('plugin storage writes only to a stable encoded file inside the plugin directory', async () => {
  let body: FormData | undefined;
  await saveExportRecord('math-ink', 'notebook-note/../formula', record, { request: async (_input, init) => { body = init!.body as FormData; return Response.json({ code: 0 }); } });
  assert.equal(body!.get('path'), '/data/storage/petal/math-ink/exports-notebook-note%2F..%2Fformula.json');
  assert.equal(body!.get('isDir'), 'false');
  assert.deepEqual(JSON.parse(await (body!.get('file') as File).text()), record);
  await assert.rejects(saveExportRecord('../math-ink', 'key', record), /名称无效/);
});
test('plugin storage times out even if a broken fetch implementation ignores abort', async () => {
  await assert.rejects(loadExportRecord('math-ink', 'notebook-note', { timeoutMs: 5, request: async () => new Promise(() => {}) }), /超时/);
});
