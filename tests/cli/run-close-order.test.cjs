'use strict';
process.env.BELAY_TEST_MODE = '1';
// run-close-order.test.cjs — the ordering inside closeRunWorkers (src/cli/run-close.cjs), forced with a stalled
// adapter wait and a stalled listing. No process, no store, no timer: the fake core and the wait seam hold each
// call until the test releases it, so the order is the test's, not the host's.

const { test } = require('node:test');
const assert = require('node:assert');
const { closeRunWorkers } = require('../../src/cli/run-close.cjs');

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const DEAD_PID = 2147483000; // above any pid this host hands out
const tick = () => new Promise((r) => setImmediate(r));
const row = (over) => ({ id: 'w1', run_id: 'r1', substrate: 'claude-code', state: 'stopping', pid: DEAD_PID, ...over });

function fakeCore({ adapterPid, lists }) {
  const calls = [];
  return {
    calls,
    run: { get: async () => { calls.push('run.get'); return { run: { adapter_pid: adapterPid } }; } },
    worker: { list: async () => { calls.push('worker.list'); const next = lists.shift(); return { workers: typeof next === 'function' ? await next() : next }; } },
  };
}

test('closeRunWorkers: the worker rows are listed again after the adapter wait, so a row the adapter closed during it is not killed', async () => {
  const gate = deferred();
  // The adapter pid is this process (alive); the wait seam answers only when the test releases it.
  const core = fakeCore({ adapterPid: process.pid, lists: [[row({ pid: process.pid })], [row({ state: 'dead', pid: process.pid })]] });
  const killed = [];
  const p = closeRunWorkers({
    core, runId: 'r1', graceMs: 1000, ownPid: -1,
    deps: { waitPidGone: async () => { await gate.promise; return 5; }, killProcess: async (t) => { killed.push(t); return {}; } },
  });
  await tick(); await tick();
  assert.deepStrictEqual(core.calls, ['run.get', 'worker.list'], 'the close is parked in the adapter wait, before the second listing');
  gate.resolve(); // the adapter wrote the worker final row while it was waited for
  const out = await p;
  assert.deepStrictEqual(core.calls, ['run.get', 'worker.list', 'worker.list', 'run.get'], 'the last run.get is the late-adapter check');
  assert.deepStrictEqual(killed, [], 'a worker the adapter closed during the wait is not killed');
  assert.deepStrictEqual(out.killed, []);
  assert.strictEqual(out.adapter_gone, true);
});

test('closeRunWorkers: a worker whose pid is dead when a slow second listing lands is not killed', async () => {
  const gate = deferred();
  // The first listing shows the row with a live pid (this process), the slow second one the same worker with a dead pid. A close
  // that reused its first listing would kill the live pid; the one that lists again acts on the second.
  const core = fakeCore({ adapterPid: null, lists: [[row({ state: 'running', pid: process.pid })], async () => { await gate.promise; return [row({ state: 'running' })]; }] });
  let killCalls = 0;
  const p = closeRunWorkers({ core, runId: 'r1', graceMs: 1000, deps: { killProcess: async () => { killCalls += 1; return {}; } } });
  await tick(); await tick();
  gate.resolve();
  const out = await p;
  assert.strictEqual(killCalls, 0);
  assert.deepStrictEqual(out.killed, []);
  assert.deepStrictEqual(out.errors, []);
});

// ADR 0029 amendment 4 (proposed): an adapter whose attach landed while the close ran is not the one the close first read.
// The row is read again before run.end; the late adapter is waited for, and its workers listed and closed after it.
test('closeRunWorkers: an adapter that registers while the close runs is waited for before the close returns', async () => {
  const gets = [null, process.pid, process.pid]; // the run row names no adapter, then (attach landed) a live one
  const calls = [];
  const core = {
    run: { get: async () => { calls.push('run.get'); return { run: { adapter_pid: gets.shift() } }; } },
    worker: { list: async () => { calls.push('worker.list'); return { workers: [] }; } },
  };
  const waited = [];
  const out = await closeRunWorkers({ core, runId: 'r1', graceMs: 1000, ownPid: -1, deps: { waitPidGone: async (pid) => { waited.push(pid); return 7; }, killProcess: async () => ({}) } });
  assert.deepStrictEqual(waited, [process.pid], 'the late adapter was waited for');
  assert.strictEqual(out.adapter_pid, null, 'the receipt keeps the adapter the first read named (none)');
  assert.deepStrictEqual(out.late_adapter_pids, [process.pid]);
  assert.strictEqual(calls.filter((c) => c === 'run.get').length, 3, 'one read per round: the pid waited for is the pid that read named');
  assert.strictEqual(out.adapter_gone, true);
  assert.ok(calls.filter((c) => c === 'worker.list').length >= 4, 'the workers were listed again after the late adapter');
});

// ADR 0029 amendment 4 (proposed): the orchestrator's children are found from ONE snapshot with the creation time recorded at spawn, so
// an adapter whose attach has not landed is still waited for, by exact pid. A stale parent pid (a child created before the orchestrator)
// and another image are not.
test('closeRunWorkers: a child of the orchestrator that has not attached is waited for by pid; an older or other-image process is not', async () => {
  const ID = require('../../src/core/proc-identity.cjs');
  const ORCH = { pid: 9000, created: 1000 };
  const snap = new Map(); // the orchestrator itself is gone: an orphan keeps its recorded parent
  snap.set(process.pid, { ppid: ORCH.pid, created: 2000, image: ID.ownImage() }); // the unregistered adapter (alive: this process stands in)
  snap.set(process.pid + 1, { ppid: ORCH.pid, created: 500, image: ID.ownImage() }); // created before the orchestrator: a recycled parent pid
  snap.set(process.pid + 2, { ppid: ORCH.pid, created: 2000, image: 'bash.exe' }); // another image
  const core = fakeCore({ adapterPid: null, lists: [[], []] });
  const waited = [];
  const out = await closeRunWorkers({ core, runId: 'r1', graceMs: 1000, ownPid: -1, orchestrator: async () => ORCH, deps: { snapshot: async () => snap, waitPidGone: async (pid) => { waited.push(pid); return 4; }, killProcess: async () => ({}) } });
  assert.deepStrictEqual(waited, [process.pid]);
  assert.deepStrictEqual(out.unregistered_adapter_pids, [process.pid]);
  assert.strictEqual(out.adapter_gone, true);
});

test('closeRunWorkers: an unreadable snapshot or no recorded orchestrator waits for no one it cannot name', async () => {
  const waited = [];
  const deps = { waitPidGone: async (pid) => { waited.push(pid); return 1; }, killProcess: async () => ({}) };
  await closeRunWorkers({ core: fakeCore({ adapterPid: null, lists: [[], []] }), runId: 'r1', graceMs: 1000, ownPid: -1, orchestrator: async () => ({ pid: 9000, created: 1000 }), deps: { ...deps, snapshot: async () => null } });
  await closeRunWorkers({ core: fakeCore({ adapterPid: null, lists: [[], []] }), runId: 'r1', graceMs: 1000, ownPid: -1, orchestrator: async () => null, deps: { ...deps, snapshot: async () => { throw new Error('not called'); } } });
  assert.deepStrictEqual(waited, []);
});

test('closeRunWorkers: a run row that still names the handled adapter is not waited for twice', async () => {
  const core = fakeCore({ adapterPid: process.pid, lists: [[], [], [], []] });
  const waited = [];
  await closeRunWorkers({ core, runId: 'r1', graceMs: 1000, ownPid: -1, deps: { waitPidGone: async (pid) => { waited.push(pid); return 3; }, killProcess: async () => ({}) } });
  assert.deepStrictEqual(waited, [process.pid]);
});
