'use strict';
require('../helpers/tmp.cjs');
// policy-exec-core.test.cjs — the policy executor against the REAL core: an in-process Engine on a sandbox store, git repositories built in
// the test, workers that hand back through their own cores. The claim, the stamp (acted_by, trigger, policy_rev) and the policyAs view are
// the core's own (policy-steps.cjs, policy-stamp.cjs); only the delivery of a task to a worker (compose's message) is left out, because no
// process runs. One test per step (fix, re_review, integrate), the orchestrator acting first, and a paused run. No model, no sleep.

const { test: nodeTest } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('../core/helpers.cjs');
const { makeRepo, write, commit, guarded } = require('../core/worktree-helpers.cjs');
const { createPolicyExecutor } = require('../../src/run/policy-exec.cjs');

const test = guarded(nodeTest);
const { openCore } = core('index.cjs');
const RUN = 'test-run';
const PLAN = { fix: 'builder', re_review: 'refuter', integrate: 'on_hold' };
const PASS = { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] };

// A sandbox store, the orchestrator's core and its harness view, an operator core, and workers by id.
async function env() {
  const dir = sandbox();
  const orch = await openCore({ dataDir: `${dir}/data`, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
  const op = await openCore({ dataDir: `${dir}/data`, caller: { role: 'operator', run_id: 'cli', pid: process.pid }, embed: false });
  const e = { dir, orch, op, h: orch.harness(), workers: new Map() };
  e.raw = (sql, ...a) => orch.owner.engine.store.p(sql).all(...a);
  e.worker = async (id, worktree = dir) => {
    if (e.workers.has(id)) return e.workers.get(id);
    await orch.worker.write({ id, substrate: 'claude-code', pid: process.pid, state: 'idle', session_id: `s-${id}`, last_event_at: Date.now(), worktree });
    const c = await openCore({ dataDir: `${dir}/data`, caller: callerFor('worker', { worker_id: id }), embed: false });
    e.workers.set(id, c);
    return c;
  };
  // The adapter's task_assign over the stamped view, without the message to a process.
  e.exec = () => { const x = createPolicyExecutor({ core: e.h, runId: RUN, assignFor: (stepCore) => async (a) => stepCore.task.assign(a), closeWaitMs: 0 }); x.arm(); return x; };
  e.close = async () => {
    for (const c of e.workers.values()) await c.close();
    await op.close();
    try { await orch.shutdownOwner(); } finally { await orch.close(); cleanup(dir); }
  };
  return e;
}

// The worker hands back what it did and belay evaluates it as the run manager does (trigger 'release').
async function handBack(e, workerId, task, result = { branch: 'b', head: 'h' }, tree = null) {
  const w = await e.worker(workerId, tree || e.dir);
  const a = await e.orch.task.assign({ task_id: task.id, worker_id: workerId });
  await w.lease.release({ lease_id: a.new_lease.id, reason: 'done', result });
  return e.h.task.evaluate({ task_id: task.id, ...(tree ? {} : { worktree: e.dir }), trigger: 'release' });
}
// A work task under the plan, judged `verdict` by `judge`. -> { work, review }
async function judged(e, label, verdict, { builder = `build-${label}`, judge = `judge-${label}`, work, tree = null } = {}) {
  const t = work || await e.orch.task.create({ spec: `${label} work`, acceptance: PASS, policy: PLAN });
  assert.strictEqual((await handBack(e, builder, t, undefined, tree)).state, 'done');
  const review = await e.orch.task.create({ spec: `${label} review`, depends_on: [t.id], acceptance: { verdict: true } });
  const findings = verdict === 'refuted' ? [{ severity: 'blocking', clause: 'a', note: `${label} finding` }] : [];
  await handBack(e, judge, review, { verdict, summary: `${label} ${verdict}`, findings });
  return { work: t, review, builder, judge };
}
const stepsOf = (e) => e.raw('SELECT seq, step, outcome, row_ref, error, trigger_table, trigger_id, trigger_seq FROM policy_step ORDER BY seq');
const latest = (e, table, id) => e.raw(`SELECT * FROM ${table} WHERE id = ? ORDER BY seq DESC LIMIT 1`, id)[0];

test('fix: a refuted review makes the fix under the claim and assigns it to the builder; every row is stamped with the claim\'s trigger', async () => {
  const e = await env();
  try {
    const { work, review, builder } = await judged(e, 'f', 'refuted');
    const out = await e.exec().tick();
    assert.deepStrictEqual(out.steps.map((s) => [s.step, s.outcome]), [['fix', 'done']]);
    const fixes = e.raw('SELECT DISTINCT id FROM task WHERE repairs = ?', work.id);
    assert.strictEqual(fixes.length, 1);
    const fixRow = latest(e, 'task', fixes[0].id);
    assert.strictEqual(stepsOf(e)[0].row_ref, `task:${fixes[0].id}`);
    assert.strictEqual(stepsOf(e)[0].trigger_id, review.id);
    const lease = e.raw('SELECT holder, acted_by, trigger FROM lease WHERE task_id = ? ORDER BY seq', fixes[0].id)[0];
    assert.deepStrictEqual([lease.holder, lease.acted_by], [builder, 'policy'], 'to the one who built the work');
    assert.strictEqual(e.raw("SELECT acted_by FROM task WHERE id = ? ORDER BY seq", fixes[0].id)[0].acted_by, 'policy');
    assert.ok(fixRow);
    assert.deepStrictEqual((await e.exec().tick()).steps, [], 'the next pass finds the trigger taken');
    assert.strictEqual(e.raw('SELECT DISTINCT id FROM task WHERE repairs = ?', work.id).length, 1);
  } finally { await e.close(); }
});

test('re_review: a done fix gets a review that depends on it, assigned to the worker that refuted, stamped by the step', async () => {
  const e = await env();
  try {
    const { work, builder, judge } = await judged(e, 'r', 'refuted');
    const x = e.exec();
    await x.tick(); // the fix, assigned to the builder
    const fix = e.raw('SELECT DISTINCT id FROM task WHERE repairs = ?', work.id)[0];
    const w = await e.worker(builder);
    const lease = latest(e, 'lease', e.raw('SELECT id FROM lease WHERE task_id = ?', fix.id)[0].id);
    await w.lease.release({ lease_id: lease.id, reason: 'done', result: { branch: 'b', head: 'h2' } });
    assert.strictEqual((await e.h.task.evaluate({ task_id: fix.id, worktree: e.dir, trigger: 'release' })).state, 'done');
    const out = await x.tick();
    assert.deepStrictEqual(out.steps.map((s) => [s.step, s.outcome]), [['re_review', 'done']]);
    const made = out.steps[0].row_ref.replace('task:', '');
    const row = latest(e, 'task', made);
    assert.deepStrictEqual([row.acted_by, JSON.parse(row.depends_on), JSON.parse(row.acceptance).verdict], ['policy', [fix.id], true]);
    const l = e.raw('SELECT holder, acted_by FROM lease WHERE task_id = ? ORDER BY seq', made)[0];
    assert.deepStrictEqual([l.holder, l.acted_by], [judge, 'policy'], 'to the refuter, not the builder');
    assert.deepStrictEqual((await x.tick()).steps, []);
  } finally { await e.close(); }
});

test('integrate: a held, done work is merged into the run\'s own branch by the step, and the claim names the integration row', async () => {
  const e = await env();
  try {
    const repo = makeRepo(e.dir);
    const t = await e.orch.task.create({ spec: 'write a.txt', acceptance: PASS, policy: PLAN });
    const wt = (await e.op.task.worktreeCreate({ task_id: t.id, repo })).worktree;
    write(wt.path, 'a.txt', 'a\n'); commit(wt.path, `task ${t.id}`);
    const { work } = await judged(e, 'i', 'holds', { work: t, tree: wt.path });
    // the work was handed back from its tree
    assert.strictEqual(latest(e, 'task', work.id).state, 'done');
    const out = await e.exec().tick();
    assert.deepStrictEqual(out.steps.map((s) => [s.step, s.outcome]), [['integrate', 'done']]);
    const id = out.steps[0].row_ref.replace('integration:', '');
    const row = latest(e, 'integration', id);
    assert.deepStrictEqual([row.into_branch, row.acted_by], [`belay/integrate/${RUN}`, 'policy']);
    assert.deepStrictEqual((await e.exec().tick()).steps, []);
  } finally { await e.close(); }
});

test('the orchestrator acting first: its fix stands, the claim ends superseded naming it, and no second fix or assignment is made', async () => {
  const e = await env();
  try {
    const { work, review } = await judged(e, 's', 'refuted');
    const mine = await e.orch.task.fixFromReview({ review_id: review.id });
    const out = await e.exec().tick();
    assert.deepStrictEqual(out.steps.map((s) => [s.step, s.outcome, s.row_ref]), [['fix', 'superseded', `task:${mine.id}`]]);
    assert.strictEqual(e.raw('SELECT DISTINCT id FROM task WHERE repairs = ?', work.id).length, 1);
    assert.strictEqual(e.raw("SELECT COUNT(*) AS n FROM lease WHERE acted_by = 'policy'")[0].n, 0, 'the step assigned nothing');
  } finally { await e.close(); }
});

test('a paused run takes no claim against the real run row, and takes the step once it resumes', async () => {
  const e = await env();
  try {
    await judged(e, 'p', 'refuted');
    await e.orch.run.setPaused({ paused: true });
    const x = e.exec();
    const held = await x.tick();
    assert.strictEqual(held.held, 'paused');
    assert.deepStrictEqual(stepsOf(e), []);
    await e.orch.run.setPaused({ paused: false });
    assert.deepStrictEqual((await x.tick()).steps.map((s) => s.step), ['fix']);
  } finally { await e.close(); }
});
