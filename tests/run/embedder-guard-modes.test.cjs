'use strict';
// embedder-guard-modes.test.cjs — the guard under each value of on_embedder_failure (ADR 0034 amendment 1): required pauses the run
// loudly, keyword records and goes on, off records and turns the run memory off; stop and continue are the old names; the mode can
// be chosen at a resume; a warm-up that failed under keyword or off is the run's first event.

const test = require('node:test');
const assert = require('node:assert');
const { createEmbedderGuard } = require('../../src/run/embedder-guard.cjs');

const embedderError = (code = 'E_TIMEOUT') => Object.assign(new Error('the embedder failed'), { code, detail: { embedder: true, cause: 'timeout' } });
const ev = (extra = {}) => ({ caller: { role: 'orchestrator' }, by: 'harness', call: 'memory.store', error: embedderError(), ...extra });

function make(mode) {
  const calls = { pause: [], stop: [] };
  const guard = createEmbedderGuard({ mode, pauseRun: async (why) => { calls.pause.push(why); return {}; }, stopRun: async (why) => { calls.stop.push(why); } });
  return { guard, calls };
}

test('required: any embedder failure pauses the run, naming the call, and the memory stays on', async () => {
  const { guard, calls } = make('required');
  guard.onFailure(ev());
  await guard.settled();
  assert.strictEqual(calls.pause.length, 1);
  assert.match(calls.pause[0], /^embedder-failure \(harness, memory\.store, E_TIMEOUT, timeout\)$/);
  assert.strictEqual(guard.events()[0].action, 'pause');
  assert.strictEqual(guard.memoryOff(), false);
});

test('required: a failure no resume can fix ends the run', async () => {
  const { guard, calls } = make('required');
  guard.onFailure(ev({ error: Object.assign(embedderError('E_MODEL_CHANGED'), { detail: { embedder: true, cause: 'canary' } }) }));
  await guard.settled();
  assert.strictEqual(calls.stop.length, 1);
  assert.deepStrictEqual(calls.pause, []);
  assert.ok(guard.fatal());
});

test('keyword: the failure is recorded and nothing pauses; the memory stays on', async () => {
  const { guard, calls } = make('keyword');
  guard.onFailure(ev());
  await guard.settled();
  assert.deepStrictEqual([calls.pause, calls.stop], [[], []]);
  assert.strictEqual(guard.events()[0].action, 'continue');
  assert.strictEqual(guard.memoryOff(), false);
});

test('off: the failure is recorded, nothing pauses, and the run memory goes off', async () => {
  const { guard, calls } = make('off');
  assert.strictEqual(guard.memoryOff(), false, 'off only once a failure has happened');
  guard.onFailure(ev());
  await guard.settled();
  assert.deepStrictEqual([calls.pause, calls.stop], [[], []]);
  assert.strictEqual(guard.events()[0].action, 'off');
  assert.strictEqual(guard.memoryOff(), true);
});

test('the old names are accepted: stop is required and continue is keyword', async () => {
  assert.strictEqual(make('stop').guard.mode(), 'required');
  assert.strictEqual(make('continue').guard.mode(), 'keyword');
  assert.strictEqual(make('off').guard.mode(), 'off');
  assert.strictEqual(make(undefined).guard.mode(), 'required', 'no mode is the default');
  const { guard, calls } = make('stop');
  guard.onFailure(ev());
  await guard.settled();
  assert.strictEqual(calls.pause.length, 1);
});

test('a caller error is not an embedder failure under any mode', async () => {
  for (const mode of ['required', 'keyword', 'off']) {
    const { guard, calls } = make(mode);
    guard.onFailure(ev({ error: Object.assign(new Error('too long'), { code: 'E_TOO_LONG' }) }));
    await guard.settled();
    assert.deepStrictEqual([calls.pause, guard.events(), guard.memoryOff()], [[], [], false], mode);
  }
});

test('the operator\'s choice at a resume changes the mode: keyword stops pausing, off turns memory off at once, anything else is refused', async () => {
  const a = make('required');
  assert.strictEqual(a.guard.setMode('keyword'), 'keyword');
  a.guard.onFailure(ev());
  await a.guard.settled();
  assert.deepStrictEqual(a.calls.pause, [], 'no pause after choosing keyword');
  const b = make('required');
  assert.strictEqual(b.guard.memoryOff(), false);
  b.guard.setMode('off');
  assert.strictEqual(b.guard.memoryOff(), true, 'choosing off turns memory off without waiting for another failure');
  assert.strictEqual(b.guard.setMode('continue'), 'keyword', 'the old name');
  assert.throws(() => b.guard.setMode('maybe'), /must be one of required, keyword, off/);
  assert.strictEqual(b.guard.mode(), 'keyword', 'a refused choice changes nothing');
});

test('a warm-up that failed under keyword or off is recorded as the run\'s first event', () => {
  const warm = { ok: false, code: 'E_MODEL_ABSENT', cause: 'absent', message: 'the model files are absent' };
  const k = make('keyword').guard;
  k.noteWarmFailure(warm);
  assert.deepStrictEqual([k.events()[0].call, k.events()[0].code, k.events()[0].action, k.memoryOff()], ['warm-up', 'E_MODEL_ABSENT', 'continue', false]);
  const o = make('off').guard;
  o.noteWarmFailure(warm);
  assert.deepStrictEqual([o.events()[0].action, o.memoryOff()], ['off', true]);
});

// ---- the 12 s bound, through the real embedQuery and the real guard ------------------------------------------------
const path = require('node:path');
const { core: coreOf, sandbox, cleanup, callerFor } = require('../core/helpers.cjs');

async function boundedCall(mode) {
  const { Engine } = coreOf('engine.cjs');
  const { Store } = coreOf('store.cjs');
  const rows = coreOf('rows.cjs');
  const dir = sandbox();
  const store = new Store(path.join(dir, 'memory.db'), { stamp: true });
  const { guard, calls } = make(mode);
  let open;
  const gate = new Promise((r) => { open = r; });
  const pending = new Set();
  const embedder = { embed: () => { const p = gate.then(() => ({ embedding: [1, 0], embedding_model: 'stub', embedding_revision: 'r', dim: 2 })); pending.add(p); return p; } };
  const owner = { opts: { onEmbedderFailure: (e) => guard.onFailure(e), embedderMode: () => guard.mode(), memoryOff: () => guard.memoryOff() } };
  const E = new Engine({ dataDir: dir, store, getEmbedder: async () => embedder, owner, establishedBy: 'test' });
  rows.append(store, 'task', { id: 't1', run_id: 'test-run', spec: 'a task about shipping', state: 'open' }, 'orchestrator');
  try {
    const r = await E.handle('memory.embedQuery', { task_id: 't1', worker_id: 'w9', timeout_ms: 500, caller: callerFor('orchestrator', { channel: 'harness' }) });
    await guard.settled();
    return { r, guard, calls };
  } finally { open(); await Promise.allSettled([...pending]); store.close(); cleanup(dir); }
}

test('the spawn-embed bound under required pauses the run, naming the call, the worker and the bound', async () => {
  const { r, calls, guard } = await boundedCall('required');
  assert.strictEqual(r.queries[0].code, 'E_EMBED_BOUND');
  assert.strictEqual(r.on_embedder_failure, 'required');
  assert.deepStrictEqual(calls.pause, ['embedder-failure (w9, memory.embedQuery, E_EMBED_BOUND, timeout)']);
  assert.strictEqual(guard.events()[0].action, 'pause');
});

test('the spawn-embed bound under keyword is recorded and pauses nothing; under off it turns memory off', async () => {
  const k = await boundedCall('keyword');
  assert.deepStrictEqual([k.calls.pause, k.guard.events()[0].action, k.guard.events()[0].code, k.guard.memoryOff()], [[], 'continue', 'E_EMBED_BOUND', false]);
  const o = await boundedCall('off');
  assert.deepStrictEqual([o.calls.pause, o.guard.events()[0].action, o.guard.memoryOff()], [[], 'off', true]);
});
