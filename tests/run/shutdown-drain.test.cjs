'use strict';
// shutdown-drain.test.cjs — build step 6i-2, design item 3
// (R4; the tests/cli/pause.test.cjs hang; src/run/lifecycle.cjs:63-86, src/run/manager.cjs:58 moved to
// src/run/write-row.cjs). The mechanism the review recorded: after shutdown() has called
// core.shutdownOwner(), a late worker-row write (the exit-code fill-in a settled record's own "already
// settled" branch queues, exit.cjs) re-elects a store owner inside the same process — nothing shuts the
// new owner down, and its pipe server keeps the process alive (invariant 2). A synthetic child (an
// EventEmitter with stdout/stderr, as 6i's (r7) does) is settled by pid-poll first, `shutdown()` runs,
// and only then does the child's own 'exit' land — the exact shape of the leak.

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { newWorkerRecord, attach } = require('../../src/run/worker.cjs');
const { settle } = require('../../src/run/exit.cjs');
const { shutdown } = require('../../src/run/lifecycle.cjs');
const { createWriteRow } = require('../../src/run/write-row.cjs');

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.pid = 40000 + Math.floor(Math.random() * 10000);
  return child;
}

// A fake core whose worker.write "elects a store owner" the way a real client write does (invariant 2):
// tracked here since showing no election is what this test exists to do, never a real client.
function fakeCore() {
  let elected = false;
  const writes = [];
  return {
    worker: { write: async (row) => { elected = true; writes.push(row); return { ...row, seq: writes.length }; } },
    isOwner: () => elected,
    shutdownOwner: async () => { elected = false; },
    get elected() { return elected; },
    get writes() { return writes; },
  };
}

test('shutdown: a worker write arriving after shutdown elects no store owner and is recorded as dropped', async () => {
  const core = fakeCore();
  const w = newWorkerRecord({ id: 'w1', substrate: 'claude-code', worktree: __dirname, dataDir: __dirname });
  const flags = { closed: false };
  const ctx = { core, runId: 'run-shutdown-drain', adapterPid: process.pid, writeRow: null };
  ctx.writeRow = createWriteRow(ctx, flags);
  const child = fakeChild();
  attach(w, child, ctx);

  // pid-poll settles the worker first (the manager's own 1,000 ms poll finding the pid gone), and its
  // own dead-row write lands well before shutdown ever runs.
  settle(w, null, null, 'pid-poll', ctx);
  assert.strictEqual(w.settled, true);
  await w.queue;
  assert.strictEqual(core.elected, true, "the pid-poll's own write must have elected an owner, or this test proves nothing");

  const workers = new Map([['w1', w]]);
  const receipt = await shutdown(workers, {
    stop: async () => {}, core, clearPoll: () => {}, markClosed: () => { flags.closed = true; },
  });
  assert.deepStrictEqual(receipt.stopped, ['w1']);
  // ADR 0029 amendment 2 item 4: the head follow-up is now drained inside shutdown, before the flag flips, so
  // it may land here; what must not reach core is anything arriving after shutdown has returned.
  const writesBeforeShutdown = core.writes.length;
  assert.strictEqual(core.elected, false, 'shutdown must leave no owner elected in this process');

  // The late channel: the OS exit event for the SAME child, arriving only now — exit.cjs's own
  // already-settled branch queues the fill-in write this finding is about.
  child.emit('exit', 9, null);
  await w.queue;

  assert.strictEqual(core.elected, false, 'a worker write arriving after shutdown must elect no store owner');
  assert.strictEqual(core.writes.length, writesBeforeShutdown, 'a write arriving after shutdown must never reach core');
  assert.strictEqual(w.exitCode, 9, 'the late exit code must still be set on the record');
  assert.deepStrictEqual(w.lastError, { where: 'after-shutdown', state: w.settledState }, 'the dropped write must be named on the record');
});
