'use strict';
// gpu-proc.test.cjs — the GPU child's lifecycle through a FAKE child (no GPU, no runtime): fork by handle, a
// bounded ping, a wedged child, close, a crash as a coded error, an allow-listed environment, the table and
// chunking, and the child dying with its parent. The real child runs in tests/smoke/gpu-smoke.cjs.

process.env.BELAY_TEST_MODE = '1';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { core, sandbox, cleanup, FIXTURES } = require('./helpers.cjs');

const { GpuClient } = core('gpu.cjs');
const { pidAlive } = core('lock.cjs');
const FAKE = path.join(FIXTURES, 'gpu-worker-fake.cjs');
const OWNER = path.join(FIXTURES, 'gpu-owner-hold.cjs');
const mk = (o = {}) => new GpuClient({ workerPath: FAKE, ...o }).start();
const waitGone = async (pid, ms) => { const t0 = Date.now(); while (pidAlive(pid) && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 20)); return !pidAlive(pid); };

test('start forks the child by handle; ping answers within its bound; close ends it and is safe twice', async () => {
  const c = mk();
  try {
    assert.ok(Number.isInteger(c.pid) && pidAlive(c.pid));
    const p = await c.ping(2000);
    assert.strictEqual(p.ok, true);
    assert.strictEqual(p.pid, c.pid);
  } finally { await c.close(); }
  assert.ok(await waitGone(c.pid, 3000), 'close ended the child');
  await c.close();
  assert.strictEqual((await c.ping(200)).ok, false, 'a ping after close does not hang');
  await assert.rejects(c._call({ op: 'ping' }, 1000), (e) => e.code === 'E_MODEL_ABSENT' && e.detail.gpu === true && e.detail.cause === 'dead');
});

test('a wedged child fails its ping within the bound and a silent op as a hung child, never a hang', async () => {
  const c = mk({ opBoundMs: 400 });
  try {
    c.child.send({ id: 900, op: 'wedge', ms: 1500 });
    await new Promise(r => setTimeout(r, 100));
    const t0 = Date.now();
    const p = await c.ping(250);
    assert.strictEqual(p.ok, false);
    assert.match(p.reason, /did not answer a 250 ms ping/);
    assert.ok(Date.now() - t0 < 1200, `the ping took ${Date.now() - t0} ms`);
    await new Promise(r => setTimeout(r, 1500));
    const c2 = mk({ opBoundMs: 300 });
    try {
      await assert.rejects(c2._call({ op: 'hang' }, 300), (e) => e.code === 'E_EMBEDDER_TIMEOUT' && e.detail.cause === 'timeout' && e.detail.gpu === true);
      await assert.rejects(c2.vram(), (e) => e.code === 'E_EMBEDDER_TIMEOUT', 'later ops fail at once with the same cause');
    } finally { await c2.close(); }
  } finally { await c.close(); }
});

test('a crash mid-op becomes E_MODEL_ABSENT with the exit code; the child is not restarted', async () => {
  const c = mk();
  let heard = null;
  c.onExit = (why, exit) => { heard = { why, exit }; };
  try {
    const pending = c._call({ op: 'sleep', ms: 5000 }, 20000);
    await new Promise(r => setTimeout(r, 100));
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
    const r = await c._call({ op: 'env' }, 10000);
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
    await c._call({ op: 'load', model: 'm', kind: 'reranker', gpu: 'vulkan' }, 5000);
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

test('a long rank that keeps sending progress is not mistaken for a hung child', async () => {
  const c = mk({ opBoundMs: 1200, workerOpts: { fake: { rank_ms_per_pair: 60 } } });
  try {
    await c._call({ op: 'load', model: 'm', kind: 'reranker', gpu: 'vulkan' }, 5000);
    const r = await c.rank('m', 'stop worker pid', Array.from({ length: 40 }, (_, i) => `note ${i}`), { chunk: 2 });
    assert.ok(r.ms > 1800, `the rank ran ${r.ms} ms against a 1200 ms silence bound`);
  } finally { await c.close(); }
});

test('killing the owner by its exact pid takes the GPU child with it promptly', async () => {
  let owner = null;
  try {
    owner = spawn(process.execPath, [OWNER], { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, BELAY_TEST_MODE: '1' } });
    let out = '', info = null;
    owner.stdout.on('data', (d) => { out += d; for (const l of out.split('\n')) if (l.includes('gpu_pid') && !info) info = JSON.parse(l); });
    for (let i = 0; i < 400 && !info; i += 1) await new Promise(r => setTimeout(r, 25));
    assert.ok(info, `the owner never had a GPU op in flight: ${out}`);
    assert.ok(pidAlive(info.gpu_pid), 'the GPU child is up and busy');
    process.kill(info.owner_pid); // the exact pid of the owner this test spawned
    assert.ok(await waitGone(info.gpu_pid, 5000), 'the child outlived its owner');
  } finally { if (owner && owner.exitCode === null) { try { process.kill(owner.pid); } catch { /* gone */ } } }
});

test('a hung op still rejects at its bound while the owner pings for liveness (pings are not proof of progress)', async () => {
  const c = mk({ opBoundMs: 500 });
  const pinger = setInterval(() => { c.ping(300).catch(() => {}); c.vram().catch(() => {}); }, 100);
  try {
    const t0 = Date.now();
    await assert.rejects(c._call({ op: 'hang' }, 500), (e) => e.code === 'E_EMBEDDER_TIMEOUT' && e.detail.cause === 'timeout');
    const ms = Date.now() - t0;
    assert.ok(ms >= 450 && ms < 2500, `rejected after ${ms} ms`);
  } finally { clearInterval(pinger); await c.close(); }
});

test('a request queued behind a long rank is credited by that rank\'s progress, not timed out for the wait', async () => {
  const c = mk({ opBoundMs: 1200, workerOpts: { fake: { rank_ms_per_pair: 60 } } });
  try {
    await c._call({ op: 'load', model: 'm', kind: 'reranker', gpu: 'vulkan' }, 5000);
    const docs = Array.from({ length: 20 }, (_, i) => `note ${i}`);
    const [a, b] = await Promise.all([c.rank('m', 'q', docs, { chunk: 2 }), c.rank('m', 'q', docs, { chunk: 2 })]);
    assert.ok(a.ms > 900 && b.scores.length === 20);
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
    let out = '', info = null;
    owner.stdout.on('data', (d) => { out += d; for (const l of out.split('\n')) if (l.includes('gpu_pid') && !info) info = JSON.parse(l); });
    for (let i = 0; i < 400 && !info; i += 1) await new Promise(r => setTimeout(r, 25));
    assert.ok(info, `the owner never had a GPU op in flight: ${out}`);
    assert.ok(pidAlive(info.gpu_pid), 'the real worker is up with its model loaded');
    process.kill(info.owner_pid); // the exact pid of the owner this test spawned
    assert.ok(await waitGone(info.gpu_pid, 5000), 'the real worker outlived its owner');
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
    assert.ok(await waitGone(pid, 5000), 'the worker stayed alive after its owner\'s channel closed');
  } finally { if (kid && kid.exitCode === null) { try { process.kill(kid.pid); } catch { /* gone */ } } cleanup(rt); }
});
