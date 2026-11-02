'use strict';
// rerank-cpu-proc.test.cjs — the CPU rerank child's lifecycle. The REAL rerank-worker.cjs runs on a stub transformers
// package (fixtures/rerank-stub-pkg.cjs), so CI needs no model and no onnx runtime: fork by handle, a bounded ping, a
// wedged child, close, a crash as a coded error, an allow-listed environment, the silence clock, and the child dying
// with its owner. The real models run in tests/smoke/rerank-cpu-smoke.cjs.

process.env.BELAY_TEST_MODE = '1';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, fork } = require('node:child_process');
const { core, sandbox, cleanup, FIXTURES } = require('./helpers.cjs');
const { waitGone, waitEvent, waitLine, countProgress, UP_DEADLINE } = require('../helpers/wait.cjs');
const { fakeTimers, outcome } = require('../helpers/fake-timers.cjs');
const { writeStubPackage, writeCache, fakeEntry } = require('./fixtures/rerank-stub-pkg.cjs');

const { CpuRerankClient } = core('rerank-cpu.cjs');
const { pidAlive } = core('lock.cjs');
const OWNER = path.join(FIXTURES, 'rerank-owner-hold.cjs');
const WORKER = path.join(__dirname, '..', '..', 'src', 'core', 'rerank-worker.cjs');

// Timing: a bound is asserted on an INJECTED clock (helpers/fake-timers.cjs): wait for the child's real message, advance to
// bound - 1 (still pending), then 1 (the coded rejection). A wait on a child is an event with a generous deadline, never a sleep.

// A sandbox with a stub package, a cache holding the fake model, and the table that names it.
function rig(stub = {}) {
  const dir = sandbox(), entry = fakeEntry();
  const pkg = writeStubPackage(`${dir}/pkg`, stub), cache = `${dir}/cache`;
  const table = { [entry.id]: entry };
  writeCache(cache, table);
  const tableFile = `${dir}/table.json`;
  fs.writeFileSync(tableFile, JSON.stringify(table));
  return { dir, pkg, cache, table, tableFile, entry, id: entry.id, mk: (o = {}) => new CpuRerankClient({ pkg, cacheDir: cache, table, ...o }).start(), done: () => cleanup(dir) };
}

test('start forks the child by handle; ping answers within its bound; close ends it and is safe twice', async () => {
  const r = rig(), c = r.mk();
  try {
    assert.ok(Number.isInteger(c.pid) && pidAlive(c.pid));
    const p = await c.ping(UP_DEADLINE);
    assert.strictEqual(p.ok, true);
    assert.strictEqual(p.pid, c.pid);
    assert.deepStrictEqual(p.models, []);
    await c.load(r.id);
    assert.deepStrictEqual((await c.ping(UP_DEADLINE)).models, [r.id]);
  } finally { await c.close(); }
  assert.ok(await waitGone(c.pid), 'close ended the child');
  await c.close();
  assert.strictEqual((await c.ping(200)).ok, false, 'a ping after close does not hang');
  await assert.rejects(c._call({ op: 'ping' }, 1000), (e) => e.code === 'E_MODEL_ABSENT' && e.detail.reranker === true && e.detail.cause === 'dead');
  r.done();
});

test('a wedged child fails its ping within the bound without marking it hung; a silent op is a hung child, never a hang', async () => {
  const r = rig(), ft = fakeTimers(), c = r.mk({ opBoundMs: 400, timers: ft.timers });
  try {
    await c.ping(UP_DEADLINE); // the child is up (answered by the child, not by the clock)
    const started = waitEvent(c.child, 'wedge_started'), done = waitEvent(c.child, 'wedge_done');
    c.child.send({ id: 900, op: 'wedge', ms: 1500 });
    await started; // the child announces before it blocks its loop
    const ping = outcome(c.ping(250));
    await ft.advance(249);
    assert.strictEqual(ping.settled, false, 'the ping is still waiting at bound - 1');
    await ft.advance(1);
    assert.strictEqual(ping.value.ok, false);
    assert.match(ping.value.reason, /did not answer a 250 ms ping/);
    assert.strictEqual(ping.value.ms, 250, 'the injected clock measured the bound exactly');
    assert.strictEqual(c.hung, null, 'an unanswered ping is not a hang');
    await done;
    const f2 = fakeTimers(), c2 = r.mk({ opBoundMs: 300, timers: f2.timers });
    try {
      const hang = outcome(c2._call({ op: 'hang' }, 300));
      await f2.advance(299);
      assert.strictEqual(hang.settled, false, 'a silent op is not hung before its bound');
      await f2.advance(1);
      assert.ok(hang.error && hang.error.code === 'E_EMBEDDER_TIMEOUT' && hang.error.detail.cause === 'timeout' && hang.error.detail.reranker === true);
      await assert.rejects(c2.load(r.id), (e) => e.code === 'E_EMBEDDER_TIMEOUT', 'later ops fail at once with the same cause');
    } finally { await c2.close(); }
  } finally { await c.close(); r.done(); }
});

test('a crash mid-op becomes E_MODEL_ABSENT with the exit code; the child is not restarted', async () => {
  const r = rig(), c = r.mk();
  let heard = null;
  c.onExit = (why, exit) => { heard = { why, exit }; };
  try {
    const started = waitEvent(c.child, 'sleep_started');
    const pending = c._call({ op: 'sleep', ms: 5000 }, 20000);
    await started; // the op is in the child
    c.child.send({ id: 901, op: 'crash', code: 7 });
    await assert.rejects(pending, (e) => e.code === 'E_MODEL_ABSENT' && e.detail.cause === 'dead' && e.detail.exit_code === 7 && /exit code 7/.test(e.message));
    assert.strictEqual(heard.exit.code, 7);
    await assert.rejects(c.load(r.id), (e) => e.code === 'E_MODEL_ABSENT' && /not restarted/.test(e.message));
  } finally { await c.close(); r.done(); }
});

test('an error the child raises keeps its code, or becomes E_INTERNAL with the cause; a model not fetched names the command', async () => {
  const r = rig(), c = r.mk();
  try {
    await assert.rejects(c._call({ op: 'fail' }, 5000), (e) => e.code === 'E_INTERNAL' && e.detail.cause === 'op_failed' && e.detail.reranker === true);
    await assert.rejects(c._call({ op: 'fail', code: 'E_ARGS' }, 5000), (e) => e.code === 'E_ARGS' && !(e.detail && e.detail.cause));
    await assert.rejects(c._call({ op: 'fail', code: 'ENOENT' }, 5000), (e) => e.code === 'E_INTERNAL' && e.detail.raw_code === 'ENOENT');
    await assert.rejects(c.rank(r.id, 'q', ['a']), (e) => e.code === 'E_MODEL_ABSENT' && e.detail.cause === 'absent', 'a rank before a load');
    assert.throws(() => c.rank(r.id, 'q', []), (e) => e.code === 'E_ARGS');
    assert.throws(() => c.rank(r.id, 7, ['a']), (e) => e.code === 'E_ARGS');
    assert.throws(() => c.rank(r.id, 'q', [1]), (e) => e.code === 'E_ARGS');
    await assert.rejects(c._call({ op: 'nope' }, 5000), (e) => e.code === 'E_INTERNAL');
    await assert.rejects(c.load('not/a-model'), (e) => e.code === 'E_ARGS');
  } finally { await c.close(); }
  const empty = sandbox(), c2 = new CpuRerankClient({ pkg: r.pkg, cacheDir: empty, table: r.table }).start();
  try {
    await assert.rejects(c2.load(r.id), (e) => e.code === 'E_MODEL_ABSENT' && e.detail.cause === 'absent' && e.detail.command === `belay embedder fetch --reranker ${r.id}` && e.message.includes(e.detail.command));
  } finally { await c2.close(); cleanup(empty); r.done(); }
});

test('a model whose files vanish after the client checked, or whose load throws, is a coded child error; the second load of one model is refused', async () => {
  const r = rig(), c = r.mk();
  try {
    await c.load(r.id);
    await assert.rejects(c.load(r.id), (e) => e.code === 'E_ARGS' && /already loaded/.test(e.message));
    const info = await c._call({ op: 'load', model: 'm2', dir: path.join(r.cache, `${r.id}@${r.entry.sha}`), dtype: 'int8', maxLength: 32 }, 5000);
    assert.strictEqual(info.max_length, 32);
    fs.rmSync(path.join(r.cache, `${r.id}@${r.entry.sha}`, 'onnx'), { recursive: true });
    await assert.rejects(c._call({ op: 'load', model: 'm3', dir: path.join(r.cache, `${r.id}@${r.entry.sha}`), dtype: 'int8', maxLength: 32 }, 5000), (e) => e.code === 'E_MODEL_ABSENT' && e.detail.cause === 'absent' && /onnx\/model_int8\.onnx/.test(e.message));
    for (const bad of [{ dtype: 'int8; x' }, { maxLength: 3 }, { dir: '' }]) {
      await assert.rejects(c._call({ op: 'load', model: 'm4', dir: r.cache, dtype: 'int8', maxLength: 32, ...bad }, 5000), (e) => e.code === 'E_ARGS', JSON.stringify(bad));
    }
  } finally { await c.close(); r.done(); }
});

test('the package is checked before the fork: absent or the wrong version is E_MODEL_ABSENT naming the fix', () => {
  const r = rig({ version: '4.2.0' });
  try {
    assert.throws(() => new CpuRerankClient({ pkg: r.pkg, cacheDir: r.cache, table: r.table }).start(), (e) => e.code === 'E_MODEL_ABSENT' && e.detail.cause === 'absent' && e.detail.found === '4.2.0' && e.detail.pinned === '4.3.0' && /npm install/.test(e.message));
    assert.throws(() => new CpuRerankClient({ pkg: `${r.dir}/nowhere`, cacheDir: r.cache }).start(), (e) => e.code === 'E_MODEL_ABSENT' && /not loadable/.test(e.message));
  } finally { r.done(); }
});

test('the child sees an allow-listed environment and no execArgv', async () => {
  const saved = { PLANTED_SECRET_TOKEN: process.env.PLANTED_SECRET_TOKEN, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, NODE_OPTIONS: process.env.NODE_OPTIONS };
  Object.assign(process.env, { PLANTED_SECRET_TOKEN: 'hunter2', ANTHROPIC_API_KEY: 'sk-planted', NODE_OPTIONS: '--max-old-space-size=200' });
  const r = rig(), c = r.mk();
  try {
    const out = await c._call({ op: 'env' }, 10000);
    for (const k of ['PLANTED_SECRET_TOKEN', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS']) assert.strictEqual(out.env[k], undefined, `${k} reached the child`);
    assert.deepStrictEqual(out.execArgv, []);
    assert.strictEqual(out.env.BELAY_TEST_MODE, '1');
  } finally {
    await c.close(); r.done();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('a hung op still rejects at its bound while the owner pings for liveness (pings are not proof of progress)', async () => {
  const r = rig(), ft = fakeTimers(), c = r.mk({ opBoundMs: 500, timers: ft.timers });
  try {
    await c.ping(UP_DEADLINE);
    const hang = outcome(c._call({ op: 'hang' }, 500));
    for (let i = 0; i < 4; i += 1) {
      await ft.advance(100);
      assert.strictEqual((await c.ping(300)).ok, true, 'the child answers its pings, which are not progress on the op');
    }
    await ft.advance(99); // 499 ms of silence about the op
    assert.strictEqual(hang.settled, false, 'not rejected at bound - 1');
    await ft.advance(1);
    assert.ok(hang.error && hang.error.code === 'E_EMBEDDER_TIMEOUT' && hang.error.detail.cause === 'timeout' && hang.error.detail.timeout_ms === 500);
  } finally { await c.close(); r.done(); }
});

// The stub child waits before each model call for a release file the test writes (rerank-stub-pkg.cjs, gateDir), so the
// silence clock is driven by the injected clock: every gap is under the bound, the whole run is well over it.
test('a long rank that keeps sending progress is not mistaken for a hung child, and a request queued behind it is credited by that progress', async () => {
  const gateDir = sandbox(), r = rig({ gateDir }), ft = fakeTimers(), c = r.mk({ opBoundMs: 900, timers: ft.timers });
  try {
    await c.load(r.id);
    const progress = countProgress(c.child);
    const docs = Array.from({ length: 6 }, (_, i) => `note ${i}`);
    const a = outcome(c.rank(r.id, 'q', docs, { chunk: 2 })), b = outcome(c.rank(r.id, 'q', docs, { chunk: 2 })); // a: three model calls; b waits behind it, then three more
    for (let k = 1; k <= 6; k += 1) {
      fs.writeFileSync(path.join(gateDir, `go-${k}`), '');
      await progress.reach(k);
      await ft.advance(800); // under the 900 ms bound since the last line; the first rank alone runs 2400 ms, b waits 2400 behind it
      assert.strictEqual(c.hung, null, `line ${k}: not hung`);
    }
    await Promise.all([a.done, b.done]);
    assert.strictEqual(a.error, undefined, a.error && a.error.message);
    assert.strictEqual(b.error, undefined, b.error && b.error.message);
    assert.strictEqual(b.value.scores.length, 6);
    assert.strictEqual(c.hung, null);
  } finally { await c.close(); r.done(); cleanup(gateDir); }
});

test('killing the owner by its exact pid takes the REAL rerank child with it promptly', async () => {
  const r = rig();
  let owner = null;
  try {
    owner = spawn(process.execPath, [OWNER, r.pkg, r.cache, r.tableFile], { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, BELAY_TEST_MODE: '1' } });
    const info = await waitLine(owner.stdout, 'rerank_pid'); // printed once the child announced its op is in flight
    assert.ok(pidAlive(info.rerank_pid), 'the child is up and busy');
    process.kill(info.owner_pid); // the exact pid of the owner this test spawned
    assert.ok(await waitGone(info.rerank_pid), 'the child outlived its owner');
  } finally { if (owner && owner.exitCode === null) { try { process.kill(owner.pid); } catch { /* gone */ } } r.done(); }
});

// On Windows libuv puts every child it spawns in a job object that dies with the parent, so the owner-death test above
// passes whatever the worker does. This one takes that out of the picture: the real worker is forked DETACHED (outside
// the job) with a stub model whose handle keeps its loop alive, and the owner's channel is closed. Only the worker's
// own disconnect handler can end it; deleting that handler fails this test.
test('the real rerank-worker ends itself when its owner\'s channel closes, though a loaded model keeps its loop alive', async () => {
  const r = rig({ keepAlive: true });
  let kid = null;
  try {
    kid = fork(WORKER, [JSON.stringify({ pkg: r.pkg })], { detached: true, execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'], env: { ...process.env, BELAY_TEST_MODE: '1' } });
    const answered = new Promise((res) => kid.on('message', (m) => { if (m.id === 1 && !m.progress) res(m); }));
    kid.send({ id: 1, op: 'load', model: r.id, dir: path.join(r.cache, `${r.id}@${r.entry.sha}`), dtype: 'int8', maxLength: 32 });
    const reply = await answered;
    assert.strictEqual(reply.ok, true, JSON.stringify(reply));
    const pid = kid.pid;
    kid.disconnect();
    assert.ok(await waitGone(pid), 'the worker stayed alive after its owner\'s channel closed');
  } finally { if (kid && kid.exitCode === null) { try { process.kill(kid.pid); } catch { /* gone */ } } r.done(); }
});
