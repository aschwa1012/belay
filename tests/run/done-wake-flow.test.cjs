'use strict';
require('../helpers/tmp.cjs');
// done-wake-flow.test.cjs — the done wake through a REAL fix round (ADR 0074 amendment 4): build hand-back, a review that refutes, the plan's
// fix by the builder, the re-review by the refuter that holds, the merge, then one "implementation done". The refuted review stays `released`
// (the re-review is a new task), and done must not wait on it. Real core, executor and watcher; each step taken by an executor tick.

const { test: nodeTest } = require('node:test');
const assert = require('node:assert');
const { guarded, makeRepo, write, commit } = require('../core/worktree-helpers.cjs');
const M = require('./policy-matrix-env.cjs');

const test = guarded(nodeTest);
const dones = (ws) => ws.filter((w) => w.event === 'policy_done');
// A task a step assigned, handed back by the lease holder and evaluated at release in the task's own tree (a fix shares the work's).
async function releaseLeased(e, taskId, result, tree) {
  const l = M.leaseOf(e, taskId);
  const w = await e.worker(l.holder);
  await w.lease.release({ lease_id: l.id, reason: 'done', result });
  return e.h.task.evaluate({ task_id: taskId, worktree: tree, trigger: 'release' });
}

test('refuted, fixed, re-reviewed and merged: the done wake comes once, and not before the merge', async () => {
  const e = await M.env({ label: 'done-flow' });
  try {
    const repo = makeRepo(e.dir);
    const t = await e.orch.task.create({ spec: 'writes a.txt', acceptance: M.PASS, policy: M.PLAN });
    const wt = (await e.op.task.worktreeCreate({ task_id: t.id, repo })).worktree.path;
    write(wt, 'a.txt', 'a\n'); commit(wt, `task ${t.id}`);
    assert.strictEqual((await M.handBack(e, 'build-a', t, undefined, wt)).state, 'done');
    const first = await M.reviewed(e, t, 'a', 'refuted');
    assert.deepStrictEqual(dones(await e.poll()), [], 'refuted: not done');
    assert.deepStrictEqual((await e.tick()).steps.map((s) => [s.step, s.outcome]), [['fix', 'done']]);
    const fix = M.fixesOf(e, t.id)[0].id;
    write(wt, 'a.txt', 'a fixed\n'); commit(wt, `fix ${fix}`);
    assert.strictEqual((await releaseLeased(e, fix, { branch: 'b', head: 'h2' }, wt)).state, 'done');
    assert.deepStrictEqual((await e.tick()).steps.map((s) => [s.step, s.outcome]), [['re_review', 'done']]);
    const rr = e.raw("SELECT DISTINCT id FROM task WHERE acted_by = 'policy' AND repairs IS NULL AND id != ?", t.id).map((r) => r.id).find((id) => M.leaseOf(e, id));
    await releaseLeased(e, rr, { verdict: 'holds', summary: 'fixed', findings: [] }, wt);
    assert.strictEqual((await M.rowOf(e, first.review.id)).state, 'released', 'the refuted review stays released: a new task re-reviewed');
    assert.deepStrictEqual(dones(await e.poll()), [], 'held, not merged: not done yet');
    assert.deepStrictEqual((await e.tick()).steps.map((s) => [s.step, s.outcome]), [['integrate', 'done']]);
    const d = dones(await e.poll());
    assert.strictEqual(d.length, 1, 'implementation done, once');
    assert.match(d[0].text, /^belay: implementation done: 1 planned task done, reviewed and merged into belay\/integrate\/[^ ]+ at [0-9a-f]{12}, checks passed\. Decide whether you are done\.$/);
    assert.deepStrictEqual(dones(await e.poll()), [], 'and not again for the same state');
  } finally { await e.close(); }
});
