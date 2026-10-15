'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1';
// run-interactive-nofit.test.cjs — ADR 0048 decision 4 and 7.8(b): a fast close whose identity snapshot cannot fit in
// the budget signals nothing. The snapshot here never answers (the limit of a stalled one), so the outcome does not
// depend on a clock the machine decides: the worker survives, its entry says why with the manual hint and the
// command that can still prove it, `ended_by` chains the deadline cause, and the run exits 1.

const { test } = require('node:test');
const assert = require('node:assert');

const H = require('./stop-helpers.cjs');
const { openCore } = require('../../src/core/index.cjs');
const RP = require('../../src/run/process.cjs');
const ID = require('../../src/core/proc-identity.cjs');
const { readCreated } = require('../helpers/created.cjs');
const { waitUntil, releaseCore } = H;
const { start, sleeper, withRun, fakeGate } = require('./run-interactive-helpers.cjs');

test('fast close with a snapshot that cannot fit: nothing is signalled, the receipt names no_budget or unverifiable, the hint and the chained cause, exit 1', async (t) => withRun(t, async (dir) => {
  const w = sleeper();
  const realShared = RP.snapshotShared; const realCore = ID.snapshotShared;
  try {
    const made = await readCreated(w.pid);
    const exitFile = `${dir}/claude-quit`;
    const r = start(dir, { env: { FAKE_EXIT_FILE: exitFile }, gate: fakeGate({ debugMs: 10, sessionMs: 20, firstMs: 10 }) });
    let core;
    try {
      assert.ok(await waitUntil(() => r.record(), 15000));
      core = await openCore({ dataDir: r.dataDir, caller: { role: 'orchestrator', run_id: r.runId, pid: process.pid } });
      assert.ok(await waitUntil(async () => (await core.run.get()).run, 15000));
      await core.worker.write({ id: 'w-nf', run_id: r.runId, substrate: 'claude-code', state: 'running', turns: 0, started_at: Date.now(), pid: w.pid, pid_created: made.created, pid_image: 'node.exe' });
      let asked = 0;
      const never = () => { asked++; return new Promise(() => {}); };
      RP.snapshotShared = never; ID.snapshotShared = never; // the snapshot that never answers, for every caller from here
      process.emit('SIGHUP');
      require('node:fs').writeFileSync(exitFile, 'x');
      const res = await r.done;
      assert.strictEqual(res.code, 1, 'a close that left a worker is never a clean exit');
      assert.ok(res.json.workers_closed, `no worker close ran: ${res.json.ended_by}`);
      const k = res.json.workers_closed.killed.find((x) => x.worker_id === 'w-nf');
      assert.ok(k, JSON.stringify(res.json.workers_closed));
      assert.ok(asked >= 1, 'the close did ask for a snapshot');
      assert.strictEqual(k.signalled, false, 'nothing is signalled without a proved identity');
      assert.strictEqual(k.gone, false);
      assert.ok(['no_budget', 'unverifiable'].includes(k.kind), JSON.stringify(k));
      assert.strictEqual(k.outcome, k.kind === 'no_budget' ? 'refused_no_budget' : 'refused_unverifiable');
      assert.match(k.manual, new RegExp(`Stop-Process -Id ${w.pid}`));
      assert.match(k.manual, /belay worker kill w-nf/);
      assert.match(res.json.ended_by, /^console closed \(fast close\); then worker close: fast close deadline passed during the run's worker close/, res.json.ended_by);
      assert.strictEqual(w.exitCode, null, 'the process must survive a close that could not prove it');
    } finally { RP.snapshotShared = realShared; ID.snapshotShared = realCore; await releaseCore(core); }
  } finally { require('../crash.cjs').crash(w); }
}));
