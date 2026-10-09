import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ButterflySession, LifecycleEpoch, type ButterflyDocument } from '../src/butterfly-session.ts';

const ready = { type: 'mathinkReady', message: { version: 1 } };
const document: ButterflyDocument = { data: [80, 75, 3, 4, 42], revision: 'ink-revision', page: 'default' };
function fixture(initialData?: number[]) {
  const sent: { type: 'mathink'; message: { requestId: string; method: string; payload: unknown } }[] = [];
  const writes: ButterflyDocument[] = [], errors: string[] = [];
  let id = 0;
  const session = new ButterflySession({ newId: () => String(++id), initialData, send: packet => sent.push(packet), persist: async value => { writes.push(value); }, onState: () => {}, onError: error => errors.push(error.message), timeoutMs: 100 });
  const reply = (method: string, result: unknown) => { const request = sent.findLast(packet => packet.message.method === method)!; session.receive({ type: 'mathink', message: { requestId: request.message.requestId, ok: true, result } }); };
  return { session, sent, writes, errors, reply };
}
async function turn(): Promise<void> { await new Promise(resolve => setTimeout(resolve, 0)); }
test('a late manifest epoch cannot activate a frame for a previously selected note or mode', () => {
  const epochs = new LifecycleEpoch(); const original = epochs.begin(); const latest = epochs.begin();
  assert.equal(epochs.current(original), false); assert.equal(epochs.current(latest), true);
  epochs.begin(); assert.equal(epochs.current(latest), false);
});
test('restoring waits for setDocument acknowledgement AND a rebuilt frame ready event before saving', async () => {
  const env = fixture([80, 75, 3, 4, 99]);
  try {
    env.session.receive(ready); assert.equal(env.sent[0].message.method, 'setDocument');
    env.reply('setDocument', { accepted: true }); await turn();
    assert.equal(env.session.ready, false); assert.equal(env.writes.length, 0);
    assert.equal(env.sent.some(packet => packet.message.method === 'getDocument'), false, 'the initial blank document must never overwrite the saved original');
    env.session.receive(ready); await turn(); env.reply('getDocument', document);
    await env.session.whenReady(); assert.equal(env.session.ready, true); assert.deepEqual(env.writes, [document]);
  } finally { env.session.dispose(); }
});
test('a fast rebuilt ready event arriving before the acknowledgement is retained', async () => {
  const env = fixture([80, 75, 3, 4, 99]);
  try { env.session.receive(ready); env.session.receive(ready); env.reply('setDocument', { accepted: true }); await turn(); env.reply('getDocument', document); await env.session.whenReady(); assert.deepEqual(env.writes, [document]); }
  finally { env.session.dispose(); }
});
test('disposed old frames ignore ready events and reject old correlated requests', async () => {
  const env = fixture([80, 75]);
  env.session.receive(ready); env.session.dispose(); env.session.receive(ready); await turn();
  assert.equal(env.session.phase, 'closed'); assert.equal(env.writes.length, 0); assert.equal(env.sent.length, 1); assert.equal(env.errors.length, 0);
});
test('a save in flight persists to its captured note even after the visible note changes', async () => {
  let visible = 'note-a'; const writes: string[] = [];
  const env = fixture();
  try {
    env.session.receive(ready); env.reply('getDocument', document); await env.session.whenReady();
    const target = visible;
    const pending = env.session.save().then(() => writes.push(target)); await turn(); visible = 'note-b';
    env.reply('getDocument', { ...document, data: [...document.data, 7] }); await pending;
    assert.equal(visible, 'note-b'); assert.deepEqual(writes, ['note-a']); assert.equal(env.writes.at(-1)!.data.at(-1), 7);
  } finally { env.session.dispose(); }
});
test('failed final saves keep the session available for retry instead of disposing the original', async () => {
  const env = fixture();
  try {
    env.session.receive(ready); env.reply('getDocument', document); await env.session.whenReady();
    const failed = env.session.flush(); await turn(); const call = env.sent.at(-1)!;
    env.session.receive({ type: 'mathink', message: { requestId: call.message.requestId, ok: false, error: '保存失败' } });
    await assert.rejects(failed, /保存失败/); assert.equal(env.session.ready, true); assert.deepEqual(env.writes, [document]);
    const retry = env.session.flush(); await turn(); env.reply('getDocument', { ...document, data: [...document.data, 8] }); await retry; assert.equal(env.writes.at(-1)!.data.at(-1), 8);
  } finally { env.session.dispose(); }
});
