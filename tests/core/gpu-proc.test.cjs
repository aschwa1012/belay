'use strict';
// gpu-proc.test.cjs — the GPU child's lifecycle through a FAKE child (no GPU, no runtime): fork by handle, a
// bounded ping, a wedged child, close, a crash as a coded error, an allow-listed environment, the table and
// chunking, and the child dying with its parent. The real child runs in tests/smoke/gpu-smoke.cjs.
//
// Timing: a product bound (a ping's, the silence clock, the wall clock) is asserted on an INJECTED clock
// (helpers/fake-timers.cjs): wait for the child's real message, advance to bound-1 and the request is still
// pending, advance 1 and it is the coded rejection. A wait on a child is an event with a generous deadline
// (helpers/wait.cjs), never a sleep.

process.env.BELAY_TEST_MODE = '1';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { core, sandbox, cleanup, FIXTURES } = require('./helpers.cjs');
const { waitGone, waitEvent, waitLine, countProgress, UP_DEADLINE } = require('../helpers/wait.cjs');
const { fakeTimers, outcome } = require('../helpers/fake-timers.cjs');

const { GpuClient } = core('gpu.cjs');
const { pidAlive } = core('lock.cjs');
const FAKE = path.join(FIXTURES, 'gpu-worker-fake.cjs');
const OWNER = path.join(FIXTURES, 'gpu-owner-hold.cjs');
const mk = (o = {}) => new GpuClient({ workerPath: FAKE, ...o }).start();

test('start forks the child by handle; ping answers within its bound; close ends it and is safe twice', async () => {
  const c = mk();
  try {
    assert.ok(Number.isInteger(c.pid) && pidAlive(c.pid));
    const p = await c.ping(UP_DEADLINE);
    assert.strictEqual(p.ok, true);
    assert.strictEqual(p.pid, c.pid);
  } finally { await c.close(); }
  assert.ok(await waitGone(c.pid), 'close ended the child');
  await c.close();
  assert.strictEqual((await c.ping(200)).ok, false, 'a ping after close does not hang');
  await assert.rejects(c._call({ op: 'ping' }, 1000), (e) => e.code === 'E_MODEL_ABSENT' && e.detail.gpu === true && e.detail.cause === 'dead');
});

test('a wedged child fails its ping within the bound and a silent op as a hung child, never a hang', async () => {
  const ft = fakeTimers();
  const c = mk({ opBoundMs: 400, timers: ft.timers });
  try {
    await c.ping(UP_DEADLINE); // the child is up (answered by the child, not by the clock)
    const started = waitEvent(c.child, 'wedge_started'), done = waitEvent(c.child, 'wedge_done');
    c.child.send({ id: 900, op: 'wedge', ms: 1500 });
    await started; // the child announces before it blocks its loop
    const ping = outcome(c.ping(250));
    await ft.advance(249);
    assert.strictEqual(ping.settled, false, 'the ping is still waiting at bound - 1');
    await ft.advance(1);
    assert.strictEqual(ping.settled, true);
    assert.strictEqual(ping.value.ok, false);
    assert.match(ping.value.reason, /did not answer a 250 ms ping/);
    assert.strictEqual(ping.value.ms, 250, 'the injected clock measured the bound exactly');
    await done;
    const f2 = fakeTimers();
    const c2 = mk({ opBoundMs: 300, timers: f2.timers });
    try {
      const hang = outcome(c2._call({ op: 'hang' }, 300));
      await f2.advance(299);
      assert.strictEqual(hang.settled, false, 'a silent op is not hung before its bound');
      await f2.advance(1);
      assert.ok(hang.error && hang.error.code === 'E_EMBEDDER_TIMEOUT' && hang.error.detail.cause === 'timeout' && hang.error.detail.gpu === true);
      await assert.rejects(c2.vram(), (e) => e.code === 'E_EMBEDDER_TIMEOUT', 'later ops fail at once with the same cause');
    } finally { await c2.close(); }
  } finally { await c.close(); }
});

test('a crash mid-op becomes E_MODEL_ABSENT with the exit code; the child is not restarted', async () => {
  const c = mk();
  let heard = null;
  c.onExit = (why, exit) => { heard = { why, exit }; };
  try {
    const started = waitEvent(c.child, 'sleep_started');
    const pending = c._call({ op: 'sleep', ms: 5000 }, 20000);
    await started; // the op is in the child
    c.child.send({ id: 901, op: 'crash', code: 7 });
    await assert.rejects(pending, (e) => e.code === 'E_MODEL_ABSENT' && e.detail.cause === 'dead' && e.detail.exit_code === 7 && /exit code 7/.test(e.message));
    assert.strictEqual(heard.exit.code, 7);
    await assert.rejects(c.vram(), (e) => e.code === 'E_MODEL_ABSENT' && /not restarted/.test(e.message));
  } finally { await c.close(); }
});

test('an error the child raises keeps its code, or becomes E_INTERNAL with the cause', async () => {
  const c = mk();
  try {
    await assert.rejects(c._call({ op: 'fail' }, 5000), (e) => e.code === 'E_INTERNAL' && e.detail.cause === 'op_failed' && e.detail.gpu === true);
    await assert.rejects(c._call({ op: 'fail', code: 'E_ARGS' }, 5000), (e) => e.code === 'E_ARGS' && !(e.detail && e.detail.cause));
    await assert.rejects(c.embed('nope', 'x'), (e) => e.code === 'E_MODEL_ABSENT' && e.detail.cause === 'absent');
    assert.throws(() => c.embed('x', 'y', { as: 'both' }), (e) => e.code === 'E_ARGS');
    assert.throws(() => c.rank('x', 'q', []), (e) => e.code === 'E_ARGS');
  } finally { await c.close(); }
});

test('the child sees an allow-listed environment and no execArgv', async () => {
  const saved = { PLANTED_SECRET_TOKEN: process.env.PLANTED_SECRET_TOKEN, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, NODE_OPTIONS: process.env.NODE_OPTIONS };
  Object.assign(process.env, { PLANTED_SECRET_TOKEN: 'hunter2', ANTHROPIC_API_KEY: 'sk-planted', NODE_OPTIONS: '--max-old-space-size=200' });
  const c = mk();
  try {
    const r = await c._call({ op: 'env' }, UP_DEADLINE);
    for (const k of ['PLANTED_SECRET_TOKEN', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS']) assert.strictEqual(r.env[k], undefined, `${k} reached the child`);
    assert.deepStrictEqual(r.execArgv, []);
  } finally {
    await c.close();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('load refuses a model whose file is not in the cache, naming the fetch command', async () => {
  const dir = sandbox();
  const c = mk({ cacheDir: dir });
  try {
    await assert.rejects(c.load('Qwen/Qwen3-Embedding-0.6B-GGUF'), (e) => e.code === 'E_MODEL_ABSENT' && e.detail.cause === 'absent' && /belay embedder fetch --gpu --model Qwen\/Qwen3-Embedding-0\.6B-GGUF/.test(e.message));
    await assert.rejects(c.load('not/a-model'), (e) => e.code === 'E_ARGS');
  } finally { await c.close(); cleanup(dir); }
});

test('rank goes out in chunks: one progress line and one chunk per submission, scores in input order', async () => {
  const c = mk();
  try {
    await c._call({ op: 'load', model: 'm', kind: 'reranker', gpu: 'vulkan' }, UP_DEADLINE);
    const docs = Array.from({ length: 23 }, (_, i) => (i === 17 ? 'stop the worker by pid' : `filler note number ${i}`));
    const r = await c.rank('m', 'stop worker pid', docs, { chunk: 10 });
    assert.deepStrictEqual(r.chunks.map(x => x.n), [10, 10, 3]);
    assert.strictEqual(r.scores.length, 23);
    assert.strictEqual(r.scores.indexOf(Math.max(...r.scores)), 17);
    const whole = await c.rank('m', 'stop worker pid', docs);
    assert.deepStrictEqual(whole.chunks.map(x => x.n), [23], 'no chunk size sends one submission');
    assert.deepStrictEqual(whole.scores, r.scores, 'chunking changes no score');
  } finally { await c.close(); }
});

// The child holds each rank after every progress line until the test releases it, so the silence clock is driven by the
// injected clock: each gap is under the bound, the whole is well over it, and no real time is waited.
test('a long rank that keeps sending progress is not mistaken for a hung child', async () => {
  const ft = fakeTimers();
  const c = mk({ opBoundMs: 1200, timers: ft.timers, workerOpts: { fake: { gate_chunks: true, virtual_ms: true } } });
  try {
    await c._call({ op: 'load', model: 'm', kind: 'reranker', gpu: 'vulkan' }, UP_DEADLINE);
    const progress = countProgress(c.child);
    const rank = outcome(c.rank('m', 'stop worker pid', Array.from({ length: 6 }, (_, i) => `note ${i}`), { chunk: 2 }));
    for (let k = 1; k <= 3; k += 1) {
      await progress.reach(k);
      await ft.advance(1000); // under the 1200 ms bound since the last line, though the rank as a whole runs 3000 ms
      assert.strictEqual(c.hung, null, `chunk ${k}: not hung`);
      c.child.send({ op: 'release' });
    }
    await rank.done;
    assert.strictEqual(rank.error, undefined);
    assert.deepStrictEqual(rank.value.chunks.map(x => x.n), [2, 2, 2]);
    assert.strictEqual(c.hung, null);
  } finally { await c.close(); }
});

test('killing the owner by its exact pid takes the GPU child with it promptly', async () => {
  let owner = null;
  try {
    owner = spawn(process.execPath, [OWNER], { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, BELAY_TEST_MODE: '1' } });
    const info = await waitLine(owner.stdout, 'gpu_pid'); // printed once the child announced its op is in flight
    assert.ok(pidAlive(info.gpu_pid), 'the GPU child is up and busy');
    process.kill(info.owner_pid); // the exact pid of the owner this test spawned
    assert.ok(await waitGone(info.gpu_pid), 'the child outlived its owner');
  } finally { if (owner && owner.exitCode === null) { try { process.kill(owner.pid); } catch { /* gone */ } } }
});

test('a hung op still rejects at its bound while the owner pings for liveness (pings are not proof of progress)', async () => {
  const ft = fakeTimers();
  const c = mk({ opBoundMs: 500, timers: ft.timers });
  try {
    await c.ping(UP_DEADLINE);
    const hang = outcome(c._call({ op: 'hang' }, 500));
    for (let i = 0; i < 4; i += 1) {
      await ft.advance(100);
      assert.strictEqual((await c.ping(300)).ok, true, 'the child answers its pings, which are not progress on the op');
      assert.ok(typeof (await c.vram()).total === 'number');
    }
    await ft.advance(99); // 499 ms of silence about the op
    assert.strictEqual(hang.settled, false, 'not rejected at bound - 1');
    await ft.advance(1);
    assert.ok(hang.error && hang.error.code === 'E_EMBEDDER_TIMEOUT' && hang.error.detail.cause === 'timeout' && hang.error.detail.timeout_ms === 500);
  } finally { await c.close(); }
});

test('a request queued behind a long rank is credited by that rank\'s progress, not timed out for the wait', async () => {
  const ft = fakeTimers();
  const c = mk({ opBoundMs: 1200, timers: ft.timers, workerOpts: { fake: { gate_chunks: true, virtual_ms: true } } });
  try {
    await c._call({ op: 'load', model: 'm', kind: 'reranker', gpu: 'vulkan' }, UP_DEADLINE);
    const progress = countProgress(c.child);
    const docs = Array.from({ length: 6 }, (_, i) => `note ${i}`);
    const a = outcome(c.rank('m', 'q', docs, { chunk: 2 })), b = outcome(c.rank('m', 'q', docs, { chunk: 2 }));
    for (let k = 1; k <= 6; k += 1) { // a's three chunks, then b's three: b waits 3000 ms of the clock behind a, and is credited
      await progress.reach(k);
      await ft.advance(1000);
      assert.strictEqual(c.hung, null, `line ${k}: not hung`);
      c.child.send({ op: 'release' });
    }
    await Promise.all([a.done, b.done]);
    assert.strictEqual(a.error, undefined);
    assert.strictEqual(b.error, undefined);
    assert.strictEqual(b.value.scores.length, 6);
  } finally { await c.close(); }
});

test('killing the owner by its exact pid takes the REAL gpu-worker with it, even with native handles keeping its loop alive', async () => {
  const { writeStubRuntime, writeCache } = require('./fixtures/gpu-stub-runtime.cjs');
  const fs = require('node:fs');
  const rt = sandbox(), cache = sandbox();
  let owner = null;
  try {
    writeStubRuntime(rt, { keepAlive: true }); // the stub's model holds an interval, as a real context's threads hold the loop
    const e = { id: 'org/emb', sha: 'a'.repeat(40), runtime: 'gguf', kind: 'embedder', pooling: 'last', files: [{ path: 'm.gguf', bytes: 10, sha256: 'b'.repeat(64) }], query_prompt: '', document_prompt: '', native_dims: 4, dims: 4, context_size: 64, vram_mb_ref: 1 };
    writeCache(cache, { [e.id]: e });
    const tableFile = path.join(cache, 'table.json');
    fs.writeFileSync(tableFile, JSON.stringify({ [e.id]: e }));
    owner = spawn(process.execPath, [OWNER, 'real', rt, cache, tableFile], { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, BELAY_TEST_MODE: '1' } });
    const info = await waitLine(owner.stdout, 'gpu_pid');
    assert.ok(pidAlive(info.gpu_pid), 'the real worker is up with its model loaded');
    process.kill(info.owner_pid); // the exact pid of the owner this test spawned
    assert.ok(await waitGone(info.gpu_pid), 'the real worker outlived its owner');
  } finally {
    if (owner && owner.exitCode === null) { try { process.kill(owner.pid); } catch { /* gone */ } }
    cleanup(rt); cleanup(cache);
  }
});

// On Windows libuv puts every child it spawns in a job object that dies with the parent, so the owner-death tests
// above pass whatever the worker does. This one takes that out of the picture: the real worker is forked DETACHED
// (outside the job) with a stub model whose handle keeps its loop alive, and the owner's channel is closed. Only the
// worker's own disconnect handler can end it; deleting that handler fails this test.
test('the real gpu-worker ends itself when its owner\'s channel closes, though a loaded model keeps its loop alive', async () => {
  const { writeStubRuntime } = require('./fixtures/gpu-stub-runtime.cjs');
  const { fork } = require('node:child_process');
  const rt = sandbox();
  let kid = null;
  try {
    writeStubRuntime(rt, { keepAlive: true });
    kid = fork(path.join(__dirname, '..', '..', 'src', 'core', 'gpu-worker.cjs'), [JSON.stringify({ runtimeDir: rt })], { detached: true, execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const answered = new Promise((res) => kid.on('message', (m) => { if (m.id === 1) res(m); }));
    kid.send({ id: 1, op: 'load', model: 'm', kind: 'embedder', path: 'unused', gpu: 'vulkan', contextSize: 8 });
    assert.strictEqual((await answered).ok, true, 'the stub model is loaded and holds a handle');
    const pid = kid.pid;
    kid.disconnect();
    assert.ok(await waitGone(pid), 'the worker stayed alive after its owner\'s channel closed');
  } finally { if (kid && kid.exitCode === null) { try { process.kill(kid.pid); } catch { /* gone */ } } cleanup(rt); }
});

// A load stuck in native code heartbeats forever, so the silence clock never fires: the wall clock must (300 s by
// default). The REAL gpu-worker on a stub runtime whose load takes 4 s and heartbeats every 50 ms. The child is warm
// and has sent at least three heartbeats before the clock moves, then the injected clock stops at wall - 1 and passes it.
test('a load has a wall-clock limit that the child\'s heartbeats do not reset', async () => {
  const { writeStubRuntime, writeCache } = require('./fixtures/gpu-stub-runtime.cjs');
  const rt = sandbox(), cache = sandbox();
  try {
    writeStubRuntime(rt, { loadDelayMs: 4000 });
    const e = { id: 'org/emb', sha: 'a'.repeat(40), runtime: 'gguf', kind: 'embedder', pooling: 'last', files: [{ path: 'm.gguf', bytes: 10, sha256: 'b'.repeat(64) }], query_prompt: '', document_prompt: '', native_dims: 4, dims: 4, context_size: 64, vram_mb_ref: 1 };
    writeCache(cache, { [e.id]: e });
    const ft = fakeTimers();
    const c = new GpuClient({ runtimeDir: rt, cacheDir: cache, table: { [e.id]: e }, workerOpts: { heartbeatMs: 50 }, loadBoundMs: 2000, loadWallMs: 500, timers: ft.timers }).start();
    try {
      assert.strictEqual((await c.ping(UP_DEADLINE)).ok, true, 'warm: the child is up');
      const progress = countProgress(c.child);
      const load = outcome(c.load(e.id));
      await progress.reach(3); // the child really heartbeated, so the silence clock has been credited repeatedly
      await ft.advance(499);
      assert.strictEqual(load.settled, false, 'not rejected at wall - 1');
      await ft.advance(1);
      assert.ok(load.error && load.error.code === 'E_EMBEDDER_TIMEOUT' && load.error.detail.cause === 'timeout' && load.error.detail.gpu === true && load.error.detail.wall_clock === true && load.error.detail.timeout_ms === 500, JSON.stringify(load.error));
      assert.ok(await waitGone(c.pid), 'the wall-clock branch closed the stuck child itself, so it holds no memory');
    } finally { await c.close(); }
  } finally { cleanup(rt); cleanup(cache); }
});
