'use strict';
require('../helpers/tmp.cjs');
// policy-fix-cap.test.cjs — a policy run with max_fix_rounds and no fix_hard_cap (a run with a timeout) stops fixing at the cap and
// raises the cap's exception, against the REAL core on a sandbox store. No model, no sleep.

const { test: nodeTest } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('../core/helpers.cjs');
const { guarded } = require('../core/worktree-helpers.cjs');
const { createPolicyExecutor } = require('../../src/run/policy-exec.cjs');
const PW = require('../../src/run/policy-wakes.cjs');

const test = guarded(nodeTest);
const { openCore } = core('index.cjs');
const RUN = 'test-run';
const PLAN = { fix: 'builder', re_review: 'refuter', integrate: 'on_hold' };
const PASS = { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] };
const refute = (n) => ({ verdict: 'refuted', summary: `r${n}`, findings: [{ severity: 'blocking', clause: 'a', note: `f${n}` }] });

async function capCase(attach) { // -> what the rounds made: the fix steps, the E2 wakes, the fix rows
  const dir = sandbox();
  const orch = await openCore({ dataDir: `${dir}/data`, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid, ...attach });
  const h = orch.harness();
  const workers = new Map();
  const worker = async (id) => {
    if (workers.has(id)) return workers.get(id);
    await orch.worker.write({ id, substrate: 'claude-code', pid: process.pid, state: 'idle', session_id: `s-${id}`, last_event_at: Date.now(), worktree: dir });
    const c = await openCore({ dataDir: `${dir}/data`, caller: callerFor('worker', { worker_id: id }), embed: false });
    workers.set(id, c);
    return c;
  };
  const evaluate = (id) => h.task.evaluate({ task_id: id, worktree: dir, trigger: 'release' });
  const handIn = async (wid, task, result) => {
    const w = await worker(wid);
    const a = await orch.task.assign({ task_id: task.id, worker_id: wid });
    await w.lease.release({ lease_id: a.new_lease.id, reason: 'done', result });
    return evaluate(task.id);
  };
  const x = createPolicyExecutor({ core: h, runId: RUN, assignFor: (s) => async (a) => s.task.assign(a), closeWaitMs: 0, identity: { pid: process.pid, created: 'own' } });
  x.arm();
  try {
    const work = await orch.task.create({ spec: 'w', acceptance: PASS, policy: PLAN });
    assert.strictEqual((await handIn('builder', work, { branch: 'b', head: 'h' })).state, 'done');
    const r0 = await orch.task.create({ spec: 'review', depends_on: [work.id], acceptance: { verdict: true } });
    await handIn('judge', r0, refute(0));
    const fixSteps = [];
    let noticeTick = null;
    for (let round = 1; round <= 6; round++) {
      const a = await x.tick();
      const fix = a.steps.find((s) => s.step === 'fix');
      if (!fix) break;
      fixSteps.push(fix);
      if (fix.outcome !== 'done') { noticeTick = await x.tick(); break; }
      await handIn('builder', { id: fix.row_ref.replace('task:', '') }, { branch: 'b', head: `h${round}` });
      const b = await x.tick();
      const rr = b.steps.find((s) => s.step === 're_review');
      if (!rr) break;
      await handIn('judge', { id: rr.row_ref.replace('task:', '') }, refute(round));
    }
    const tasks = (await h.task.list({})).tasks;
    const steps = (await h.policy.list({})).rows;
    const revisions = await PW.readRevisions(h.policy, RUN, tasks);
    const ex = PW.derive({ runId: RUN, tasks, integrations: (await h.integration.list({})).integrations || [], steps, failures: [], revisions });
    const e2 = ex.filter((z) => z.exception === 'E2' && !z.lifted);
    const fixRows = tasks.filter((t) => t.repairs === work.id);
    const leaseOf = (id) => { const t = tasks.find((o) => o.id === id); return !!(t && t.lease && t.lease.holder); };
    const errorOf = (ref) => String((steps.find((z) => z.step === 'fix' && z.row_ref === ref) || {}).error || '');
    return { errorOf, fixSteps, noticeTick, e2, fixRows, leaseOf, tasks };
  } finally {
    await x.close();
    for (const c of workers.values()) await c.close();
    try { await orch.shutdownOwner(); } finally { await orch.close(); cleanup(dir); }
  }
}

test('no hard cap: max_fix_rounds 2 makes two fixes, then the derived E2 wakes', async () => {
  const r = await capCase({ max_fix_rounds: 2 });
  assert.deepStrictEqual(r.fixSteps.map((s) => s.outcome), ['done', 'done']);
  assert.strictEqual(r.e2.length, 1);
});

test('hard cap 5, max_fix_rounds 2: the third fix is made with the notice, left unassigned, and wakes E2', async () => {
  const r = await capCase({ max_fix_rounds: 2, fix_hard_cap: 5 });
  assert.deepStrictEqual(r.fixSteps.map((s) => s.outcome), ['done', 'done', 'exception']);
  assert.match(r.errorOf(r.fixSteps[2].row_ref), /fix_notice/);
  assert.strictEqual(r.fixRows.length, 3);
  assert.strictEqual(r.leaseOf(r.fixSteps[2].row_ref.replace('task:', '')), false, 'no lease on the notice fix');
  assert.strictEqual(r.e2.length, 1);
  assert.deepStrictEqual(r.noticeTick.steps, [], 'no further step on a later tick');
});

test('max_fix_rounds 0 with a hard cap: the first fix wakes', async () => {
  const r = await capCase({ max_fix_rounds: 0, fix_hard_cap: 5 });
  assert.deepStrictEqual(r.fixSteps.map((s) => s.outcome), ['exception']);
  assert.strictEqual(r.fixRows.length, 1);
  assert.strictEqual(r.e2.length, 1);
});

test('max_fix_rounds at or above the hard cap: E2 at rounds_left 0 after the last allowed fix', async () => {
  const r = await capCase({ max_fix_rounds: 3, fix_hard_cap: 2 });
  assert.deepStrictEqual(r.fixSteps.map((s) => s.outcome), ['done', 'done']);
  assert.strictEqual(r.fixRows.length, 2);
  assert.strictEqual(r.e2.length, 1);
});
