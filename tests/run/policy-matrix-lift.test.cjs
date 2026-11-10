'use strict';
require('../helpers/tmp.cjs');
// policy-matrix-lift.test.cjs — package F, the two rules of the final exception table: E2 comes from the re-review that refutes the final allowed
// fix (or at once at cap 0), and a plan amend lifts the halt of E1, E2, E5, E6 and E7. Seeded on the real core, executor and watcher, as the
// other policy-matrix files are.

const { test: nodeTest } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { guarded } = require('../core/worktree-helpers.cjs');
const M = require('./policy-matrix-env.cjs');

const test = guarded(nodeTest);
const amend = (e, id, plan = M.PLAN) => e.orch.task.create({ id, amend: true, policy: plan });
// After the amend: the wake is not sent again, the watcher derives nothing for it, and the task is not halted.
async function lifted(e, id, plan = M.PLAN) {
  await amend(e, id, plan); // the plan the failure happened under, restated: a plan that gained a fix step would carry the failure as a round instead
  assert.deepStrictEqual(await e.poll(), [], 'the same fact is not sent again');
  assert.ok(e.watcher.active().length > 0 && e.watcher.active().every((x) => x.lifted), 'still derived, marked lifted');
  assert.ok(!(await M.halted(e)).has(id));
}

test('E2 at cap 1: the final allowed fix runs and is re-reviewed; only that re-review\'s refutation is E2, one wake, halted', async () => {
  const e = await M.env({ label: 'E2-cap1', attach: { fix_hard_cap: 1 } });
  try {
    const { task } = await M.workDone(e, 'c');
    const first = await M.reviewed(e, task, 'c', 'refuted');
    assert.deepStrictEqual(await e.poll(), [], 'a round is left: the fix is routine');
    assert.deepStrictEqual((await e.tick()).steps.map((s) => [s.step, s.outcome]), [['fix', 'done']]);
    const fix = M.fixesOf(e, task.id)[0].id;
    assert.deepStrictEqual(await e.poll(), [], 'the final fix is made and not yet reviewed: no E2');
    assert.strictEqual((await M.handBackLeased(e, fix)).state, 'done');
    assert.deepStrictEqual(await e.poll(), []);
    assert.deepStrictEqual((await e.tick()).steps.map((s) => [s.step, s.outcome]), [['re_review', 'done']], 'the re_review step is not halted');
    const rr = e.raw('SELECT id FROM task WHERE depends_on LIKE ? AND acceptance LIKE ?', `%${fix}%`, '%verdict%')[0].id;
    assert.strictEqual(M.leaseOf(e, rr).holder, first.judge);
    await M.handBackLeased(e, rr, { verdict: 'refuted', summary: 'still wrong', findings: [{ severity: 'blocking', clause: 'a', note: 'still wrong' }] });
    M.expectOne(await e.poll(), { exception: 'E2', field: 'fix', task_id: task.id, trigger: await M.tref(e, rr), key: `${rr}@${await M.evaluatedAt(e, rr)}` });
    assert.ok((await M.halted(e)).has(task.id));
    await M.assertOnce(e);
    assert.strictEqual(M.fixesOf(e, task.id).length, 1, 'no second fix');
    await lifted(e, task.id);
  } finally { await e.close(); }
});

test('amend lifts E2 at cap 0', async () => {
  const e = await M.env({ label: 'lift-E2', attach: { fix_hard_cap: 0 } });
  try {
    const { task } = await M.workDone(e, 'a');
    await M.reviewed(e, task, 'a', 'refuted');
    assert.strictEqual((await e.poll()).length, 1);
    assert.ok((await M.halted(e)).has(task.id));
    await lifted(e, task.id);
  } finally { await e.close(); }
});

test('amend lifts E5 (a failed evaluation)', async () => {
  const e = await M.env({ label: 'lift-E5' });
  try {
    const { task } = await M.workDone(e, 'x', { acceptance: M.FAIL, plan: M.without(M.PLAN, 'fix') });
    assert.strictEqual((await e.poll())[0].exception, 'E5');
    assert.ok((await M.halted(e)).has(task.id));
    await lifted(e, task.id, M.without(M.PLAN, 'fix'));
  } finally { await e.close(); }
});

test('amend lifts E6 (a failure beside other evaluations, from a plan with no fix step)', async () => {
  const e = await M.env({ label: 'lift-E6' });
  try {
    const hold = `${e.dir}/hold.cjs`; const release = `${e.dir}/release.cjs`; const flag = `${e.dir}/other-ran`;
    fs.writeFileSync(hold, `const fs = require('node:fs'); const end = Date.now() + 25000; (function poll() { if (fs.existsSync(${JSON.stringify(flag)})) process.exit(1); if (Date.now() > end) process.exit(3); setTimeout(poll, 10); })();\n`);
    fs.writeFileSync(release, `require('node:fs').writeFileSync(${JSON.stringify(flag)}, '1');\n`);
    const plan = M.without(M.PLAN, 'fix');
    const mk = async (label, script) => e.orch.task.create({ spec: label, acceptance: { commands: [{ argv: [process.execPath, script], timeout_ms: 30000 }] }, policy: plan });
    const slow = await mk('slow', hold); const quick = await mk('quick', release);
    await e.worker('rv');
    const lease = async (t, w) => { const wc = await e.worker(w); const a = await e.orch.task.assign({ task_id: t.id, worker_id: w }); await wc.lease.release({ lease_id: a.new_lease.id, reason: 'done', result: { branch: 'b', head: 'h' } }); };
    await lease(slow, 'build-slow'); await lease(quick, 'build-quick');
    await Promise.all([M.evaluate(e, slow.id), M.evaluate(e, quick.id)]);
    const task = slow;
    assert.strictEqual((await e.poll())[0].exception, 'E6');
    assert.ok((await M.halted(e)).has(task.id));
    await lifted(e, task.id, plan);
  } finally { await e.close(); }
});

test('amend lifts E7 (a hold with should-fix findings)', async () => {
  const e = await M.env({ label: 'lift-E7' });
  try {
    const { task } = await M.workDone(e, 's');
    await M.reviewed(e, task, 's', 'holds', { findings: [{ severity: 'should-fix', clause: 'a', note: 'tests run only in UTC' }] });
    assert.strictEqual((await e.poll())[0].exception, 'E7');
    assert.ok((await M.halted(e)).has(task.id));
    await lifted(e, task.id);
  } finally { await e.close(); }
});
