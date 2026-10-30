'use strict';
require('../helpers/tmp.cjs');
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1';
// run-close-adapter-identity.test.cjs — the close waits for the run row's adapter by pid. A pid another process now holds answers a
// pid check for good, so the close waited its whole bound for a process that was never the adapter. The row records the adapter's
// creation time (adapter_pid_created); a pid that answers is the adapter only if that time matches. This process stands for the
// reused pid (it answers a pid check), and `prepare` stands for the identity check: false is "another creation time".

const { test } = require('node:test');
const assert = require('node:assert');
const { closeRunWorkers } = require('../../src/cli/run-close.cjs');

const BORN = 1234567;
const stub = (rows) => { let i = 0; return { run: { get: async () => ({ run: rows[Math.min(i++, rows.length - 1)] }) }, worker: { list: async () => ({ workers: [] }) } }; };
function seams(runsAs) {
  const waited = [], asked = [];
  return {
    waited, asked,
    deps: {
      prepare: async (pairs) => { asked.push(pairs); return { runsAs: () => runsAs }; },
      waitPidGone: async (pid) => { waited.push(pid); return 1; },
      killProcess: async () => ({ tree: null, pidKill: { signalled: false } }),
    },
  };
}
const close = (core, deps, extra = {}) => closeRunWorkers({ core, runId: 'r1', graceMs: 100, ownPid: 1, deps, ...extra });

test('an adapter pid held by another process is not waited on', async () => {
  const s = seams(false);
  const out = await close(stub([{ adapter_pid: process.pid, adapter_pid_created: BORN }]), s.deps);
  assert.deepStrictEqual(s.asked, [[{ pid: process.pid, created: BORN }]], 'identity asked with the creation time the row recorded');
  assert.deepStrictEqual(s.waited, [], 'no wait for a process that is not the adapter');
  assert.strictEqual(out.adapter_gone, true);
  assert.strictEqual(out.adapter_wait_ms, 0);
});

test('the same pid with the recorded creation time is the adapter and is waited on; a row with no recorded time keeps the pid check', async () => {
  const s = seams(true);
  await close(stub([{ adapter_pid: process.pid, adapter_pid_created: BORN }]), s.deps);
  assert.deepStrictEqual(s.waited, [process.pid]);
  const t = seams(false);
  await close(stub([{ adapter_pid: process.pid }]), t.deps);
  assert.deepStrictEqual([t.asked.length, t.waited], [0, [process.pid]], 'no creation time recorded: no snapshot, the pid check as before');
});

test('a late adapter attach whose pid is held by another process starts no second pass', async () => {
  const s = seams(false);
  const out = await close(stub([{ adapter_pid: null }, { adapter_pid: process.pid, adapter_pid_created: BORN }]), s.deps);
  assert.strictEqual(out.late_adapter_pids, undefined, 'no late pass for a reused pid');
  assert.deepStrictEqual(s.waited, []);
});
