'use strict';
require('../helpers/tmp.cjs');
// policy-review-fixes.test.cjs — the review round's findings against the REAL core (and, where a worker is spawned, the REAL run manager over the fake
// claude executable): a refuted review is never a leftover to hand over again; a retake after a pause names the worker that ran and works with a generated
// id, a fixed id and a second work under one plan; a pause between the gate and the assignment is a retake; the budget rule on fix and re_review, on a task
// row's own limit, and the E9 wake through the watcher. No model, no sleep: every wait is on the event it needs.

const { test: nodeTest } = require('node:test');
const assert = require('node:assert');
const { guarded } = require('../core/worktree-helpers.cjs');
const STEPS = require('../../src/run/policy-steps-run.cjs');
const PW = require('../../src/run/policy-wakes.cjs');
const BUD = require('../../src/run/policy-budget.cjs');
const { env, workDone, stepRows, reviewsOf, tasksNow, wakesOf, budgeted, RUN, REST } = require('./policy-review-env.cjs');

const test = guarded(nodeTest);
const REFUTED = { verdict: 'refuted', summary: 'no', findings: [{ severity: 'blocking', clause: 'a', note: 'a finding' }] };

// The reviewer `rv` takes the review task and hands back `result`; belay evaluates it as the run manager does.
async function judge(e, review, result, rv = 'rv') {
  const w = await e.worker(rv);
  const lease = e.raw('SELECT id, holder FROM lease WHERE task_id = ? ORDER BY seq DESC', review)[0];
  assert.strictEqual(lease.holder, rv, 'the review is held by the reviewer');
  await w.lease.release({ lease_id: lease.id, reason: 'done', result });
  return e.h.task.evaluate({ task_id: review, worktree: e.dir, trigger: 'release' });
}
// A task the builder handed back, evaluated on release.
async function handedBack(e, taskId, builder = 'builder-1') {
  const w = await e.worker(builder);
  const lease = e.raw('SELECT id FROM lease WHERE task_id = ? ORDER BY seq DESC', taskId)[0];
  await w.lease.release({ lease_id: lease.id, reason: 'done', result: { branch: 'b', head: 'h' } });
  let r = null;
  try { r = await e.h.task.evaluate({ task_id: taskId, trigger: 'release' }); } catch { r = null; }
  if (!r || r.state !== 'done') r = await e.h.task.evaluate({ task_id: taskId, worktree: e.dir, trigger: 'release' });
  assert.strictEqual(r.state, 'done');
}
const stepNames = (out) => out.steps.map((s) => [s.step, s.outcome]);

test('a refuted policy-made review is not a leftover: after E1\'s remedy (the plan gains a fix) the review step is not due again and no second reviewer is dispatched', async () => {
  const e = await env('review-refuted-leftover');
  try {
    const { work } = await workDone(e, { review: { worker: 'rv' } });
    await e.worker('rv');
    const x = e.exec();
    const first = await x.tick();
    assert.deepStrictEqual(stepNames(first), [['review', 'done']]);
    const r1 = first.steps[0].row_ref.replace('task:', '');
    await judge(e, r1, REFUTED);
    // The remedy the wake asks for: the plan gains a fix step. A plan-only amend writes a new version of the work row (a new trigger for the review step).
    await e.orch.task.create({ id: work.id, amend: true, policy: { review: { worker: 'rv' }, ...REST } });
    const out = await x.tick();
    assert.deepStrictEqual(out.steps.map((s) => s.step), ['fix'], 'only the fix is due: the refuted review is a verdict that stands');
    assert.strictEqual(reviewsOf(e, work.id).length, 1, 'no second review task');
    assert.strictEqual(e.raw('SELECT COUNT(*) AS n FROM lease WHERE task_id = ? AND holder = ?', r1, 'rv')[0].n >= 1, true);
    assert.strictEqual(e.raw("SELECT COUNT(DISTINCT id) AS n FROM lease WHERE task_id = ? AND holder_role = 'worker'", r1)[0].n, 1, 'one lease on the review: nobody re-judged it');
    assert.strictEqual(stepRows(e).filter((s) => s.step === 'review').length, 1, 'one review claim');
  } finally { await e.close(); }
});

// A reviewer spawned by the plan whose first try is paused inside the manager's preface (the assignment is refused for the pause), then retaken.
async function prefacePause(label, spawnPlan) {
  const e = await env(label);
  const m = e.manager();
  const { work } = await workDone(e, { review: { spawn: spawnPlan }, ...REST });
  let once = true;
  const spawnFor = (stepCore) => async (a) => {
    const view = Object.create(stepCore, { task: { value: Object.create(stepCore.task, { assign: { value: async (x) => { if (once) { once = false; await e.orch.run.setPaused({ paused: true }); } return stepCore.task.assign(x); } } }) } });
    return STEPS.spawnFor(m)(view)(a);
  };
  const x = e.exec({ spawnFor });
  const out = await x.tick();
  const firstId = stepRows(e)[0].worker_id;
  await e.orch.run.setPaused({ paused: false });
  const again = await x.tick();
  return { e, m, work, out, again, firstId };
}

test('a pause in the manager\'s preface is a skipped claim; the retake of a generated id names the worker that ran, so the log joins its cost', async () => {
  const { e, m, work, out, again, firstId } = await prefacePause('review-preface-pause', { agent_type: 'reviewer' });
  try {
    assert.deepStrictEqual(stepNames(out), [['review', 'skipped']]);
    assert.deepStrictEqual((await wakesOf(e)).filter((w) => w.exception === 'E8'), [], 'a pause is no exception');
    assert.deepStrictEqual(stepNames(again), [['review', 'done']]);
    const rows = stepRows(e);
    assert.strictEqual(rows.length, 1, 'the one claim was reopened');
    assert.match(rows[0].worker_id, /^rev-[0-9a-f]{8}$/);
    assert.notStrictEqual(rows[0].worker_id, firstId, 'the retake made its own id: the first try\'s is a dead row');
    assert.ok(m._worker(rows[0].worker_id), 'the claim names the worker in the manager\'s table');
    assert.strictEqual(e.raw('SELECT holder FROM lease WHERE task_id = ? ORDER BY seq', rows[0].row_ref.replace('task:', ''))[0].holder, rows[0].worker_id);
    assert.strictEqual(reviewsOf(e, work.id).length, 1);
    const log = await e.orch.policy.log({});
    assert.strictEqual(log.steps[0].worker_id, rows[0].worker_id, 'policy.log joins on the worker that ran');
  } finally { await e.close(); }
});

test('a fixed spawn worker_id survives a pause in the preface: the retake takes a fresh id instead of meeting "already exists"', async () => {
  const { e, m, out, again, firstId } = await prefacePause('review-preface-pause-fixed', { agent_type: 'reviewer', worker_id: 'rev-fx' });
  try {
    assert.deepStrictEqual(stepNames(out), [['review', 'skipped']]);
    assert.strictEqual(firstId, 'rev-fx', 'the first try used the plan\'s id');
    assert.deepStrictEqual(stepNames(again), [['review', 'done']]);
    const [row] = stepRows(e);
    assert.match(row.worker_id, /^rev-[0-9a-f]{8}$/);
    assert.ok(m._worker(row.worker_id));
    assert.deepStrictEqual((await wakesOf(e)).filter((w) => w.exception === 'E8'), []);
  } finally { await e.close(); }
});

test('two works under one plan with a fixed spawn worker_id: the first takes the id, the second a fresh one, and neither is an exception', async () => {
  const e = await env('review-two-works');
  try {
    await workDone(e, { review: { spawn: { agent_type: 'reviewer', worker_id: 'rev-shared' } }, ...REST }, { builder: 'b-1', label: 'w1' });
    await workDone(e, { review: { spawn: { agent_type: 'reviewer', worker_id: 'rev-shared' } }, ...REST }, { builder: 'b-2', label: 'w2' });
    const m = e.manager();
    const out = await e.exec({ spawnFor: STEPS.spawnFor(m) }).tick();
    assert.deepStrictEqual(stepNames(out), [['review', 'done'], ['review', 'done']]);
    const ids = stepRows(e).map((s) => s.worker_id);
    assert.strictEqual(ids.filter((i) => i === 'rev-shared').length, 1, 'the plan\'s id served one work');
    assert.strictEqual(new Set(ids).size, 2);
    for (const id of ids) assert.ok(m._worker(id), `${id} was launched`);
  } finally { await e.close(); }
});

test('a pause between the review step\'s gate and the named worker\'s assignment is a skipped claim, retaken after the resume (not an E8 halt)', async () => {
  const e = await env('review-pause-before-assign');
  try {
    const { work } = await workDone(e, { review: { worker: 'rv' }, ...REST });
    await e.worker('rv');
    let once = true;
    const x = e.exec({ assignFor: (stepCore) => async (a) => { if (once) { once = false; await e.orch.run.setPaused({ paused: true }); } return stepCore.task.assign(a); } });
    const out = await x.tick();
    assert.deepStrictEqual(stepNames(out), [['review', 'skipped']]);
    assert.match(stepRows(e)[0].error, /^E_PAUSED/);
    assert.strictEqual(reviewsOf(e, work.id).length, 1, 'the review task stands, unassigned');
    assert.deepStrictEqual((await wakesOf(e)).filter((w) => w.exception === 'E8'), [], 'no halt');
    await e.orch.run.setPaused({ paused: false });
    const again = await x.tick();
    assert.deepStrictEqual(stepNames(again), [['review', 'done']]);
    assert.strictEqual(reviewsOf(e, work.id).length, 1, 'one review task, made once');
    assert.strictEqual(e.raw('SELECT holder FROM lease WHERE task_id = ? ORDER BY seq', again.steps[0].row_ref.replace('task:', ''))[0].holder, 'rv');
  } finally { await e.close(); }
});

// ---- the budget rule on every step that sends work, on a task's own limit, and the E9 wake -------------------------------------------------------

async function refutedWork(e, plan) {
  const { work } = await workDone(e, plan);
  const review = await e.orch.task.create({ spec: 'review it', acceptance: { verdict: true }, depends_on: [work.id] });
  const rv = await e.worker('rv');
  const a = await e.orch.task.assign({ task_id: review.id, worker_id: 'rv' });
  await rv.lease.release({ lease_id: a.new_lease.id, reason: 'done', result: REFUTED });
  await e.h.task.evaluate({ task_id: review.id, worktree: e.dir, trigger: 'release' });
  return { work, review };
}

test('at the soft threshold a fix is not sent to the builder: E_BUDGET, no fix task, nothing assigned', async () => {
  const e = await env('fix-budget');
  try {
    const { work } = await refutedWork(e, REST);
    await budgeted(e, 9.2);
    const out = await e.exec().tick();
    assert.deepStrictEqual(stepNames(out), [['fix', 'exception']]);
    assert.match(stepRows(e)[0].error, /^E_BUDGET: the run budget is at its soft threshold/);
    assert.strictEqual(e.raw('SELECT COUNT(*) AS n FROM task WHERE repairs IS NOT NULL')[0].n, 0, 'no fix task was made');
    assert.deepStrictEqual((await wakesOf(e)).map((w) => [w.exception, w.field, w.task_id]), [['E9', 'fix', work.id]]);
  } finally { await e.close(); }
});

test('at the soft threshold a re_review is not sent to the refuter: E_BUDGET, no review of the fix is made', async () => {
  const e = await env('re-review-budget');
  try {
    const { work } = await refutedWork(e, REST);
    await e.worker('builder-1');
    const x = e.exec();
    const first = await x.tick();
    assert.deepStrictEqual(stepNames(first), [['fix', 'done']]);
    const fixId = first.steps[0].row_ref.replace('task:', '');
    await handedBack(e, fixId);
    await budgeted(e, 9.2);
    const out = await x.tick();
    assert.deepStrictEqual(stepNames(out), [['re_review', 'exception']]);
    assert.match(stepRows(e).find((s) => s.step === 're_review').error, /^E_BUDGET/);
    assert.strictEqual(reviewsOf(e, fixId).length, 0, 'the fix has no review');
    assert.ok(work.id);
  } finally { await e.close(); }
});

test('a task row\'s own budget limit binds the step the same way the guard does: refused at its soft threshold, with the run under its own', async () => {
  const e = await env('task-budget');
  try {
    await budgeted(e, 0); // a run limit of $10 with the ledger on, so a task may carry a limit
    const { work } = await workDone(e, { review: { worker: 'rv' }, ...REST }, { create: { budget_usd: 2 } });
    await e.worker('rv');
    await e.orch.usage.record({ worker_id: 'someone', task_id: work.id, turn: 1, cost_usd: 1.9, substrate: 'claude-code', cost_basis: 'delta-of-cumulative' });
    const out = await e.exec().tick();
    assert.deepStrictEqual(stepNames(out), [['review', 'exception']]);
    assert.match(stepRows(e)[0].error, /^E_BUDGET: the task budget is at its soft threshold \(\$1\.90 reported of \$2\.00/);
    assert.strictEqual(reviewsOf(e, work.id).length, 0);
  } finally { await e.close(); }
});

test('the E9 wake of a refused step is delivered by the policy watcher, once, and halts nothing', async () => {
  const e = await env('e9-watcher');
  try {
    const { work } = await workDone(e, { review: { worker: 'rv' }, ...REST });
    await e.worker('rv');
    await budgeted(e, 9.2);
    await e.exec().tick();
    const watcher = PW.createPolicyWatcher({ core: e.h, runId: RUN, enabled: true });
    const wakes = await watcher.poll();
    const w = wakes.find((x) => x.exception === 'E9');
    assert.ok(w, 'the watcher delivered the E9 wake');
    assert.deepStrictEqual([w.event, w.task_id, w.field], ['evaluated', work.id, 'review']);
    assert.match(w.text, /Step review not taken: E_BUDGET/);
    assert.deepStrictEqual((await watcher.poll()).filter((x) => x.exception === 'E9'), [], 'delivered once');
    assert.strictEqual(PW.haltedIds(watcher.active(), await tasksNow(e)).size, 0);
  } finally { await e.close(); }
});

test('spendForGuard reads a task row\'s limit when the run record has none, and the record\'s limit wins when it has one', async () => {
  const readers = (usd) => ({ spend: async () => ({ usd }) });
  const run = { budget_usd: null, budget: { soft_threshold: 0.9 } };
  const row = await BUD.spendForGuard(run, readers(1.9), 'T1', 2);
  assert.deepStrictEqual([row.scope, row.limit, row.over], ['task', 2, true]);
  assert.strictEqual(await BUD.spendForGuard(run, readers(1.9), 'T1', null), null, 'no limit anywhere, no refusal');
  const recorded = await BUD.spendForGuard({ budget_usd: null, budget: { soft_threshold: 0.9, tasks: { T1: 4 } } }, readers(1.9), 'T1', 2);
  assert.deepStrictEqual([recorded.limit, recorded.over], [4, false], 'the run record is applied on top of the row, as the guard does');
});
