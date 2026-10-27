'use strict';
// B9: a stop that finds the worker's process already gone says so, and a parked worker (no process by design) is not that case.

const { test } = require('node:test');
const assert = require('node:assert');
const { createDoStop } = require('../../src/run/do-stop.cjs');
const { renderStopText } = require('../../src/cli/cmd-worker.cjs');

function fakeWorker(over = {}) {
  return { id: 'w1', pid: 2147483000, state: 'dead', queue: Promise.resolve(), exitCode: 1, exitSignal: null, sessionId: 's1', substrate: 'claude-code', ...over };
}
const ctx = { held: null };
const doStop = createDoStop({ ctx, writeRow: async () => {} });

test('a dead pid: already_exited, the row state it found, and a note', async () => {
  const r = await doStop(fakeWorker(), 'graceful', 1000);
  assert.strictEqual(r.already_exited, true);
  assert.strictEqual(r.state_before, 'dead');
  assert.match(r.note, /worker w1 had already exited \(pid 2147483000 is not running\); nothing was stopped/);
  assert.strictEqual(r.killed, false);
  assert.strictEqual(r.graceful, false);
});

test('a worker with no pid says it has no process', async () => {
  const r = await doStop(fakeWorker({ pid: null, state: 'starting' }), 'graceful', 1000);
  assert.strictEqual(r.already_exited, true);
  assert.match(r.note, /it has no process/);
});

test('a parked worker (treatPidAsDead) is not reported as already exited', async () => {
  const r = await doStop(fakeWorker({ state: 'paused' }), 'graceful', 1000, { treatPidAsDead: true });
  assert.strictEqual(r.already_exited, undefined);
  assert.strictEqual(r.note, undefined);
  assert.strictEqual(r.state_before, undefined);
});

test('the CLI text says the worker had already exited and nothing was stopped', () => {
  const text = renderStopText({ stopped: true, worker_id: 'w1', pid: 7, exit_code: 1, exit_signal: null, ms_to_exit: 0, killed: false, graceful: false, already_exited: true, session_id: 's1', established_by: 'x' });
  assert.match(text, /already exited, nothing stopped/);
  const plain = renderStopText({ stopped: true, worker_id: 'w1', pid: 7, exit_code: 0, ms_to_exit: 5, killed: false, graceful: true, session_id: null, established_by: 'x' });
  assert.match(plain, /graceful/);
});
