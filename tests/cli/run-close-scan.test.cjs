'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1';
// run-close-scan.test.cjs — the close's scan for an orchestrator adapter that has not registered yet (ADR 0029 amendment 4).
//   * An interactive run always has a fast-close object, whether or not a console close was requested; only a REQUESTED one
//     skips the scan (audit D36).
//   * The two orderings of the close's run-row read and the adapter's late attach, forced with a stub core instead of left to
//     timing: the attach before the read names the child as the run's adapter, the attach after names it as unregistered. The
//     built-CLI test (run-close-unregistered) cannot choose between them, and accepts both.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { closeRunWorkers } = require('../../src/cli/run-close.cjs');
const ID = require('../../src/core/proc-identity.cjs');

const sleeper = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { windowsHide: true, stdio: 'ignore' });
const stubCore = (adapterPid) => ({ run: { get: async () => ({ run: { adapter_pid: adapterPid } }) }, worker: { list: async () => ({ workers: [] }) } });
const ORCH = { pid: 424242, created: 1000 };

function seams(child) {
  const scans = [], waited = [];
  const snap = new Map([[child.pid, { ppid: ORCH.pid, created: 2000, image: ID.ownImage() }]]);
  return {
    scans, waited,
    deps: {
      snapshot: async (o) => { scans.push(o && o.kind); return snap; },
      waitPidGone: async (pid) => { waited.push(pid); return 1; },
      killProcess: async () => ({ tree: null, pidKill: { signalled: false } }),
    },
  };
}
const gone = (c) => { try { c.kill(); } catch { /* already gone */ } };

test('run close scan: a present but unrequested fast close still scans, and waits for the unregistered child', async () => {
  const child = sleeper();
  try {
    const s = seams(child);
    const out = await closeRunWorkers({ core: stubCore(process.pid), runId: 'r1', graceMs: 100, orchestrator: ORCH, deps: s.deps, fast: { requested: () => false } });
    assert.deepStrictEqual(s.scans, ['adapter-scan'], 'the scan ran');
    assert.deepStrictEqual(out.unregistered_adapter_pids, [child.pid]);
    assert.deepStrictEqual(s.waited, [child.pid], 'the child was waited for by exact pid');
  } finally { gone(child); }
});

test('run close scan: a requested fast close does not scan', async () => {
  const child = sleeper();
  try {
    const s = seams(child);
    const out = await closeRunWorkers({ core: stubCore(process.pid), runId: 'r1', graceMs: 100, orchestrator: ORCH, deps: s.deps, fast: { requested: () => true } });
    assert.deepStrictEqual(s.scans, []);
    assert.strictEqual(out.unregistered_adapter_pids, undefined);
  } finally { gone(child); }
});

test('run close scan: an attach that lands before the close reads the run row names the child as the adapter, not as unregistered', async () => {
  const child = sleeper();
  try {
    const s = seams(child);
    const out = await closeRunWorkers({ core: stubCore(child.pid), runId: 'r1', graceMs: 100, orchestrator: ORCH, deps: s.deps });
    assert.strictEqual(out.adapter_pid, child.pid);
    assert.strictEqual(out.unregistered_adapter_pids, undefined, 'the same pid is never reported twice');
    assert.deepStrictEqual(s.waited, [child.pid], 'and it is waited for once, as the adapter');
  } finally { gone(child); }
});
