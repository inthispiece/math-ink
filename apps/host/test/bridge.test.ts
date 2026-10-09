import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachSiYuanBridge } from '../src/bridge.ts';
import type { ExportRecord } from '../src/siyuan-api.ts';
import type { Note } from '../../web/src/model.ts';

type Reply = { requestId: string; ok: boolean; result?: ExportRecord; error?: string };
type Call = { path: string; body: Record<string, unknown> | FormData };
const sample: Note = {
  id: 'bridge-note-001', title: '积分证明', tags: ['分析'], revision: 2, updatedAt: '2026-10-09T00:00:00Z', markdown: '## 定理\n\n原稿与结论。', strokes: [],
  formulas: [{ id: 'formula-001', latex: 'x^2', sourceStrokeIds: ['stroke-001'], sourceRevision: 2, sourceBounds: { x: 1, y: 2, width: 30, height: 40 }, sourcePage: 'default', createdAt: '2026-10-09T00:00:00Z', provider: 'mock', simulated: true }],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const origin = 'http://mathink.local';
  const descriptors = new Map(['window', 'location', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const listeners = new Set<(event: MessageEvent) => void>();
  const records = new Map<string, ExportRecord>();
  const savedKeys: string[] = [];
  const calls: Call[] = [];
  const detached: (() => void)[] = [];
  let failFormulaAttrs = false;
  let blockCounter = 0;
  const request: typeof fetch = async (input, init) => {
    const path = String(input);
    const body = init?.body instanceof FormData ? init.body : JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ path, body });
    if (path === '/api/asset/upload') {
      const file = (body as FormData).get('file[]') as File;
      return Response.json({ code: 0, data: { succMap: { [file.name]: `assets/snapshot-${calls.length}.json` } } });
    }
    const payload = body as Record<string, unknown>;
    if (path === '/api/filetree/createDocWithMd') return Response.json({ code: 0, data: 'document-001' });
    if (path === '/api/block/appendBlock') return Response.json({ code: 0, data: [{ doOperations: [{ id: `${String(payload.data).startsWith('{{{row') ? 'body' : 'formula'}-${++blockCounter}`, action: 'insert' }] }] });
    if (path === '/api/attr/setBlockAttrs' && (payload.attrs as Record<string, string>)?.['custom-mathink-formula-id'] && failFormulaAttrs) {
      failFormulaAttrs = false;
      return Response.json({ code: -1, msg: '测试：公式属性写入失败', data: null });
    }
    return Response.json({ code: 0, data: null });
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    addEventListener: (type: string, listener: (event: MessageEvent) => void) => { if (type === 'message') listeners.add(listener); },
    removeEventListener: (type: string, listener: (event: MessageEvent) => void) => { if (type === 'message') listeners.delete(listener); },
  } });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin } });
  Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: request });
  function open(options: { notebookId?: () => string; loadRecord?: (key: string) => Promise<ExportRecord | undefined> } = {}) {
    const messages: Reply[] = [];
    const waiters = new Map<string, (reply: Reply) => void>();
    const contentWindow = { postMessage: (reply: Reply, targetOrigin: string) => { assert.equal(targetOrigin, origin); messages.push(reply); waiters.get(reply.requestId)?.(reply); waiters.delete(reply.requestId); } };
    const frame = { contentWindow } as unknown as HTMLIFrameElement;
    const detach = attachSiYuanBridge(frame, {
      notebookId: options.notebookId || (() => 'notebook-001'),
      loadRecord: options.loadRecord || (async key => records.has(key) ? structuredClone(records.get(key)!) : undefined),
      saveRecord: async (key, record) => { savedKeys.push(key); records.set(key, structuredClone(record)); },
      status: () => {},
    });
    detached.push(detach);
    const send = (requestId: string, note: Note = sample, eventOrigin = origin) => {
      const result = new Promise<Reply>(resolve => waiters.set(requestId, resolve));
      const event = { origin: eventOrigin, source: contentWindow, data: { type: 'mathink:siyuan', requestId, action: 'exportNote', payload: { note: structuredClone(note) } } } as unknown as MessageEvent;
      for (const listener of listeners) listener(event);
      return result;
    };
    return { send, detach, messages };
  }
  const close = () => {
    detached.forEach(detach => detach());
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  return { open, close, records, savedKeys, calls, failFormulaAttrs: () => { failFormulaAttrs = true; } };
}

test('closing and reopening a dialog cannot race an active export for the same notebook and note', async () => {
  const env = fixture();
  const started = deferred<void>(), release = deferred<ExportRecord | undefined>();
  try {
    const first = env.open({ loadRecord: async () => { started.resolve(); return release.promise; } });
    const firstReply = first.send('request-first');
    await started.promise;
    first.detach();
    const reopened = env.open();
    const busy = await reopened.send('request-overlapping');
    assert.equal(busy.ok, false);
    assert.match(busy.error!, /正在整理/);
    assert.equal(env.calls.length, 0, 'the overlapping dialog must not even upload another snapshot');
    release.resolve(undefined);
    assert.equal((await firstReply).ok, true);
    const initialAppendCount = env.calls.filter(call => call.path.endsWith('appendBlock')).length;
    assert.equal(initialAppendCount, 2, 'one managed body and one formula are appended');
    assert.equal((await reopened.send('request-after-completion')).ok, true);
    assert.equal(env.calls.filter(call => call.path.endsWith('appendBlock')).length, initialAppendCount, 'a retry after the first export completes reuses both saved block identifiers');
  } finally { release.resolve(undefined); env.close(); }
});

test('changing the notebook selector while the export record loads keeps the original destination and record key', async () => {
  const env = fixture();
  const started = deferred<string>(), release = deferred<ExportRecord | undefined>();
  let selected = 'notebook-original';
  try {
    const dialog = env.open({ notebookId: () => selected, loadRecord: async key => { started.resolve(key); return release.promise; } });
    const reply = dialog.send('request-fixed-target');
    assert.equal(await started.promise, 'notebook-original-bridge-note-001');
    selected = 'notebook-other';
    release.resolve(undefined);
    const result = await reply;
    assert.equal(result.ok, true);
    assert.equal(result.result!.notebookId, 'notebook-original');
    const create = env.calls.find(call => call.path.endsWith('createDocWithMd'))!.body as Record<string, unknown>;
    assert.equal(create.notebook, 'notebook-original');
    assert.ok(env.savedKeys.every(key => key === 'notebook-original-bridge-note-001'));
    assert.equal(env.records.has('notebook-other-bridge-note-001'), false);
  } finally { release.resolve(undefined); env.close(); }
});

test('a partial failure preserves document, body and formula progress; a new dialog retries without duplicate blocks', async () => {
  const env = fixture();
  try {
    env.failFormulaAttrs();
    const initial = env.open();
    const failed = await initial.send('request-partial-failure');
    assert.equal(failed.ok, false);
    assert.match(failed.error!, /公式属性写入失败/);
    const record = env.records.get('notebook-001-bridge-note-001')!;
    assert.ok(record.documentId);
    assert.ok(record.bodyBlockId);
    assert.ok(record.formulaBlockIds['formula-001']);
    const appendCount = env.calls.filter(call => call.path.endsWith('appendBlock')).length;
    const createCount = env.calls.filter(call => call.path.endsWith('createDocWithMd')).length;
    initial.detach();
    const reopened = env.open();
    const note = structuredClone(sample); note.markdown = '## 修正后的定理\n\n最新正文。'; note.formulas[0].latex = 'x^3';
    const result = await reopened.send('request-retry-progress', note);
    assert.equal(result.ok, true);
    assert.equal(result.result!.documentId, record.documentId);
    assert.equal(result.result!.formulaBlockIds['formula-001'], record.formulaBlockIds['formula-001']);
    assert.equal(env.calls.filter(call => call.path.endsWith('appendBlock')).length, appendCount);
    assert.equal(env.calls.filter(call => call.path.endsWith('createDocWithMd')).length, createCount);
    const updates = env.calls.filter(call => call.path.endsWith('updateBlock')).map(call => call.body as Record<string, unknown>);
    assert.ok(updates.some(body => body.id === record.bodyBlockId && String(body.data).includes('最新正文')));
    assert.ok(updates.some(body => body.id === record.formulaBlockIds['formula-001'] && String(body.data).includes('x^3')));
  } finally { env.close(); }
});

test('an invalid request replies with an error and releases its request ID for a corrected retry', async () => {
  const env = fixture();
  try {
    const dialog = env.open();
    const malformed = { ...sample, id: '../invalid' };
    const failed = await dialog.send('request-correctable', malformed);
    assert.equal(failed.ok, false);
    assert.equal(env.calls.length, 0);
    const retried = await dialog.send('request-correctable');
    assert.equal(retried.ok, true);
    assert.equal(dialog.messages.length, 2);
  } finally { env.close(); }
});
