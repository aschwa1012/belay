'use strict';
// embedder-wait.test.cjs — build 12b E2: a model load is waited on within the call's own limit and never
// restarted; a failed load is reported once with its cause and then promptly; a busy-but-alive owner
// that misses the 300 ms ping is not reported lost. The load tests need the fetched model (the delay is a
// test-only knob that holds the child's load, honoured under BELAY_TEST_MODE=1 alone).

const nodeTest = require('node:test').test;
const test = (name, fn) => nodeTest(name, { timeout: 240000 }, fn);
const assert = require('node:assert');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { core, sandbox, cleanup, callerFor, optInModel } = require('./helpers.cjs');
optInModel();
// Every test knob here (testLoadDelayMs, vectorLimitMs, the child's hang/sleep/fail ops) is honoured only under
// BELAY_TEST_MODE=1; without it a knob is silently ignored and a test times a real load (review 4).
process.env.BELAY_TEST_MODE = '1';

const { openCore } = core('index.cjs');
const M = core('models.cjs');
const K = core('model-cache.cjs');

const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');
const VOYAGE = M.MODELS[M.DEFAULT_MODEL];
const noVoyage = !K.packageDir() ? 'the transformers package is not installed' : (K.checkPresent(VOYAGE).present ? null : `the model ${VOYAGE.id} is not fetched`);

async function withCore(embedOpts, fn) {
  const dir = sandbox();
  let c = null;
  try {
    c = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: true, ownerOpts: { embedOpts } });
    await fn(c, dir);
  } finally { if (c) { await c.shutdownOwner(); await c.close(); } cleanup(dir); }
}

test('a load slower than any fixed bound the old code had is waited on by every caller, on one child', async t => {
  if (noVoyage) return t.skip(noVoyage);
  // The old code failed a load at LOAD_BOUND_MS (a constant, 90 s). 3,000 ms of hold stands for "longer
  // than that bound": the receipt for this step runs this file against the old code with the constant
  // patched to 1,000 ms, where the first call fails E_TIMEOUT.
  await withCore({ testLoadDelayMs: 3000 }, async (c) => {
    const t0 = Date.now();
    const a = c.memory.store({ namespace: 'w1', text: 'first caller' });
    await new Promise(r => setTimeout(r, 300));
    const b = c.memory.store({ namespace: 'w1', text: 'second caller joins the same load' });
    const [ra, rb] = await Promise.all([a, b]);
    assert.ok(Date.now() - t0 >= 2500, `the call waited for the held load (${Date.now() - t0} ms)`);
    assert.ok(ra.id && rb.id, 'both rows were written');
    assert.strictEqual((await c.memory.stats({})).owner.embedder.pid, c.owner.embedderObj.pid, 'one embedder child served both');
    const w = await c.memory.warm({});
    assert.strictEqual(w.state, 'ready');
  });
});

test('a hung load fails once with its cause, and every later call gets that cause promptly, with no new attempt', async t => {
  if (noVoyage) return t.skip(noVoyage);
  await withCore({ testLoadDelayMs: 20000, loadBoundMs: 1500 }, async (c) => {
    const t0 = Date.now();
    const first = await c.memory.store({ namespace: 'w2', text: 'a call into a hung load' }).then(() => null, e => e);
    assert.ok(first, 'the hung load failed the call');
    assert.strictEqual(first.code, 'E_EMBEDDER_TIMEOUT', `${first.code}: ${first.message}`);
    assert.strictEqual(first.detail.embedder, true);
    assert.strictEqual(first.detail.cause, 'timeout');
    assert.strictEqual(first.detail.phase, 'load');
    assert.ok(Date.now() - t0 < 10000, `reported in ${Date.now() - t0} ms`);
    const pid = c.owner.embedderObj.pid;
    const t1 = Date.now();
    const second = await c.memory.search({ namespace: 'w2', query: 'again', mode: 'semantic' }).then(() => null, e => e);
    assert.ok(Date.now() - t1 < 500, `the later call took ${Date.now() - t1} ms`);
    assert.strictEqual(second.code, 'E_EMBEDDER_TIMEOUT');
    assert.strictEqual(second.detail.cause, 'timeout');
    assert.strictEqual(c.owner.embedderObj.pid, pid, 'no second child was started');
    const w = await c.memory.warm({});
    assert.strictEqual(w.state, 'failed');
    assert.strictEqual(w.error.cause, 'timeout');
    await assert.rejects(c.memory.warm({ wait: true }), x => x.code === 'E_EMBEDDER_TIMEOUT' && x.detail.embedder === true);
  });
});

test('memory.warm starts the load without waiting, and the first vector call then finds it ready', async t => {
  if (noVoyage) return t.skip(noVoyage);
  await withCore({}, async (c) => {
    const w = await c.memory.warm({});
    assert.ok(['loading', 'ready'].includes(w.state), w.state);
    await c.memory.warm({ wait: true });
    const s = (await c.memory.stats({})).owner;
    assert.ok(s.embedder && s.embedder.pid, 'loaded before any vector call');
    const t0 = Date.now();
    await c.memory.store({ namespace: 'w3', text: 'after warm-up' });
    assert.ok(Date.now() - t0 < 5000, `first call after warm-up took ${Date.now() - t0} ms`);
  });
});

test('a live owner that is only busy for 700 ms and misses the 300 ms ping is not reported lost', async () => {
  const dir = sandbox();
  let child = null, c = null;
  try {
    child = spawn(process.execPath, [`${ROOT}/tests/core/fixtures/owner-busy.cjs`, dir, '700'], { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
    let buf = '';
    child.stdout.on('data', d => { buf += d; });
    for (let i = 0; i < 400 && !buf.includes('READY'); i += 1) await new Promise(r => setTimeout(r, 25));
    assert.ok(buf.includes('READY'), `the busy owner did not start: ${buf}`);
    await new Promise(r => setTimeout(r, 250)); // the owner's 700 ms block begins at 200 ms after READY
    c = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
    const t0 = Date.now();
    // The owner has embedding off, so a refusal of E_NO_EMBEDDER is what an ANSWERING owner says.
    const r = await c.memory.search({ query: 'which process?', mode: 'semantic' }).then(() => null, e => e);
    assert.ok(r, 'the owner has no embedder, so the call must be refused');
    assert.notStrictEqual(r.code, 'E_OWNER_LOST', `a busy owner was reported lost: ${r.message}`);
    assert.ok(Date.now() - t0 < 2500, `took ${Date.now() - t0} ms`);
    await c.shutdownOwner();
  } finally {
    if (c) await c.close();
    if (child && child.exitCode === null) { try { process.kill(child.pid); } catch { /* gone */ } }
    cleanup(dir);
  }
});

test('memory.warm retry clears a failed load and loads afresh; on a healthy embedder it is a no-op', async t => {
  if (noVoyage) return t.skip(noVoyage);
  const opts = { testLoadDelayMs: 20000, loadBoundMs: 1500 };
  await withCore(opts, async (c) => {
    await assert.rejects(c.memory.warm({ wait: true }), x => x.code === 'E_EMBEDDER_TIMEOUT' && x.detail.embedder === true);
    const dead = c.owner.embedderObj;
    // without retry the failure stays
    assert.strictEqual((await c.memory.warm({})).state, 'failed');
    opts.testLoadDelayMs = 0; opts.loadBoundMs = 0; // the operator fixed it
    const w = await c.memory.warm({ wait: true, retry: true });
    assert.strictEqual(w.state, 'ready');
    assert.strictEqual(w.error, null);
    assert.notStrictEqual(c.owner.embedderObj, dead, 'a new embedder was started');
    const pid = w.pid;
    const again = await c.memory.warm({ wait: true, retry: true });
    assert.strictEqual(again.pid, pid, 'retry on a healthy embedder restarts nothing');
    await c.memory.store({ namespace: 'w5', text: 'works after the retry' });
  });
});

test('memory.warm reload: concurrent reloads join one fresh load, and a plain warm stays failed', async t => {
  if (noVoyage) return t.skip(noVoyage);
  const opts = { testLoadDelayMs: 20000, loadBoundMs: 1500 };
  await withCore(opts, async (c) => {
    await assert.rejects(c.memory.warm({ wait: true }), x => x.code === 'E_EMBEDDER_TIMEOUT');
    assert.strictEqual((await c.memory.warm({ wait: false })).state, 'failed');
    opts.testLoadDelayMs = 1500; opts.loadBoundMs = 0;
    const [a, b] = await Promise.all([c.memory.warm({ wait: true, reload: true }), c.memory.warm({ wait: true, reload: true })]);
    assert.strictEqual(a.state, 'ready');
    assert.strictEqual(a.pid, b.pid, 'both callers joined one load');
    await c.memory.store({ namespace: 'w6', text: 'works after the reload' });
  });
});

test('a codeless or Node-coded child error mid-operation is still an embedder failure (op_failed), raw code kept', async () => {
  const saved = process.env.BELAY_TEST_MODE; process.env.BELAY_TEST_MODE = '1';
  const { Embedder } = core('embedder.cjs');
  const e = new Embedder({ cacheDir: sandbox() });
  try {
    e._start();
    for (const [code, raw] of [[undefined, null], ['ERR_ONNX_FAIL', 'ERR_ONNX_FAIL']]) {
      const x = await e._call({ op: 'fail', code }, 20000).then(() => null, r => r);
      assert.ok(x, 'the injected failure rejected');
      assert.strictEqual(x.code, 'E_INTERNAL');
      assert.strictEqual(x.detail.embedder, true, 'flagged on the resolved code');
      assert.strictEqual(x.detail.cause, 'op_failed');
      assert.strictEqual(x.detail.raw_code, raw);
    }
  } finally { await e.close(); if (saved === undefined) delete process.env.BELAY_TEST_MODE; else process.env.BELAY_TEST_MODE = saved; }
});

test('an in-process owner caller has the same limit as the pipe: warm with timeout_ms ends the call, the load continues', async t => {
  if (noVoyage) return t.skip(noVoyage);
  await withCore({ testLoadDelayMs: 5000 }, async (c) => {
    const t0 = Date.now();
    const x = await c.memory.warm({ wait: true, timeout_ms: 1000 }).then(() => null, r => r);
    assert.ok(x, 'the call ended');
    assert.strictEqual(x.code, 'E_TIMEOUT');
    assert.strictEqual(x.detail.in_process, true);
    assert.ok(Date.now() - t0 < 4000, `ended after ${Date.now() - t0} ms`);
    assert.strictEqual((await c.memory.warm({})).state, 'loading', 'the load continues');
    assert.strictEqual((await c.memory.warm({ wait: true })).state, 'ready', 'a retry joins the same load');
  });
});

test('an in-process memory.store that hits the limit says may_have_committed and to re-read before retrying', async t => {
  if (noVoyage) return t.skip(noVoyage);
  const dir = sandbox();
  let c = null, savedMode;
  try {
    savedMode = process.env.BELAY_TEST_MODE; process.env.BELAY_TEST_MODE = '1'; // vectorLimitMs and testLoadDelayMs are test-only knobs
    c = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: true, vectorLimitMs: 1000, ownerOpts: { embedOpts: { testLoadDelayMs: 4000 } } });
    const x = await c.memory.store({ namespace: 'sf1', text: 'a row that commits once the load finishes' }).then(() => null, r => r);
    assert.ok(x, 'the call ended');
    assert.strictEqual(x.code, 'E_TIMEOUT');
    assert.strictEqual(x.detail.may_have_committed, true);
    assert.match(x.message, /RE-READ before retrying/);
    const s = await c.memory.warm({ wait: true });
    assert.strictEqual(s.state, 'ready');
    let n = 0;
    for (let i = 0; i < 100 && n === 0; i += 1) { n = (await c.memory.list({ namespace: 'sf1' })).rows.length; if (!n) await new Promise(r => setTimeout(r, 50)); }
    assert.strictEqual(n, 1, 'the row did commit once the load finished');
  } finally { if (savedMode === undefined) delete process.env.BELAY_TEST_MODE; else process.env.BELAY_TEST_MODE = savedMode; if (c) { await c.shutdownOwner(); await c.close(); } cleanup(dir); }
});

test('a warm wait over the pipe pings a wedged owner first and fails within the ping, not after 105 s (SF2)', async () => {
  const { spawn } = require('node:child_process');
  const dir = sandbox();
  let child = null, c = null;
  try {
    child = spawn(process.execPath, [`${ROOT}/tests/core/fixtures/owner-wedged.cjs`, dir, '6000'], { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
    const exited = new Promise(res => child.once('exit', res));
    let buf = '';
    child.stdout.on('data', d => { buf += d; });
    for (let i = 0; i < 400 && !buf.includes('READY'); i += 1) await new Promise(r => setTimeout(r, 25));
    assert.ok(buf.includes('READY'), `the wedged owner did not start: ${buf}`);
    await new Promise(r => setTimeout(r, 700)); // it is now wedged
    c = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
    const t0 = Date.now();
    const x = await c.memory.warm({ wait: true }).then(() => null, r => r);
    assert.ok(x, 'the call failed');
    assert.strictEqual(x.code, 'E_OWNER_LOST', `${x.code}: ${x.message}`);
    assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0} ms`);
    await exited;
  } finally {
    if (c) await c.close();
    if (child && child.exitCode === null) { try { process.kill(child.pid); } catch { /* gone */ } }
    cleanup(dir);
  }
});

test('an embed op that times out marks the embedder failed; later ops fail at once; reload kills the hung child and loads afresh', async t => {
  if (noVoyage) return t.skip(noVoyage);
  const saved = process.env.BELAY_TEST_MODE; process.env.BELAY_TEST_MODE = '1'; // the child's 'hang' op is test-only
  try { await withCore({}, async (c) => {
    await c.memory.warm({ wait: true });
    const hungObj = c.owner.embedderObj, hungPid = hungObj.pid;
    const x = await hungObj._call({ op: 'hang' }, 500).then(() => null, r => r); // a child that stops answering
    assert.strictEqual(x.code, 'E_EMBEDDER_TIMEOUT');
    assert.strictEqual(x.detail.phase, 'op');
    const w = await c.memory.warm({});
    assert.strictEqual(w.state, 'failed');
    const t0 = Date.now();
    const y = await c.memory.store({ namespace: 'hang', text: 'x' }).then(() => null, r => r);
    assert.strictEqual(y.code, 'E_EMBEDDER_TIMEOUT', y.message);
    assert.ok(Date.now() - t0 < 1000, 'the next op did not wait another bound');
    const r = await c.memory.warm({ wait: true, reload: true });
    assert.strictEqual(r.state, 'ready');
    assert.notStrictEqual(r.pid, hungPid);
    assert.strictEqual(hungObj.child, null, 'the hung child was closed');
    await c.memory.store({ namespace: 'hang', text: 'works after reload' });
  }); } finally { if (saved === undefined) delete process.env.BELAY_TEST_MODE; else process.env.BELAY_TEST_MODE = saved; }
});

test('a burst of slow but steady queued ops never marks the embedder hung; a silent child still does', async () => {
  const saved = process.env.BELAY_TEST_MODE; process.env.BELAY_TEST_MODE = '1';
  const { Embedder } = core('embedder.cjs');
  const e = new Embedder({ cacheDir: sandbox(), opBoundMs: 1000 });
  try {
    e._start();
    // five ops of 400 ms served one at a time: the last waits 2,000 ms, twice the 1,000 ms bound, but the child
    // answers every 400 ms, so it is never silent for the bound.
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => e._call({ op: 'sleep', ms: 400 }, 1000)));
    assert.strictEqual(rs.length, 5);
    assert.strictEqual(e.hung, null, 'steady slow ops did not mark the embedder hung');
    const x = await e._call({ op: 'hang' }, 600).then(() => null, r => r);
    assert.strictEqual(x.code, 'E_EMBEDDER_TIMEOUT');
    assert.ok(e.hung, 'a silent child is marked hung');
  } finally { await e.close(); if (saved === undefined) delete process.env.BELAY_TEST_MODE; else process.env.BELAY_TEST_MODE = saved; }
});
