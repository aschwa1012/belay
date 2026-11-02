'use strict';
// gpu-followups.test.cjs — queued requests behind a slow load, probe samples that never mark the child hung, the
// full-batch judgement and the slow-chunk warning, and the lock's bounded rename. Fake and stub children; no GPU.
// A product bound is asserted on an injected clock (helpers/fake-timers.cjs); a fake child REPORTS the times it is
// scripted with, it never measures them.

process.env.BELAY_TEST_MODE = '1';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, FIXTURES, deadPid } = require('./helpers.cjs');
const { writeStubRuntime, writeCache } = require('./fixtures/gpu-stub-runtime.cjs');
const { waitEvent, countProgress, UP_DEADLINE } = require('../helpers/wait.cjs');
const { fakeTimers, outcome } = require('../helpers/fake-timers.cjs');

const P = core('gpu-probe.cjs');
const R = core('gpu-runtime.cjs');
const { GpuClient } = core('gpu.cjs');
const FAKE = path.join(FIXTURES, 'gpu-worker-fake.cjs');
const SHA = 'a'.repeat(40), H = 'b'.repeat(64);
const entry = (id, kind, extra) => ({ id, sha: SHA, runtime: 'gguf', kind, label: id, files: [{ path: 'm.gguf', bytes: 10, sha256: H }], pooling: kind === 'embedder' ? 'last' : null, query_prompt: '', document_prompt: '', native_dims: kind === 'embedder' ? 4 : null, dims: kind === 'embedder' ? 4 : null, license: 'apache-2.0', context_size: 2048, vram_mb_ref: 500, ...extra });
const TABLE = { 'org/emb': entry('org/emb', 'embedder'), 'org/rr': entry('org/rr', 'reranker') };
const row = () => ({ name: 'NVIDIA GeForce RTX 5060 Laptop GPU', driver: '617.42', total_mb: 8151, used_mb: 0, free_mb: 7899 });

function stubClient(stub, workerOpts, clientOpts = {}) {
  const rt = sandbox(), cache = sandbox();
  writeStubRuntime(rt, stub);
  writeCache(cache, TABLE);
  const c = new GpuClient({ runtimeDir: rt, cacheDir: cache, table: TABLE, workerOpts, ...clientOpts }).start();
  return { c, done: async () => { await c.close(); cleanup(rt); cleanup(cache); } };
}

test('a request queued behind a slow load is kept alive by the load\'s heartbeat; without one it is declared hung', async () => {
  const ft = fakeTimers();
  const slow = stubClient({ loadDelayMs: 1500 }, { heartbeatMs: 100 }, { opBoundMs: 1200, timers: ft.timers });
  try {
    assert.strictEqual((await slow.c.ping(UP_DEADLINE)).ok, true, 'warm: the child is up before the clock starts');
    const progress = countProgress(slow.c.child);
    const load = outcome(slow.c.load('org/emb')), vec = outcome(slow.c.embed('org/emb', 'hello', { as: 'document' }));
    for (let k = 1; k <= 3; k += 1) { // each heartbeat is real; the gap since the last is under the bound, the whole is 3000 ms
      await progress.reach(k);
      await ft.advance(1000);
      assert.strictEqual(slow.c.hung, null, `heartbeat ${k}: the queued request is credited, not hung`);
    }
    await Promise.all([load.done, vec.done]);
    assert.strictEqual(load.error, undefined);
    assert.strictEqual(load.value.native_dims, 4);
    assert.strictEqual(vec.error, undefined);
    assert.strictEqual(vec.value.dim, 4);
    assert.strictEqual(slow.c.hung, null);
  } finally { await slow.done(); }
  const fq = fakeTimers();
  const quiet = stubClient({ loadDelayMs: 1500 }, { heartbeatMs: 100000 }, { opBoundMs: 1200, timers: fq.timers });
  try {
    assert.strictEqual((await quiet.c.ping(UP_DEADLINE)).ok, true);
    const load = outcome(quiet.c.load('org/emb')), vec = outcome(quiet.c.embed('org/emb', 'hello', { as: 'document' }));
    await fq.advance(1199);
    assert.strictEqual(vec.settled, false, 'not hung at bound - 1');
    await fq.advance(1);
    assert.ok(vec.error && vec.error.code === 'E_EMBEDDER_TIMEOUT', 'the control: with no heartbeat the queued request times out');
    await Promise.all([load.done]); // the load is ended by the close in done(), or answers; either way it settles
  } finally { await quiet.done(); }
});

test('a probe sample has its own short bound: a miss leaves nothing pending and never marks the child hung', async () => {
  const ft = fakeTimers();
  const c = new GpuClient({ workerPath: FAKE, timers: ft.timers }).start();
  try {
    assert.strictEqual((await c.ping(UP_DEADLINE)).ok, true);
    const started = waitEvent(c.child, 'wedge_started'), done = waitEvent(c.child, 'wedge_done');
    c.child.send({ id: 800, op: 'wedge', ms: 1200 }); // the child's loop is blocked: nothing can be answered
    await started;
    const sample = outcome(c.vramSample(200));
    await ft.advance(199);
    assert.strictEqual(sample.settled, false, 'the sample waits for its own bound');
    await ft.advance(1);
    assert.ok(sample.error && /did not answer vram within 200 ms/.test(sample.error.message), sample.error && sample.error.message);
    assert.strictEqual(c.hung, null);
    assert.strictEqual(c.pending.size, 0, 'the abandoned sample is not left pending under the 60 s bound');
    await done; // the wedge ends when the child says so
    const v = await c.vramSample(UP_DEADLINE);
    assert.strictEqual(v.gpu, 'vulkan');
    assert.ok((await c.vram()).total > 0, 'ordinary ops still work');
  } finally { await c.close(); }
});

function probeWith(calls) {
  const cache = sandbox();
  writeCache(cache, TABLE);
  const o = { models: ['org/rr'], cacheDir: cache, table: TABLE, runtimeDir: 'unused', record: false, smi: async () => row(), clientOpts: { workerPath: FAKE, workerOpts: { fake: { call_ms: calls } } } };
  return P.probe(o).finally(() => cleanup(cache));
}

test('the full batch is judged on the slowest warm run; one slow run is confirmed by a re-run, and both are recorded', async () => {
  // rank calls: sanity, 16 notes, cold, warm x3, re-run. The fake reports each scripted time exactly; nothing is slept or measured.
  const ok = await probeWith([5, 5, 5, 5, 1500, 5, 5]);
  assert.strictEqual(ok.ok, true, JSON.stringify(ok.refusal));
  const rr = ok.rerank['org/rr'];
  assert.strictEqual(rr.ubatch_ms, 1500, 'the slowest warm run, not the median');
  assert.deepStrictEqual(rr.ubatch_runs, [5, 1500, 5]);
  assert.strictEqual(rr.ubatch_rerun_ms, 5, 'the confirming run was fast');
  assert.strictEqual(rr.ubatch_refused, false);
  const bad = await probeWith([5, 5, 5, 5, 1500, 5, 1700]);
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.refusal.reason, 'submission_too_long');
  assert.match(bad.refusal.message, /took 1500 ms and then 1700 ms/);
  const fine = await probeWith([5, 5, 5, 5, 5, 5, 5]);
  assert.strictEqual(fine.ok, true);
  assert.strictEqual(fine.rerank['org/rr'].ubatch_rerun_ms, null, 'no re-run when every warm run is under the target');
});

// The REAL worker measures its own chunks: a chunk is slow when its stub sleeps past the bound, which holds on any
// machine (a sleep never ends early by more than a tick, and the bound is far below it). The calm case's bound is far above any chunk.
test('a rank chunk slower than the bound is a coded warning in the result, and the client surfaces it', async () => {
  const s = stubClient({ rankDelayMs: 120 }, { slowChunkMs: 60 });
  try {
    const heard = [];
    s.c.onWarning = (w) => heard.push(w);
    await s.c.load('org/rr');
    const notes = Array.from({ length: 6 }, (_, i) => `note number ${i}`);
    const r = await s.c.rank('org/rr', 'note', notes, { chunk: 3 });
    assert.deepStrictEqual(r.slow_chunks.map(x => x.index), [0, 1]);
    assert.ok(r.slow_chunks.every(x => x.ms >= 100));
    assert.strictEqual(r.warnings[0].code, 'GPU_SLOW_CHUNK');
    assert.match(r.warnings[0].message, /took over 60 ms/);
    assert.strictEqual(heard.length, 1);
  } finally { await s.done(); }
  const calm = stubClient({ rankDelayMs: 5 }, { slowChunkMs: 60000 });
  try {
    await calm.c.load('org/rr');
    const r = await calm.c.rank('org/rr', 'note', ['note a', 'note b']);
    assert.deepStrictEqual(r.slow_chunks, []);
    assert.strictEqual(r.warnings, undefined);
  } finally { await calm.done(); }
});

test('lock: a rename blocked with EPERM is retried and then a coded E_BUSY; a transient block is ridden out', () => {
  const dir = sandbox(), lock = path.join(dir, '.install.lock');
  try {
    fs.writeFileSync(lock, String(deadPid()));
    const eperm = () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); };
    assert.throws(() => R.takeLock(lock, { seam: { rename: eperm } }), (e) => e.code === 'E_BUSY' && e.detail.errno === 'EPERM');
    assert.ok(fs.existsSync(lock), 'the lock was not touched');
    let n = 0;
    const flaky = (a, b) => { n += 1; if (n <= 2) return eperm(); return fs.renameSync(a, b); };
    assert.strictEqual(R.takeLock(lock, { seam: { rename: flaky } }), true);
    assert.ok(n >= 3, `${n} rename attempts`);
    assert.strictEqual(fs.readFileSync(lock, 'utf8'), String(process.pid));
  } finally { cleanup(dir); }
});
