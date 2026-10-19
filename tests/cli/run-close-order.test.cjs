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
  assert.deepStrictEqual(core.calls, ['run.get', 'worker.list', 'worker.list']);
  assert.deepStrictEqual(killed, [], 'a worker the adapter closed during the wait is not killed');
  assert.deepStrictEqual(out.killed, []);
  assert.strictEqual(out.adapter_gone, true);
});

test('closeRunWorkers: a worker whose pid is dead when a slow second listing lands is not killed', async () => {
  const gate = deferred();
  const core = fakeCore({ adapterPid: null, lists: [[row()], async () => { await gate.promise; return [row()]; }] });
  let killCalls = 0;
  const p = closeRunWorkers({ core, runId: 'r1', graceMs: 1000, deps: { killProcess: async () => { killCalls += 1; return {}; } } });
  await tick(); await tick();
  gate.resolve();
  const out = await p;
  assert.strictEqual(killCalls, 0);
  assert.deepStrictEqual(out.killed, []);
  assert.deepStrictEqual(out.errors, []);
});
