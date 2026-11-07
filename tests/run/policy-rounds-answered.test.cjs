'use strict';
require('../helpers/tmp.cjs');
// policy-rounds-answered.test.cjs — the round that answers a failure is not a reason for the cap wake. A merge fix (fix_conflict, fix_checks) that spent the LAST round
// answers its integration: the conflict that fix is for must not read as one the cap stops (a false E2 that halted the work, seen in a pilot run), and the merge is retried
// after the fix. The cap is for a new failure after that. Real core, executor and watcher (policy-matrix-env.cjs).

const { test: nodeTest } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { guarded, makeRepo, write, commit } = require('../core/worktree-helpers.cjs');
const M = require('./policy-matrix-env.cjs');
const RF = require('../../src/run/policy-rounds.cjs');

const test = guarded(nodeTest);
const names = (out) => out.steps.map((s) => [s.step, s.task_id, s.outcome]);
// The builder hands the fix back from its own tree and belay evaluates it there.
async function handBackFix(e, fixId) {
  const l = M.leaseOf(e, fixId);
  const w = await e.worker(l.holder);
  await w.lease.release({ lease_id: l.id, reason: 'done', result: { branch: 'b', head: 'fixed' } });
  return M.evaluate(e, fixId, true);
}

test('one review fix and one fix_conflict at max_fix_rounds 2: the conflict fix spends the last round and answers its conflict, so no E2, and the merge is retried', async () => {
  const e = await M.env({ label: 'answered-conflict', attach: { max_fix_rounds: 2 } });
  try {
    const repo = makeRepo(e.dir);
    await e.orch.run.attach({ adapter_pid: process.pid, project_dir: repo, max_fix_rounds: 2 });
    const work = async (label, text) => {
      const t = await e.orch.task.create({ spec: `${label} edits a.txt`, acceptance: M.PASS, policy: M.PLAN });
      const wt = (await e.op.task.worktreeCreate({ task_id: t.id, repo })).worktree.path;
      write(wt, 'a.txt', text); commit(wt, `task ${t.id}`);
      assert.strictEqual((await M.handBack(e, `build-${label}`, t, undefined, wt)).state, 'done');
      return { t, wt };
    };
    const wakes = [];
    const poll = async () => { wakes.push(...(await e.poll())); };
    const a = await work('a', 'from a\n'); await M.reviewed(e, a.t, 'a', 'holds');
    const b = await work('b', 'from b\n'); await M.reviewed(e, b.t, 'b', 'refuted', { judge: 'jb' });
    assert.deepStrictEqual(names(await e.tick()).map((s) => [s[0], s[2]]), [['integrate', 'done'], ['fix', 'done']], 'a merges; the refuted b gets its review fix (round 1)');
    const [f1] = M.fixesOf(e, b.t.id);
    write(b.wt, 'a.txt', 'from b2\n'); commit(b.wt, 'fix 1');
    assert.strictEqual((await handBackFix(e, f1.id)).state, 'done');
    assert.deepStrictEqual(names(await e.tick()).map((s) => s[0]), ['re_review']);
    const rr = e.raw("SELECT id FROM task WHERE depends_on LIKE ? AND acceptance LIKE '%verdict%'", `%${f1.id}%`)[0].id;
    await M.handBackLeased(e, rr, { verdict: 'holds', summary: 'ok', findings: [] });
    assert.deepStrictEqual(names(await e.tick()).map((s) => [s[0], s[2]]), [['integrate', 'done']], 'b is merged: it conflicts with a');
    await poll();
    assert.deepStrictEqual(names(await e.tick()).map((s) => s[0]), ['fix_conflict'], 'round 2, the last');
    const f2 = M.fixesOf(e, b.t.id).find((f) => f.id !== f1.id);
    await poll(); // the fix has spent the cap; its conflict is answered
    write(b.wt, 'a.txt', 'from a\n'); commit(b.wt, 'resolve');
    assert.strictEqual((await handBackFix(e, f2.id)).state, 'done');
    await poll();
    assert.deepStrictEqual(names(await e.tick()).map((s) => [s[0], s[2]]), [['integrate', 'done']], 'the merge is retried with the fix');
    assert.strictEqual((await M.rowOf(e, b.t.id)).integration.state, 'merged');
    await poll();
    assert.deepStrictEqual(wakes.filter((w) => w.exception).map((w) => [w.exception, w.task_id]), [], 'no E2, no E3: nothing woke the orchestrator but the clean end');
    assert.deepStrictEqual(wakes.map((w) => w.event), ['policy_done']);
  } finally { await e.close(); }
});

test('a hand-back sent back in the last round is not a cap either: it is out with its builder, and green it goes on', async () => {
  const e = await M.env({ label: 'answered-eval', attach: { max_fix_rounds: 1 } });
  try {
    const script = `${e.dir}/once.cjs`; const marker = `${e.dir}/once.ran`;
    fs.writeFileSync(script, `const fs = require('node:fs'); if (fs.existsSync(${JSON.stringify(marker)})) process.exit(0); fs.writeFileSync(${JSON.stringify(marker)}, '1'); process.exit(1);\n`);
    const { task } = await M.workDone(e, 'r', { acceptance: { commands: [{ argv: [process.execPath, script], timeout_ms: 20000 }] } });
    assert.deepStrictEqual(names(await e.tick()).map((s) => [s[0], s[2]]), [['fix_eval', 'done']], 'the only round');
    assert.deepStrictEqual(await e.poll(), [], 'out with its builder: no E2');
    assert.strictEqual((await M.handBackLeased(e, task.id)).state, 'done');
    await e.worker('rv');
    assert.deepStrictEqual(names(await e.tick()).map((s) => s[0]), ['review']);
    assert.deepStrictEqual(await e.poll(), []);
  } finally { await e.close(); }
});

// The rows of a conflict a merge fix was claimed for, without a store.
const T = (id, over = {}) => ({ id, seq: 100, run_id: 'r1', state: 'open', policy: null, policy_rev: null, depends_on: [], repairs: null, results: null, handoff: null, lease: null, review: null, integration: null, written_at: 50, ...over });
const PLAN = { review: { worker: 'rv' }, fix: 'builder', re_review: 'refuter', integrate: 'on_hold' };
function rows(fixState, now, claimAt = 1000, outcome = 'done') {
  const W = T('W', { state: 'done', policy: PLAN, policy_rev: 1, handoff: { by: 'b1', at: 1 } });
  const F = T('F', { repairs: 'W', depends_on: ['W'], state: fixState });
  const i = { id: 'I', run_id: 'r1', seq: 30, state: 'conflict', acted_by: 'policy', conflict: { task_id: 'W', files: ['a.txt'] }, task_ids: ['W'] };
  const step = { seq: 5, run_id: 'r1', step: 'fix_conflict', task_id: 'W', trigger_table: 'integration', trigger_id: 'I', trigger_seq: 30, outcome, row_ref: outcome === 'started' ? null : 'task:F', at: claimAt };
  return RF.ctxOf({ runId: 'r1', now, tasks: [W, F], steps: [step], failures: [], caps: { max: 1, hard: null }, integrations: [i] });
}
const m = (rf) => RF.mergeAction(rf.integrations[0], rf, () => ({ plan: PLAN, rev: 1 }));

test('an integration a merge fix already answers is not at the cap; a fix cancelled, or out longer than the bound, leaves it unanswered', () => {
  assert.strictEqual(m(rows('assigned', 2000)).answered, true, 'the fix is out');
  assert.strictEqual(m(rows('done', 1000 + 99999999)).answered, true, 'the fix is done: the retry follows, however long ago');
  assert.strictEqual(m(rows(null, 2000, 1000, 'started')).answered, true, 'the claim is in flight');
  assert.strictEqual(m(rows('cancelled', 2000)).cap, true, 'cancelled: the cap stands');
  assert.strictEqual(m(rows('assigned', 1000 + 2700001)).cap, true, 'out longer than the bound without finishing: the cap wake is not deferred for ever');
  assert.strictEqual(m(rows('assigned', 1000 + 2700001)).used, 1);
});
