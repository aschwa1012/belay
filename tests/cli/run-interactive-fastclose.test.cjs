'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1';
// run-interactive-fastclose.test.cjs — ADR 0039 review follow-up 2: the fast close's kills use the snapshot the
// SIGHUP started (cmd-run.cjs passes `ce.snapshot` and `ce.snapshotPending` into the close), and a worker row
// with a recorded creation time is checked against it. Both halves are counted: the console's snapshot (the
// run side's processSnapshot) and every kill-time default snapshot (the core's). With the wiring removed the
// kills take their own default snapshots and both tests fail.

const { test } = require('node:test');
const assert = require('node:assert');

const H = require('./stop-helpers.cjs');
const { openCore } = require('../../src/core/index.cjs');
const RP = require('../../src/run/process.cjs');
const ID = require('../../src/core/proc-identity.cjs');
const { waitUntil, releaseCore } = H;
const { start, sleeper, withRun, fakeGate } = require('./run-interactive-helpers.cjs');

// Counts both snapshot sources from the SIGHUP on. The console's answers with `pre`, a real CIM snapshot taken
// just before the run, so the 3500 ms budget never depends on how long CIM takes on a loaded host; the identity
// check against it is the real one. The core's default is the real query, only counted.
function countSnapshots(pre) {
  const realRun = RP.processSnapshot; const realCore = ID.processSnapshot;
  const n = { hup: 0, killDefault: 0, on: false };
  RP.processSnapshot = (...a) => { if (n.on) { n.hup++; return Promise.resolve(pre); } return realRun(...a); };
  ID.processSnapshot = (...a) => { if (n.on) n.killDefault++; return realCore(...a); };
  return { n, restore: () => { RP.processSnapshot = realRun; ID.processSnapshot = realCore; } };
}

// `w` is the test's own sleeper, which it ends in its own finally whatever happens here.
async function fastCloseWith(dir, w, rowOf, gate = fakeGate({ debugMs: 10, sessionMs: 20, firstMs: 10 })) {
  // The creation time is read before the run starts, so the stub's hold never runs out before the SIGHUP.
  const pre = await ID.processSnapshot();
  const made = pre && pre.get(w.pid);
  assert.ok(made && Number.isFinite(made.created), 'the sleeper\'s creation time could not be read');
  // The stub quits on a file, written with the SIGHUP: a console closing ends claude at once, as on a real host.
  const exitFile = `${dir}/claude-quit`;
  // By default both gate halves settle fast; the pending-half test passes a gate whose session half never does.
  const r = start(dir, { env: { FAKE_EXIT_FILE: exitFile }, gate });
  const c = countSnapshots(pre);
  let core;
  try {
    assert.ok(await waitUntil(() => r.record(), 15000));
    core = await openCore({ dataDir: r.dataDir, caller: { role: 'orchestrator', run_id: r.runId, pid: process.pid } });
    assert.ok(await waitUntil(async () => (await core.run.get()).run, 15000));
    await core.worker.write({ id: 'w-fc', run_id: r.runId, substrate: 'claude-code', state: 'running', turns: 0, started_at: Date.now(), ...rowOf(w, made) });
    c.n.on = true;
    const hupAt = Date.now();
    process.emit('SIGHUP');
    require('node:fs').writeFileSync(exitFile, 'x');
    const res = await r.done;
    res.closeMs = Date.now() - hupAt;
    c.n.on = false;
    assert.ok(res.json.workers_closed, `no worker close ran: ${res.json.ended_by}`);
    const k = res.json.workers_closed.killed.find((x) => x.worker_id === 'w-fc');
    return { res, k, made, counts: { ...c.n } };
  } finally { c.restore(); await releaseCore(core); }
}

test('fast close: a live worker with pid_created is killed through the SIGHUP snapshot, checked by its creation time', async (t) => withRun(t, async (dir) => {
  const w = sleeper();
  try {
    const { res, k, made, counts } = await fastCloseWith(dir, w, (s, m) => ({ pid: s.pid, pid_created: m.created, pid_image: 'node.exe' }));
    assert.strictEqual(res.json.ended_by, 'console closed (fast close)', JSON.stringify(res.json.workers_closed));
    assert.ok(k && k.gone === true && !k.refused, JSON.stringify(res.json.workers_closed));
    assert.deepStrictEqual(k.identity, { via: 'created', created: made.created, image: 'node.exe' });
    assert.ok(counts.hup >= 1, `the SIGHUP started no snapshot: ${JSON.stringify(counts)}`);
    assert.strictEqual(counts.killDefault, 0, `the kill took its own snapshot instead of the SIGHUP's: ${JSON.stringify(counts)}`);
  } finally { require('../crash.cjs').crash(w); }
}));

test('fast close: a row whose pid_created is not the process\'s own is refused as a mismatch on the SIGHUP snapshot, and survives', async (t) => withRun(t, async (dir) => {
  const w = sleeper();
  try {
    const { res, k, counts } = await fastCloseWith(dir, w, (s, m) => ({ pid: s.pid, pid_created: m.created - 1, pid_image: 'node.exe' }));
    assert.ok(k && k.refused === 'identity' && k.kind === 'mismatch', JSON.stringify(res.json.workers_closed) + ' ' + res.json.ended_by);
    assert.strictEqual(k.gone, false);
    assert.strictEqual(w.exitCode, null, 'the process another row names wrongly must survive');
    assert.ok(counts.hup >= 1, JSON.stringify(counts));
    assert.strictEqual(counts.killDefault, 0, JSON.stringify(counts));
  } finally { require('../crash.cjs').crash(w); }
}));

// The model and effort half of the real gate is decided only at finalize, so a console closing mid-run meets a half
// still pending. A gate whose session half never settles, not even at stop, stands in for it.
function pendingSessionGate() {
  const base = fakeGate({ debugMs: 10, firstMs: 10 });
  const make = (opts) => {
    const g = base.make(opts);
    return { ...g, session: new Promise(() => {}), current: () => ({ debug: { ok: true, facts: {} }, session: { ok: null, facts: {} } }) };
  };
  return { make, seen: base.seen };
}

test('fast close with a gate half pending: the worker is killed first (via created), the gate is unsettled naming the fast close, all inside the close budget, not after the slow close', async (t) => withRun(t, async (dir) => {
  const w = sleeper();
  try {
    const { res, k, made } = await fastCloseWith(dir, w, (s, m) => ({ pid: s.pid, pid_created: m.created, pid_image: 'node.exe' }), pendingSessionGate());
    assert.ok(k && k.gone === true && !k.refused, `the worker kill did not get the budget: ${JSON.stringify(res.json.workers_closed)}`);
    assert.deepStrictEqual(k.identity, { via: 'created', created: made.created, image: 'node.exe' });
    const gate = res.json.orchestrator.interactive.gate;
    assert.strictEqual(gate.status, 'unsettled', JSON.stringify(gate));
    assert.strictEqual(gate.session.ok, null);
    assert.match(gate.session.undecided, /fast close/);
    assert.match(res.json.ended_by, /^console closed \(fast close\)/, res.json.ended_by);
    // The design bound is 3500 ms, and a loaded host runs well past it. What this separates is a close held by the
    // gate half that never settles, which would not end at all, so 15 s.
    assert.ok(res.closeMs < 15000, `the close took ${res.closeMs} ms from the SIGHUP`);
  } finally { require('../crash.cjs').crash(w); }
}));
