'use strict';
require('../helpers/tmp.cjs');
// policy-matrix-exceptions.test.cjs — package F, E2, E3 and E5 to E8, and E4, E9 and E10 (today's wakes). Each is seeded end to end on the
// real core with the real executor and watcher: workers hand back through their own cores, and the rows the core writes are the fact. Exactly
// one wake per exception with the canonical key, root task and trigger row (api.md, Policy exception wakes), the halt where the table says so.

const { test: nodeTest } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { guarded, makeRepo, write, commit } = require('../core/worktree-helpers.cjs');
const RE = require('../../src/run/release-eval.cjs');
const M = require('./policy-matrix-env.cjs');

const test = guarded(nodeTest);
const NOFIX = M.without(M.PLAN, 'fix'); // a plan with no fix step: the failures the fix step takes as rounds (policy-rounds.test.cjs) are exceptions

test('E2: a refuted review with no fix rounds left (the run\'s hard cap is 0); one wake, halted, and no fix step is taken', async () => {
  const e = await M.env({ label: 'E2', attach: { fix_hard_cap: 0 } });
  try {
    const { task } = await M.workDone(e, 'c');
    const { review } = await M.reviewed(e, task, 'c', 'refuted');
    assert.strictEqual((await M.rowOf(e, task.id)).review.rounds_left, 0);
    const trig = await M.tref(e, review.id);
    const w = M.expectOne(await e.poll(), { exception: 'E2', field: 'fix', task_id: task.id, trigger: trig, key: `${review.id}@${await M.evaluatedAt(e, review.id)}` });
    assert.match(w.text, /Fix cap reached \(0 used\).*"c finding"/);
    assert.ok((await M.halted(e)).has(task.id));
    await M.assertOnce(e);
    assert.deepStrictEqual(M.fixesOf(e, task.id), [], 'no fix was made');
    assert.deepStrictEqual(M.stepsOf(e), []);
  } finally { await e.close(); }
});

// Two works that edit one file differently, both held; the first merges, the second conflicts at the policy integrate.
async function conflicting(e, plan = M.PLAN) {
  const repo = makeRepo(e.dir);
  const edit = async (label, text) => {
    const t = await e.orch.task.create({ spec: `${label} edits a.txt`, acceptance: M.PASS, policy: plan });
    const wt = (await e.op.task.worktreeCreate({ task_id: t.id, repo })).worktree.path;
    write(wt, 'a.txt', text); commit(wt, `task ${t.id}`);
    assert.strictEqual((await M.handBack(e, `build-${label}`, t, undefined, wt)).state, 'done');
    await M.reviewed(e, t, label, 'holds');
    return t;
  };
  const a = await edit('a', 'from a\n');
  const b = await edit('b', 'from b\n');
  return { a, b, out: await e.tick() };
}

test('E3: a conflict at a policy integrate; one E3 wake naming the integration row, the conflicting task halted', async () => {
  const e = await M.env({ label: 'E3' });
  try {
    const { a, b, out } = await conflicting(e, NOFIX);
    assert.deepStrictEqual(out.steps.map((s) => [s.step, s.task_id]), [['integrate', a.id], ['integrate', b.id]]);
    assert.strictEqual(out.steps[0].outcome, 'done');
    const rows = e.raw('SELECT id, state, acted_by, seq FROM integration WHERE state = \'conflict\'');
    assert.strictEqual(rows.length, 1);
    const [conflict] = rows;
    assert.strictEqual(conflict.acted_by, 'policy');
    const wakes = (await e.poll()).filter((w) => w.exception === 'E3');
    M.expectOne(wakes, { exception: 'E3', field: 'integrate', task_id: b.id, trigger: { table: 'integration', id: conflict.id, seq: conflict.seq }, key: conflict.id });
    const stop = await M.halted(e);
    assert.ok(stop.has(b.id) && !stop.has(a.id), 'the conflicting task only');
    await e.tick();
    assert.strictEqual(e.raw('SELECT COUNT(DISTINCT id) AS n FROM integration')[0].n, 2, 'no second attempt');
  } finally { await e.close(); }
});

// api.md: E3 is a conflict at a policy integrate. The step's own claim ends `done` (a conflict is a finished step, and its row is E3's), so the fact wakes once.
nodeTest('E3 is the only wake for a conflict: the integrate step ends done, and no E8 follows', { timeout: 240000 }, async () => {
  const e = await M.env({ label: 'E3-only' });
  try {
    const { b, out } = await conflicting(e, NOFIX);
    const wakes = (await e.poll()).map((w) => [w.exception, w.task_id]); // polled first, so the kept store has its receipt whatever the assertions find
    assert.strictEqual(out.steps[1].outcome, 'done');
    assert.deepStrictEqual(wakes, [['E3', b.id]]);
  } finally { await e.close(); }
});

test('E5: a release evaluation that failed and is not a clean refutation; one wake, halted; not an E6', async () => {
  const e = await M.env({ label: 'E5' });
  try {
    const { task, row } = await M.workDone(e, 'x', { acceptance: M.FAIL, plan: NOFIX });
    assert.strictEqual(row.state, 'released');
    const trig = await M.tref(e, task.id);
    const w = M.expectOne(await e.poll(), { exception: 'E5', field: 'none', task_id: task.id, trigger: trig, key: `${task.id}@${await M.evaluatedAt(e, task.id)}` });
    assert.match(w.text, /evaluation failed: command /);
    assert.ok((await M.halted(e)).has(task.id));
    await M.assertOnce(e);
    assert.deepStrictEqual(M.stepsOf(e), []);
  } finally { await e.close(); }
});

test('a pass on a retry is not an exception: the task is done, no wake and no halt, the note is a step for the digest, and the review goes on', async () => {
  const e = await M.env({ label: 'E6-flaky' });
  try {
    const marker = `${e.dir}/flaky-marker`;
    const script = `${e.dir}/flaky.cjs`;
    fs.writeFileSync(script, `const fs = require('node:fs'); if (fs.existsSync(${JSON.stringify(marker)})) process.exit(0); fs.writeFileSync(${JSON.stringify(marker)}, '1'); process.exit(1);\n`);
    const acceptance = { commands: [{ argv: [process.execPath, script], timeout_ms: 20000, retries_on_fail: 1 }] };
    const { task, row } = await M.workDone(e, 'fl', { acceptance });
    assert.strictEqual(row.state, 'done');
    assert.strictEqual(row.results.flaky, true);
    await e.worker('rv');
    assert.deepStrictEqual(await e.poll(), [], 'no wake');
    assert.ok(!(await M.halted(e)).has(task.id), 'no halt');
    const out = await e.tick();
    assert.deepStrictEqual(out.steps.map((s) => [s.step, s.task_id, s.outcome]), [['note_flaky', task.id, 'done'], ['review', task.id, 'done']]);
    assert.strictEqual(out.steps[0].row_ref, `task:${task.id}`);
    assert.deepStrictEqual((await e.tick()).steps, [], 'the note is made once');
    assert.deepStrictEqual(await e.poll(), []);
  } finally { await e.close(); }
});

// Two evaluations run at once; the first's command waits for a file the second's command writes, so their spans overlap by construction (no sleep, no load).
test('E6, beside other evaluations: a failing check that ran beside another evaluation is E6 and not also E5', async () => {
  const e = await M.env({ label: 'E6-beside' });
  try {
    const hold = `${e.dir}/hold.cjs`; const release = `${e.dir}/release.cjs`; const flag = `${e.dir}/other-ran`;
    fs.writeFileSync(hold, `const fs = require('node:fs'); const end = Date.now() + 25000; (function poll() { if (fs.existsSync(${JSON.stringify(flag)})) process.exit(1); if (Date.now() > end) process.exit(3); setTimeout(poll, 10); })();\n`);
    fs.writeFileSync(release, `require('node:fs').writeFileSync(${JSON.stringify(flag)}, '1');\n`);
    const mk = async (label, script) => (await e.orch.task.create({ spec: label, acceptance: { commands: [{ argv: [process.execPath, script], timeout_ms: 30000 }] }, policy: NOFIX }));
    const slow = await mk('slow', hold); const quick = await mk('quick', release);
    await e.worker('rv'); // the plan's reviewer is there, so the review step the quick task's pass triggers writes no exception
    const lease = async (t, w) => { const wc = await e.worker(w); const a = await e.orch.task.assign({ task_id: t.id, worker_id: w }); await wc.lease.release({ lease_id: a.new_lease.id, reason: 'done', result: { branch: 'b', head: 'h' } }); };
    await lease(slow, 'build-slow'); await lease(quick, 'build-quick');
    const first = M.evaluate(e, slow.id); // starts first and waits
    const second = M.evaluate(e, quick.id);
    const [a, b] = await Promise.all([first, second]);
    assert.deepStrictEqual([a.state, b.state], ['released', 'done']);
    assert.ok(a.results.checks[0].concurrent && a.results.checks[0].concurrent.length > 0, JSON.stringify(a.results.checks[0]));
    const trig = await M.tref(e, slow.id);
    const w = M.expectOne(await e.poll(), { exception: 'E6', field: 'none', task_id: slow.id, trigger: trig, key: `${slow.id}@${await M.evaluatedAt(e, slow.id)}` });
    assert.match(w.text, /failed beside other evaluations/);
    assert.ok((await M.halted(e)).has(slow.id) && !(await M.halted(e)).has(quick.id));
    await M.assertOnce(e);
  } finally { await e.close(); }
});

test('E7: a review holds with should-fix findings; one wake with the titles, and the integrate step that is due is halted', async () => {
  const e = await M.env({ label: 'E7' });
  try {
    const { task } = await M.workDone(e, 's');
    const findings = [{ severity: 'should-fix', clause: 'a', note: 'tests run only in UTC' }, { severity: 'should-fix', clause: 'b', note: 'no empty week test' }];
    const { review } = await M.reviewed(e, task, 's', 'holds', { findings });
    const trig = await M.tref(e, review.id);
    const w = M.expectOne(await e.poll(), { exception: 'E7', field: 'none', task_id: task.id, trigger: trig, key: `${review.id}@${await M.evaluatedAt(e, review.id)}` });
    assert.match(w.text, /holds with 2 should-fix/);
    assert.ok((await M.halted(e)).has(task.id));
    // The step the plan calls for (integrate on a hold) is due and is not taken while the exception stands.
    const out = await e.tick();
    assert.deepStrictEqual(out.steps, [], 'halted: no claim');
    assert.deepStrictEqual(M.stepsOf(e), []);
    assert.strictEqual(e.raw('SELECT COUNT(*) AS n FROM integration')[0].n, 0);
    await M.assertOnce(e);
  } finally { await e.close(); }
});

test('E8: a step that failed (the builder it names is gone); one wake naming the step, halted, and a second pass does not retry', async () => {
  const e = await M.env({ label: 'E8' });
  try {
    const { task, builder } = await M.workDone(e, 'e');
    const { review } = await M.reviewed(e, task, 'e', 'refuted');
    await e.orch.worker.write({ id: builder, substrate: 'claude-code', pid: process.pid, state: 'stopped', session_id: `s-${builder}`, last_event_at: Date.now(), worktree: e.dir });
    const out = await e.tick();
    assert.deepStrictEqual(out.steps.map((s) => [s.step, s.outcome]), [['fix', 'exception']]);
    const [step] = M.stepsOf(e);
    assert.strictEqual(step.trigger_id, review.id);
    const w = M.expectOne(await e.poll(), { exception: 'E8', field: 'fix', task_id: task.id, trigger: { table: 'task', id: review.id, seq: step.trigger_seq }, key: `step${step.seq}` });
    assert.match(w.text, /Step fix failed: .*stopped/);
    assert.ok((await M.halted(e)).has(task.id));
    await M.assertOnce(e);
    assert.strictEqual(M.stepsOf(e).length, 1, 'not retried');
    assert.deepStrictEqual(M.fixesOf(e, task.id), [], 'the step wrote nothing');
  } finally { await e.close(); }
});

test('E4, E9 and E10 are today\'s wakes: a dead worker and a paused run, under a plan, derive no policy exception and halt nothing', async () => {
  const e = await M.env({ label: 'E4-E9-E10' });
  try {
    const { task, builder } = await M.workDone(e, 'd');
    await M.reviewed(e, task, 'd', 'holds', { findings: [] });
    await e.orch.worker.write({ id: builder, substrate: 'claude-code', pid: process.pid, state: 'dead', session_id: `s-${builder}`, last_event_at: Date.now(), worktree: e.dir });
    await e.orch.run.setPaused({ paused: true });
    assert.deepStrictEqual(await e.poll(), [], 'a worker death and a pause are the run\'s own wakes, not derived here');
    assert.deepStrictEqual(e.watcher.active(), []);
    assert.deepStrictEqual([...(await M.halted(e))], []);
    // Their wake rows are named for the run receipt, and a budget is no task halt.
    assert.deepStrictEqual(['death', 'stale', 'restart_failed', 'budget_pause', 'paused', 'pre_close', 'note_refuted', 'scrub_alarm'].map((event) => M.PW.exceptionOf({ event })), ['E4', 'E4', 'E4', 'E9', 'E10', 'E10', 'E10', 'E10']);
    assert.deepStrictEqual([...M.PW.haltedIds([{ exception: 'E4', task_id: task.id }, { exception: 'E9', task_id: task.id }, { exception: 'E10', task_id: task.id }], await M.rowsOf(e))], []);
    // Today's wake still passes the routine filter under a plan, unchanged (a death is not a turn end).
    const death = { event: 'death', worker_id: builder, turn: 1, seq: 9 };
    const seen = new Map();
    assert.deepStrictEqual(await RE.enrichWakes(e.h, M.RUN, [death], seen), [death]);
  } finally { await e.close(); }
});

