'use strict';
require('../helpers/tmp.cjs');
// policy-matrix-routine.test.cjs — package F: under a plan nothing routine wakes the orchestrator, and a run with no plan is as it was in 0.3.x.
// Real core, real executor and watcher, and the real routine filter (release-eval.cjs enrichWakes) over the rows the core wrote: no model, no sleep.

const { test: nodeTest } = require('node:test');
const assert = require('node:assert');
const { guarded, makeRepo, write, commit } = require('../core/worktree-helpers.cjs');
const RE = require('../../src/run/release-eval.cjs');
const { createPolicyExecutor } = require('../../src/run/policy-exec.cjs');
const PW = require('../../src/run/policy-wakes.cjs');
const M = require('./policy-matrix-env.cjs');

const test = guarded(nodeTest);
const turnEnd = (worker_id, turn = 1) => ({ event: 'turn_end', worker_id, turn, seq: turn });

// A view of `core` that records every call it makes, by dotted name.
function counted(core, calls, prefix = '') {
  return new Proxy({}, { get(_, k) {
    const t = core;
    const v = t[k];
    if (typeof k !== 'string') return v;
    if (typeof v === 'function') return (...a) => { calls.push(`${prefix}${k}`); return v.apply(t, a); };
    return v && typeof v === 'object' ? counted(v, calls, `${prefix}${k}.`) : v;
  } });
}

// The wakes of one poll as the headless run makes them: the routine filter over a worker's turn end, then the policy watcher armed by that read.
async function wakesAt(e, seen, ...events) {
  const out = await RE.enrichWakes(e.h, M.RUN, events, seen);
  const exceptions = await e.watcher.poll(seen);
  e.wakes.push(...exceptions);
  return out.concat(exceptions);
}

test('a clean run under a plan wakes nobody: hand-back, a holding review, and the integrate step are all routine', async () => {
  const e = await M.env({ label: 'routine-clean' });
  try {
    const repo = makeRepo(e.dir);
    const seen = new Map();
    const t = await e.orch.task.create({ spec: 'writes a.txt', acceptance: M.PASS, policy: M.PLAN });
    const wt = (await e.op.task.worktreeCreate({ task_id: t.id, repo })).worktree.path;
    write(wt, 'a.txt', 'a\n'); commit(wt, `task ${t.id}`);
    assert.strictEqual((await M.handBack(e, 'build-a', t, undefined, wt)).state, 'done');
    assert.deepStrictEqual(await wakesAt(e, seen, turnEnd('build-a')), [], 'the builder\'s turn end is routine');
    assert.strictEqual(seen.policyArmed, true);
    await M.reviewed(e, t, 'a', 'holds', { findings: [] });
    assert.deepStrictEqual(await wakesAt(e, seen, turnEnd('judge-a')), [], 'a clean hold is routine');
    assert.deepStrictEqual((await e.tick()).steps.map((s) => [s.step, s.outcome]), [['integrate', 'done']]);
    assert.deepStrictEqual(await wakesAt(e, seen), [], 'and so is the merge');
    assert.strictEqual((await M.rowOf(e, t.id)).integration.state, 'merged');
    assert.deepStrictEqual(e.wakes, []);
  } finally { await e.close(); }
});

test('a refute, fix, re-review, refute, fix loop is routine at every step: the steps take it, and nothing wakes', async () => {
  const e = await M.env({ label: 'routine-loop' });
  try {
    const seen = new Map();
    const { task, builder } = await M.workDone(e, 'l');
    assert.deepStrictEqual(await wakesAt(e, seen, turnEnd(builder)), []);
    const first = await M.reviewed(e, task, 'l', 'refuted');
    assert.deepStrictEqual(await wakesAt(e, seen, turnEnd(first.judge)), [], 'a refutation the plan answers');
    for (let round = 1; round <= 2; round++) {
      assert.deepStrictEqual((await e.tick()).steps.map((s) => [s.step, s.outcome]), [['fix', 'done']], `round ${round}: the fix`);
      const fix = M.fixesOf(e, task.id).map((r) => r.id).filter((id) => M.leaseOf(e, id) && !e.raw('SELECT 1 FROM task WHERE id = ? AND state = ?', id, 'done').length)[0];
      assert.strictEqual((await M.handBackLeased(e, fix)).state, 'done');
      assert.deepStrictEqual(await wakesAt(e, seen, turnEnd(builder, round + 1)), [], 'the fix\'s hand-back');
      if (round === 2) break;
      assert.deepStrictEqual((await e.tick()).steps.map((s) => [s.step, s.outcome]), [['re_review', 'done']], 'the re-review');
      const rr = e.raw("SELECT id FROM task WHERE acted_by = 'policy' AND id NOT IN (SELECT id FROM task WHERE repairs IS NOT NULL) AND id != ?", task.id).map((r) => r.id).find((id) => M.leaseOf(e, id));
      await M.handBackLeased(e, rr, { verdict: 'refuted', summary: 'again', findings: [{ severity: 'blocking', clause: 'a', note: 'again' }] });
      assert.deepStrictEqual(await wakesAt(e, seen, turnEnd(first.judge, 2)), [], 'the second refutation');
    }
    assert.strictEqual(M.fixesOf(e, task.id).length, 2);
    assert.deepStrictEqual(M.stepsOf(e).map((s) => [s.step, s.outcome]), [['fix', 'done'], ['re_review', 'done'], ['fix', 'done']]);
    assert.deepStrictEqual(e.wakes, []);
  } finally { await e.close(); }
});

// The same facts with no plan: the rows and the wakes are those of 0.3.x, and the policy code reads and writes nothing.
test('a run with no plan: no policy row, stamp or claim; the orchestrator\'s own steps; the 0.3.x wake with its evaluation; and the policy code makes no core call', async () => {
  const e = await M.env({ label: 'no-plan' });
  try {
    const calls = [];
    const seen = new Map();
    const { task, builder, row } = await M.workDone(e, 'p', { plan: null });
    assert.strictEqual(row.state, 'done');
    const wakes = await RE.enrichWakes(e.h, M.RUN, [turnEnd(builder)], seen);
    assert.strictEqual(wakes.length, 1, 'a hand-back with no plan wakes as before');
    assert.deepStrictEqual(wakes[0].evaluated.map((x) => [x.task_id, x.state, x.passed, x.executable, x.checks]), [[task.id, 'done', true, true, 1]]);
    assert.ok(!seen.policyArmed && !seen.policyTasks, 'nothing armed');
    // The policy watcher (not enabled) and the executor (not armed) read and write nothing.
    const watcher = PW.createPolicyWatcher({ core: counted(e.h, calls), runId: M.RUN });
    assert.deepStrictEqual(await watcher.poll(seen), []);
    const idle = createPolicyExecutor({ core: counted(e.h, calls), runId: M.RUN, assignFor: () => async () => { throw new Error('no step'); }, closeWaitMs: 0 });
    assert.strictEqual(await idle.tick(), null);
    assert.deepStrictEqual(calls, [], 'no new core read');
    // Armed by mistake on a run with no plan, it reads and acts on nothing.
    const armed = createPolicyExecutor({ core: counted(e.h, calls), runId: M.RUN, assignFor: () => async () => { throw new Error('no step'); }, closeWaitMs: 0, identity: { pid: process.pid, created: 'own' } });
    armed.arm();
    assert.deepStrictEqual((await armed.tick()).steps, []);
    assert.ok(calls.every((c) => /\.list$/.test(c)), calls.join(','));
    // The orchestrator's refuted-review path is unchanged: its own fix, its own assignment, no stamp.
    const { review } = await M.reviewed(e, task, 'p', 'refuted');
    assert.strictEqual((await RE.enrichWakes(e.h, M.RUN, [turnEnd('judge-p')], seen)).length, 1);
    const mine = await e.orch.task.fixFromReview({ review_id: review.id });
    const lease = await e.orch.task.assign({ task_id: mine.id, worker_id: builder });
    assert.deepStrictEqual([mine.acted_by, mine.trigger, lease.new_lease.acted_by, lease.new_lease.trigger], [null, null, null, null]);
    assert.deepStrictEqual(await e.poll(), []);
    assert.strictEqual(e.raw('SELECT COUNT(*) AS n FROM policy_step')[0].n, 0);
    const stamped = (t) => e.raw(`SELECT COUNT(*) AS n FROM ${t} WHERE acted_by IS NOT NULL OR trigger IS NOT NULL OR policy_rev IS NOT NULL`)[0].n;
    assert.deepStrictEqual([stamped('task'), stamped('lease'), stamped('integration')], [0, 0, 0]);
    assert.strictEqual(e.raw('SELECT COUNT(*) AS n FROM task WHERE policy IS NOT NULL')[0].n, 0);
    assert.ok((await M.rowsOf(e)).every((t) => t.policy == null && t.policy_made === false));
  } finally { await e.close(); }
});
