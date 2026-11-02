'use strict';
require('../helpers/temp-root.cjs').enforceSafeTemp(process.env); // scratch never lands in an indexed folder, even for a bare `node file`
// The creation-time restatement (write-row.cjs restatePidCreated) writes the worker's current state again once the spawn read lands.
// A worker that died while `starting`, before the adapter processed its exit, must not be restated as `starting`: that row is a new
// seq in a life-claiming state, and the run's dead-pid memory would read it as a new life while the dead pid may be reused.
const test = require('node:test');
const assert = require('node:assert');
const { restatePidCreated } = require('../../src/run/write-row.cjs');
const { createDeadPids } = require('../../src/run/dead-pids.cjs');
const { deadPid } = require('../helpers/dead-pid.cjs');

function record(o) {
  return { state: 'starting', pid: process.pid, settled: false, settledState: null, pidCreated: 123, pidCreatedError: null, lastRowHadPidCreated: false, launches: 1, queue: Promise.resolve(), lastError: null, ...o };
}
async function restateOf(o, force = false) {
  const writes = [];
  const w = record(o);
  restatePidCreated(w, { writeRow: async (_w, state) => { writes.push(state); } }, force);
  await w.queue;
  return writes;
}

test('a starting worker whose pid is gone before its exit is processed is not restated', async () => {
  assert.deepStrictEqual(await restateOf({ pid: deadPid() }), []);
  assert.deepStrictEqual(await restateOf({ pid: deadPid() }, true), [], 'nor on the forced restatement');
});

test('a live pid, or a settled exit, is restated as before', async () => {
  assert.deepStrictEqual(await restateOf({}), ['starting']);
  assert.deepStrictEqual(await restateOf({ pid: deadPid(), settled: true, state: 'dead' }), ['dead']);
});

test('the dead-pid memory keeps the pid dead through a reused-pid poll when no restatement lands', async () => {
  const mem = createDeadPids();
  const row = (alive) => ({ id: 'w', state: 'starting', pid: 4242, pid_created: null, seq: 1, pid_alive: alive });
  mem.apply([row(false)]);
  assert.strictEqual((await restateOf({ pid: deadPid() })).length, 0, 'no new row');
  assert.strictEqual(mem.apply([row(true)])[0].pid_alive, false);
  // the restatement the fix removes would have been a `starting` row with a new seq: a new life
  assert.strictEqual(mem.apply([{ ...row(true), seq: 2 }])[0].pid_alive, true);
});
