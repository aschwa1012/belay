'use strict';
require('../helpers/tmp.cjs');
// policy-matrix-race.test.cjs — package F, the one-trigger race end to end. The orchestrator and a policy step reach the same trigger; the
// real executor and the real core decide, and each interleaving is forced by the core's own test seam (policy-stamp.cjs setHooksForTest),
// which stalls one writer between its validation and its write: no sleep, no load. Both orders, for the fix, the assignment and the merge.
// Exactly one effect stands; the loser answers with the winner's row (the policy step finishes `superseded` naming it).

const { test: nodeTest } = require('node:test');
const assert = require('node:assert');
const { guarded, makeRepo, write, commit } = require('../core/worktree-helpers.cjs');
const PS = require('../../src/core/policy-stamp.cjs');
const M = require('./policy-matrix-env.cjs');

const test = guarded(nodeTest);
const policyCall = (i) => i.policy_step !== null;
const orchestratorCall = (i) => i.policy_step === null;

// Stalls the first call at `point` that matches `pred` until release(); `reached` resolves when it is stalled.
function stall(point, pred) {
  let release; let reached; let taken = false;
  const gate = new Promise((r) => { release = r; });
  const there = new Promise((r) => { reached = r; });
  PS.setHooksForTest({ at: async (p, info) => { if (p === point && !taken && pred(info)) { taken = true; reached(); await gate; } } });
  return { release, reached: there };
}
// A refuted review over the plan's work: the policy fix step is due.
async function refuted(e, label) {
  const { task, builder } = await M.workDone(e, label);
  const { review } = await M.reviewed(e, task, label, 'refuted');
  return { task, review, builder };
}
const stepRows = (e) => M.stepsOf(e).map((s) => [s.step, s.outcome, s.row_ref]);
const leases = (e, taskId) => e.raw('SELECT id, holder, acted_by FROM lease WHERE task_id = ? ORDER BY seq', taskId);

async function race(label, fn) {
  const e = await M.env({ label });
  try { await fn(e); } finally { PS.setHooksForTest(null); await e.close(); }
}

test('fix, the policy step first: the orchestrator, stalled before its write, gets the step\'s fix back; one fix task, no second', () => race('race-fix-policy-first', async (e) => {
  const { task, review } = await refuted(e, 'a');
  const s = stall('fix.beforeWrite', orchestratorCall);
  const mine = e.orch.task.fixFromReview({ review_id: review.id });
  await s.reached;
  const out = await e.tick();
  s.release();
  const got = await mine;
  const fix = M.fixesOf(e, task.id);
  assert.strictEqual(fix.length, 1, 'one fix task');
  assert.deepStrictEqual(out.steps.map((x) => [x.step, x.outcome, x.row_ref]), [['fix', 'done', `task:${fix[0].id}`]]);
  assert.deepStrictEqual([got.id, got.existing, got.superseded], [fix[0].id, true, undefined], 'the orchestrator is answered with the step\'s fix');
  assert.strictEqual(leases(e, fix[0].id).length, 1);
  assert.strictEqual(leases(e, fix[0].id)[0].acted_by, 'policy');
  assert.deepStrictEqual(await e.poll(), [], 'routine under the plan: no wake');
}));

test('fix, the orchestrator first: the step, stalled after its claim, is superseded by the orchestrator\'s fix and assigns nothing', () => race('race-fix-orchestrator-first', async (e) => {
  const { task, review } = await refuted(e, 'b');
  const s = stall('fix.beforeWrite', policyCall);
  const ticking = e.tick();
  await s.reached;
  const mine = await e.orch.task.fixFromReview({ review_id: review.id });
  s.release();
  const out = await ticking;
  assert.strictEqual(M.fixesOf(e, task.id).length, 1, 'one fix task');
  assert.deepStrictEqual(out.steps.map((x) => [x.step, x.outcome, x.row_ref]), [['fix', 'superseded', `task:${mine.id}`]]);
  assert.deepStrictEqual(stepRows(e), [['fix', 'superseded', `task:${mine.id}`]]);
  assert.deepStrictEqual(leases(e, mine.id), [], 'the step assigned nothing');
  assert.deepStrictEqual(await e.poll(), []);
}));

test('assign, the step first: the orchestrator, stalled before its write, is answered with the step\'s lease; one lease row', () => race('race-assign-policy-first', async (e) => {
  const { task, builder } = await refuted(e, 'c');
  let mine = null; let orchReached; const there = new Promise((r) => { orchReached = r; }); let open; const gate = new Promise((r) => { open = r; });
  PS.setHooksForTest({ at: async (p, info) => {
    if (p !== 'assign.beforeTx') return;
    if (info.policy_step !== null) { // the step is about to assign its fix: the orchestrator starts its own assignment and is held before its write
      mine = e.orch.task.assign({ task_id: M.fixesOf(e, task.id)[0].id, worker_id: builder });
      await there;
    } else { orchReached(); await gate; }
  } });
  const out = await e.tick();
  open();
  const got = await mine;
  const fix = M.fixesOf(e, task.id)[0].id;
  assert.deepStrictEqual(out.steps.map((x) => [x.step, x.outcome]), [['fix', 'done']]);
  const rows = leases(e, fix);
  assert.strictEqual(rows.length, 1, 'one lease');
  assert.deepStrictEqual([got.existing, got.superseded, got.new_lease.id], [true, undefined, rows[0].id]);
  assert.strictEqual(rows[0].acted_by, 'policy');
}));

test('assign, the orchestrator first: the step, stalled before its write, finishes superseded naming the orchestrator\'s lease; one lease row', () => race('race-assign-orchestrator-first', async (e) => {
  const { task, builder } = await refuted(e, 'd');
  const s = stall('assign.beforeTx', policyCall);
  const ticking = e.tick();
  await s.reached;
  const fix = M.fixesOf(e, task.id)[0].id; // the step made the fix and has not assigned it
  const mine = await e.orch.task.assign({ task_id: fix, worker_id: builder });
  s.release();
  const out = await ticking;
  const rows = leases(e, fix);
  assert.strictEqual(rows.length, 1, 'one lease');
  assert.deepStrictEqual([rows[0].id, rows[0].acted_by], [mine.new_lease.id, null], 'the orchestrator\'s');
  assert.deepStrictEqual(out.steps.map((x) => [x.step, x.outcome, x.row_ref]), [['fix', 'superseded', `lease:${mine.new_lease.id}`]]);
}));

// A held, done work with its own commit in a worktree: the integrate step is due.
async function held(e, repo, label) {
  const t = await e.orch.task.create({ spec: `${label} writes ${label}.txt`, acceptance: M.PASS, policy: M.PLAN });
  const wt = (await e.op.task.worktreeCreate({ task_id: t.id, repo })).worktree.path;
  write(wt, `${label}.txt`, `${label}\n`); commit(wt, `task ${t.id}`);
  assert.strictEqual((await M.handBack(e, `build-${label}`, t, undefined, wt)).state, 'done');
  await M.reviewed(e, t, label, 'holds');
  return t;
}
const integrations = (e) => e.raw("SELECT DISTINCT id FROM integration WHERE state NOT IN ('merging')").map((r) => r.id);

test('merge, the step first: the orchestrator, stalled before the branch lock, is answered with the step\'s integration; one effect', () => race('race-merge-policy-first', async (e) => {
  const t = await held(e, makeRepo(e.dir), 'm');
  const s = stall('merge.beforeLock', orchestratorCall);
  const mine = e.orch.integration.merge({ task_ids: [t.id] });
  await s.reached;
  const out = await e.tick();
  s.release();
  const got = await mine;
  assert.deepStrictEqual(out.steps.map((x) => [x.step, x.outcome]), [['integrate', 'done']]);
  const row = out.steps[0].row_ref.replace('integration:', '');
  assert.deepStrictEqual(integrations(e), [row], 'one integration');
  assert.deepStrictEqual([got.id, got.existing, got.superseded], [row, true, undefined]);
}));

test('merge, the orchestrator first: the step, stalled before the branch lock, finishes superseded naming the orchestrator\'s integration; one effect', () => race('race-merge-orchestrator-first', async (e) => {
  const t = await held(e, makeRepo(e.dir), 'n');
  const s = stall('merge.beforeLock', policyCall);
  const ticking = e.tick();
  await s.reached;
  const mine = await e.orch.integration.merge({ task_ids: [t.id] });
  s.release();
  const out = await ticking;
  assert.deepStrictEqual(out.steps.map((x) => [x.step, x.outcome, x.row_ref]), [['integrate', 'superseded', `integration:${mine.id}`]]);
  assert.deepStrictEqual(integrations(e), [mine.id], 'one integration');
}));
