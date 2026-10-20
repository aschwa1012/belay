'use strict';
// run-list.test.cjs — build step 4a, amendment A2: the
// run.list test moved into its own file so tests/core/methods.test.cjs stays at its pre-existing base
// content (953c498, 521 lines) — a recorded repository limit this step does not grow. The before/after
// scaffolding is methods.test.cjs's own: an orchestrator core elects the owner in-process, an operator
// core reaches it over the pipe, and the owner is stopped only through shutdownOwner() in after().

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { openCore } = core('index.cjs');

let dir, orch, operator;

before(async () => {
  dir = sandbox();
  orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
  operator = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
});

after(async () => {
  await operator.close();
  await orch.shutdownOwner(); // the only way to stop an owner; never a signal
  await orch.close();
  cleanup(dir);
});

test("run.list: every run's current row, newest first, with alive derived from the adapter pid", async () => {
  const second = await openCore({ dataDir: dir, caller: callerFor('orchestrator', { run_id: 'run-b' }), embed: false });
  try {
    await second.run.attach({ adapter_pid: process.pid });
    await second.run.end({ exit_reason: 'ended for the run.list test' });

    const { runs } = await operator.run.list({});
    const a = runs.find(r => r.id === 'test-run');
    const b = runs.find(r => r.id === 'run-b');
    assert.ok(a && b, 'both runs must be listed');
    assert.strictEqual(a.alive, true, 'test-run has never been ended and its adapter_pid is this live process');
    assert.strictEqual(b.alive, false, 'run-b was just ended');
    // "newest first" is asserted between these two rows specifically, never against the list's full
    // length, because other suites' fixtures are not this test's business: run-b's own end row is the
    // very last thing written to the store at this point, so its seq must sort ahead of test-run's.
    const ia = runs.findIndex(r => r.id === 'test-run');
    const ib = runs.findIndex(r => r.id === 'run-b');
    assert.ok(ib < ia, 'run-b (newest by seq) must sort ahead of test-run');
  } finally { await second.close(); }
});

test('run.list: life_pids names every adapter pid of the present life, so an orchestrator attach does not hide the launcher', async () => {
  const c = await openCore({ dataDir: dir, caller: callerFor('orchestrator', { run_id: 'run-launch' }), embed: false });
  try {
    const other = require('./helpers.cjs').deadPid();
    await c.run.attach({ adapter_pid: process.pid, adapter_pid_created: 4242 });
    await c.run.attach({ adapter_pid: other }); // the orchestrator's adapter overwrites the current row, then exits
    const r = (await operator.run.list({})).runs.find((x) => x.id === 'run-launch');
    assert.strictEqual(r.adapter_pid, other);
    assert.deepStrictEqual(r.life_pids, [{ pid: process.pid, created: 4242 }, { pid: other, created: null }]);
  } finally { await c.close(); }
});

test('run.list: life_pids covers only the present life of a reused run id, whatever the earlier lives recorded', async () => {
  const c = await openCore({ dataDir: dir, caller: callerFor('operator', { run_id: 'run-reused' }), embed: false });
  try {
    const { deadPid } = require('./helpers.cjs');
    const first = deadPid(), orch = deadPid();
    await c.run.attach({ adapter_pid: first, adapter_pid_created: 111 });
    await c.run.end({ exit_reason: 'first life' });
    let r = (await operator.run.list({})).runs.find((x) => x.id === 'run-reused');
    assert.deepStrictEqual(r.life_pids, [{ pid: first, created: 111 }], 'an ended run keeps the life that just ended');
    await c.run.attach({ adapter_pid: process.pid, adapter_pid_created: 777 }); // the run id is re-run by this process
    await c.run.attach({ adapter_pid: orch });
    await c.run.end({ exit_reason: 'second life' });
    r = (await operator.run.list({})).runs.find((x) => x.id === 'run-reused');
    assert.strictEqual(r.adapter_pid, orch);
    assert.deepStrictEqual(r.life_pids, [{ pid: process.pid, created: 777 }, { pid: orch, created: null }], "the first life's pid is not in the second life's list");
  } finally { await c.close(); }
});
