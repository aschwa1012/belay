'use strict';
require('../helpers/tmp.cjs');
// run-wait-store.test.cjs — the run wait and its receipt over a REAL sandbox store: one planned task refuted by its review, the policy step that
// makes the fix, the run wait over the real core, its claims, and the receipt a checker reads (wakes[] and digests[]). With
// BELAY_KEEP_SANDBOX=<dir> the store copy and the receipt are kept there for R1's h3.cjs. No model, no sleep: the wait's clock is the test's.

const { test: nodeTest } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, callerFor } = require('../core/helpers.cjs');
const { guarded } = require('../core/worktree-helpers.cjs');
const { createPolicyExecutor } = require('../../src/run/policy-exec.cjs');
const { createRunWait } = require('../../src/run/run-wait.cjs');
const D = require('../../src/run/run-digest.cjs');

const test = guarded(nodeTest);
const { openCore } = core('index.cjs');
const RUN = 'test-run';
const PLAN = { fix: 'builder', re_review: 'refuter', integrate: 'on_hold' };
const PASS = { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] };

test('a planned task, a refuted review, the policy fix, then the run wait: the step is in one digest and the receipt reads clean', async () => {
  const dir = sandbox();
  const orch = await openCore({ dataDir: `${dir}/data`, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
  const h = orch.harness();
  const workers = [];
  const worker = async (id) => {
    await orch.worker.write({ id, substrate: 'claude-code', pid: process.pid, state: 'idle', session_id: `s-${id}`, last_event_at: Date.now(), worktree: dir });
    const c = await openCore({ dataDir: `${dir}/data`, caller: callerFor('worker', { worker_id: id }), embed: false });
    workers.push(c);
    return c;
  };
  const handBack = async (workerId, task, result) => {
    const w = await worker(workerId);
    const a = await orch.task.assign({ task_id: task.id, worker_id: workerId });
    await w.lease.release({ lease_id: a.new_lease.id, reason: 'done', result });
    return h.task.evaluate({ task_id: task.id, worktree: dir, trigger: 'release' });
  };
  try {
    const work = await orch.task.create({ spec: 'work', acceptance: PASS, policy: PLAN });
    assert.strictEqual((await handBack('builder-1', work, { branch: 'b', head: 'h' })).state, 'done');
    const review = await orch.task.create({ spec: 'review', depends_on: [work.id], acceptance: { verdict: true } });
    await handBack('judge-1', review, { verdict: 'refuted', summary: 'no', findings: [{ severity: 'blocking', clause: 'a', note: 'finding' }] });
    const exec = createPolicyExecutor({ core: h, runId: RUN, assignFor: (stepCore) => async (a) => stepCore.task.assign(a), closeWaitMs: 0, identity: { pid: process.pid, created: 'own' } });
    exec.arm();
    assert.deepStrictEqual((await exec.tick()).steps.map((s) => [s.step, s.outcome]), [['fix', 'done']]);

    // A second planned task whose evaluation fails: an E5 exception, derived from the rows, which the wait delivers.
    const FAIL = { commands: [{ argv: [process.execPath, '-e', 'process.exit(1)'], timeout_ms: 20000 }] };
    const bad = await orch.task.create({ spec: 'bad', acceptance: FAIL, policy: { integrate: 'on_hold' } }); // no fix step: a failed evaluation is the E5 wake the run wait delivers
    assert.strictEqual((await handBack('builder-2', bad, { branch: 'b2', head: 'h2' })).state, 'released');

    const c = { t: 0, now: () => c.t, sleep: async (ms) => { c.t += ms; } };
    const rw = createRunWait({ core: h, runId: RUN, dataDir: `${dir}/data`, pollMs: 100, clock: c, claimant: { pid: process.pid, created: 'own' } });
    const first = await rw.wait({ ms: 300, t0: 0, workers: [] });
    assert.deepStrictEqual(first.exceptions.map((e) => [e.exception, e.task_id]), [['E5', bad.id]], JSON.stringify(first));
    assert.strictEqual(first.digest.steps, 1, JSON.stringify(first));
    assert.match(first.digest.text, /fix .* done -> task:/);
    const second = await rw.wait({ ms: 300, t0: c.t, workers: [] });
    assert.strictEqual(second.digest, undefined, 'the step is shown once');

    assert.deepStrictEqual(D.readDeliveries(`${dir}/data`, RUN, 0).map((w) => [w.via, w.exception, w.task_id]), [['wait', 'E5', bad.id]], 'the delivery is in the receipt');
    const receipt = { run_id: RUN, wakes: D.readDeliveries(`${dir}/data`, RUN, 0), ...(await D.receiptField(h, `${dir}/data`, RUN)) };
    const steps = orch.owner.engine.store.p('SELECT seq FROM policy_step').all().map((r) => r.seq);
    const shown = receipt.digests.flatMap((d) => d.lines.map((l) => l.step_seq));
    assert.deepStrictEqual(shown.sort(), steps.sort(), 'every step is in exactly one digest');
    assert.strictEqual(receipt.digests.reduce((n, d) => n + d.dropped.count, 0), 0);
    if (process.env.BELAY_KEEP_SANDBOX) {
      fs.mkdirSync(process.env.BELAY_KEEP_SANDBOX, { recursive: true });
      fs.writeFileSync(path.join(process.env.BELAY_KEEP_SANDBOX, 'run-receipt.json'), JSON.stringify(receipt, null, 1));
    }
  } finally {
    for (const w of workers) await w.close();
    try { await orch.shutdownOwner(); } finally { await orch.close(); if (process.env.BELAY_KEEP_SANDBOX) fs.cpSync(`${dir}/data`, `${process.env.BELAY_KEEP_SANDBOX}/store`, { recursive: true }); }
  }
});
