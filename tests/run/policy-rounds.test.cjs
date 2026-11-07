'use strict';
require('../helpers/tmp.cjs');
// policy-rounds.test.cjs — ADR 0074 amendment 5: a failure belay can see in the rows is a round of work for the builder, not a wake. Real core,
// real executor, real watcher (policy-matrix-env.cjs): workers hand back through their own cores, and the rows the core writes are the fact.
// Each case says what its former wake became: a red hand-back is a fix round, an evaluation that could not run is run again and then a round,
// a reviewer with no verdict is asked again, a pass on a retry is a note, a failure beside other evaluations is run alone, a conflict at
// integrate and failed integration checks are fix tasks for the builder, and every kind spends the one cap.

const { test: nodeTest } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { guarded, makeRepo, write, commit, git } = require('../core/worktree-helpers.cjs');
const M = require('./policy-matrix-env.cjs');
const { due } = require('../../src/run/policy-exec.cjs');
const RF = require('../../src/run/policy-rounds.cjs');
const RR = require('../../src/run/policy-rounds-run.cjs');

const test = guarded(nodeTest);
const cmd = (script) => ({ commands: [{ argv: [process.execPath, script], timeout_ms: 20000 }] });
// A check that fails the first time it runs and passes after: the marker is what changes between the hand-back and the fix.
function onceRed(e, name = 'once') {
  const script = `${e.dir}/${name}.cjs`; const marker = `${e.dir}/${name}.ran`;
  fs.writeFileSync(script, `const fs = require('node:fs'); if (fs.existsSync(${JSON.stringify(marker)})) process.exit(0); fs.writeFileSync(${JSON.stringify(marker)}, '1'); process.exit(1);\n`);
  return cmd(script);
}
const names = (out) => out.steps.map((s) => [s.step, s.task_id, s.outcome]);
const stepNames = (e) => M.stepsOf(e).map((s) => [s.step, s.outcome]);

test('C1: a red hand-back is a fix round for its builder; the fix goes green, the review follows, and nothing wakes', async () => {
  const e = await M.env({ label: 'round-red' });
  try {
    const { task, row, builder } = await M.workDone(e, 'r', { acceptance: onceRed(e) });
    assert.strictEqual(row.state, 'released');
    assert.deepStrictEqual(await e.poll(), [], 'no E5');
    assert.ok(!(await M.halted(e)).has(task.id), 'no halt');
    const out = await e.tick();
    assert.deepStrictEqual(names(out), [['fix_eval', task.id, 'done']]);
    assert.match(out.steps[0].row_ref, /^lease:/);
    assert.strictEqual(M.leaseOf(e, task.id).holder, builder, 'the same builder');
    assert.deepStrictEqual(await e.poll(), []);
    assert.strictEqual((await M.handBackLeased(e, task.id)).state, 'done', 'the fix goes green');
    await e.worker('rv');
    assert.deepStrictEqual(names(await e.tick()), [['review', task.id, 'done']], 'the review follows');
    assert.deepStrictEqual(await e.poll(), [], 'no wake at any point');
    assert.deepStrictEqual(M.fixesOf(e, task.id), [], 'the same task went back: no fix task');
  } finally { await e.close(); }
});

test('C1: red until the cap is an E2 wake, and the rounds taken are the cap', async () => {
  const e = await M.env({ label: 'round-cap', attach: { max_fix_rounds: 2 } });
  try {
    const red = `${e.dir}/red.cjs`;
    fs.writeFileSync(red, "console.error('AssertionError: expected 3 to equal 4'); process.exit(1);\n");
    const { task } = await M.workDone(e, 'r', { acceptance: cmd(red) });
    for (let n = 1; n <= 2; n++) {
      assert.deepStrictEqual(await e.poll(), [], `round ${n} is not a wake`);
      assert.deepStrictEqual(names(await e.tick()), [['fix_eval', task.id, 'done']]);
      assert.strictEqual((await M.handBackLeased(e, task.id)).state, 'released', 'still red');
    }
    const w = M.expectOne(await e.poll(), { exception: 'E2', field: 'fix', task_id: task.id, trigger: await M.tref(e, task.id), key: `${task.id}@${await M.evaluatedAt(e, task.id)}` });
    assert.match(w.text, /Fix cap 2\/2; tests red: AssertionError: expected 3/, w.text);
    assert.ok((await M.halted(e)).has(task.id));
    assert.deepStrictEqual(await e.tick().then(names), [], 'nothing more is taken');
    assert.deepStrictEqual(stepNames(e), [['fix_eval', 'done'], ['fix_eval', 'done']]);
  } finally { await e.close(); }
});

test('C1: the cap is one count across the kinds: a red round and a refuted review spend the same two rounds', async () => {
  const e = await M.env({ label: 'round-mixed', attach: { max_fix_rounds: 2 } });
  try {
    const { task } = await M.workDone(e, 'm', { acceptance: onceRed(e) });
    assert.deepStrictEqual(names(await e.tick()), [['fix_eval', task.id, 'done']], 'round 1: the red hand-back');
    assert.strictEqual((await M.handBackLeased(e, task.id)).state, 'done');
    await M.reviewed(e, task, 'm', 'refuted', { judge: 'rv' });
    assert.deepStrictEqual(await e.poll(), [], 'a round is left');
    assert.deepStrictEqual(names(await e.tick()).map((s) => s[0]), ['fix'], 'round 2: the refuted review');
    const fix = M.fixesOf(e, task.id)[0].id;
    assert.strictEqual((await M.handBackLeased(e, fix)).state, 'done');
    assert.deepStrictEqual(names(await e.tick()).map((s) => s[0]), ['re_review']);
    const rr = e.raw('SELECT id FROM task WHERE depends_on LIKE ? AND acceptance LIKE ?', `%${fix}%`, '%verdict%')[0].id;
    await M.handBackLeased(e, rr, { verdict: 'refuted', summary: 'still wrong', findings: [{ severity: 'blocking', clause: 'a', note: 'still wrong' }] });
    const w = M.expectOne(await e.poll(), { exception: 'E2', field: 'fix', task_id: task.id, trigger: await M.tref(e, rr), key: `${rr}@${await M.evaluatedAt(e, rr)}` });
    assert.match(w.text, /Fix cap reached \(2 used of 2\)/);
  } finally { await e.close(); }
});

test('C1: an evaluation that could not run is run again once, bounded; a hand-back that passes then goes on to its review', async () => {
  const e = await M.env({ label: 'round-rerun' });
  try {
    const t = await e.orch.task.create({ spec: 'lost', acceptance: M.PASS, policy: M.PLAN });
    const w = await e.worker('build-lost');
    const a = await e.orch.task.assign({ task_id: t.id, worker_id: 'build-lost' });
    await w.lease.release({ lease_id: a.new_lease.id, reason: 'done', result: { branch: 'b', head: 'h' } });
    await e.h.memory.recordEvent({ kind: 'release_failed', ok: 0, code: 'E_BUSY', worker_id: 'build-lost', task_id: t.id, message: JSON.stringify({ turn: 1, by: 'queued too long' }) });
    assert.deepStrictEqual(await e.poll(), [], 'a lost evaluation is not an E5 while the plan can run it again');
    await e.worker('rv');
    const out = await e.tick();
    assert.deepStrictEqual(names(out), [], 'the re-run is detached: the pass does not wait for the evaluation');
    await e.x.settle();
    assert.deepStrictEqual(stepNames(e), [['rerun_eval', 'done'], ['review', 'done']], 'the evaluation passed, so the review follows at once');
    assert.strictEqual((await M.rowOf(e, t.id)).state, 'done');
    assert.deepStrictEqual(await e.poll(), []);
  } finally { await e.close(); }
});

// The rows a hand-back with an evaluation that never ran leaves, without a store: due() is a pure function of them.
const T = (id, over = {}) => ({ id, seq: 100, run_id: 'r1', state: 'open', policy: null, policy_rev: null, depends_on: [], repairs: null, results: null, handoff: null, lease: null, review: null, integration: null, written_at: 50, ...over });
const PLAN = { review: { worker: 'rv' }, fix: 'builder', re_review: 'refuter', integrate: 'on_hold' };
const lost = { runId: 'r1', integrations: [], rounds: { caps: { max: 2, hard: null } } };

test('C1: a lost evaluation, run again and still lost, is a fix round naming the reason; the re-run that did not finish is not an exception', async () => {
  const W = T('W', { state: 'released', policy: PLAN, policy_rev: 1, handoff: { by: 'b1', at: 10 } });
  const failures = [{ id: 'f1', seq: 7, task_id: 'W', code: 'E_BUSY', written_at: 30 }];
  assert.deepStrictEqual(due({ ...lost, tasks: [W], steps: [], failures }).map((c) => c.step), ['rerun_eval']);
  const tried = [{ seq: 1, run_id: 'r1', task_id: 'W', step: 'rerun_eval', trigger_table: 'task', trigger_id: 'W', trigger_seq: 100, outcome: 'skipped', error: 'the re-run did not finish: E_BUSY: x', at: 40, finished_at: 41 }];
  const next = due({ ...lost, tasks: [W], steps: tried, failures });
  assert.deepStrictEqual(next.map((c) => [c.step, c.worker]), [['fix_run', 'b1']]);
  assert.match(next[0].prompt, /could not evaluate your hand-back of task W \(E_BUSY\).*Fix round 1 of 2\./);
  const going = tried.map((s) => ({ ...s, outcome: 'started', error: null }));
  assert.deepStrictEqual(due({ ...lost, tasks: [W], steps: going, failures }), [], 'the re-run in flight: nothing else is due');
  const env = { core: { task: { get: async () => W, evaluate: async () => { throw Object.assign(new Error('worktree gone'), { code: 'E_INTERNAL' }); } }, worker: { list: async () => ({ workers: [{ id: 'b1', worktree: '/w' }] }) } } };
  const res = await RR.RUNNERS.rerun_eval({ step: 'rerun_eval', task_id: 'W' }, env);
  assert.deepStrictEqual([res.outcome, /^the re-run did not finish: E_INTERNAL/.test(res.error)], ['skipped', true]);
  const spent = { ...lost, rounds: { caps: { max: 0, hard: null } } };
  assert.deepStrictEqual(due({ ...spent, tasks: [W], steps: tried, failures }), [], 'at the cap nothing is due (the wake is E2)');
});

test('C1: a reviewer that released with no verdict is asked again, once; the second time is the wake', async () => {
  const e = await M.env({ label: 'round-reask' });
  try {
    const { task } = await M.workDone(e, 'w');
    const review = await e.orch.task.create({ spec: 'review w', depends_on: [task.id], acceptance: { verdict: true } });
    const row = await M.handBack(e, 'judge-w', review, { summary: 'I looked at it' });
    assert.strictEqual(row.state, 'released');
    assert.strictEqual(row.results.executable, false);
    assert.deepStrictEqual(await e.poll(), [], 'not yet an E5');
    const out = await e.tick();
    assert.deepStrictEqual(names(out), [['reask', review.id, 'done']]);
    assert.strictEqual(M.leaseOf(e, review.id).holder, 'judge-w', 'the same reviewer');
    assert.strictEqual((await M.handBackLeased(e, review.id, { summary: 'still no verdict' })).results.executable, false);
    const w = M.expectOne(await e.poll(), { exception: 'E5', field: 'none', task_id: review.id, trigger: await M.tref(e, review.id), key: `${review.id}@${await M.evaluatedAt(e, review.id)}` });
    assert.match(w.text, /could not judge/);
    assert.deepStrictEqual(await e.tick().then(names), [], 'asked once: the bound is its own');
  } finally { await e.close(); }
});

test('C2: a failure beside other evaluations is run alone once; a pass alone proceeds with no wake', async () => {
  const e = await M.env({ label: 'round-alone-pass' });
  try {
    const hold = `${e.dir}/hold.cjs`; const release = `${e.dir}/release.cjs`; const flag = `${e.dir}/other-ran`; const marker = `${e.dir}/hold-ran`;
    // The slow check waits for the quick one to write the flag, fails once (marking itself), and passes when run again alone.
    fs.writeFileSync(hold, `const fs = require('node:fs'); if (fs.existsSync(${JSON.stringify(marker)})) process.exit(0); const end = Date.now() + 25000; (function poll() { if (fs.existsSync(${JSON.stringify(flag)})) { fs.writeFileSync(${JSON.stringify(marker)}, '1'); process.exit(1); } if (Date.now() > end) process.exit(3); setTimeout(poll, 10); })();\n`);
    fs.writeFileSync(release, `require('node:fs').writeFileSync(${JSON.stringify(flag)}, '1');\n`);
    const mk = (label, script) => e.orch.task.create({ spec: label, acceptance: cmd(script), policy: M.PLAN });
    const slow = await mk('slow', hold); const quick = await e.orch.task.create({ spec: 'quick', acceptance: cmd(release) }); // no plan: only the slow work is the plan's
    await e.worker('rv');
    const lease = async (t, w) => { const wc = await e.worker(w); const a = await e.orch.task.assign({ task_id: t.id, worker_id: w }); await wc.lease.release({ lease_id: a.new_lease.id, reason: 'done', result: { branch: 'b', head: 'h' } }); };
    await lease(slow, 'build-slow'); await lease(quick, 'build-quick');
    const [a, b] = await Promise.all([M.evaluate(e, slow.id), M.evaluate(e, quick.id)]);
    assert.deepStrictEqual([a.state, b.state], ['released', 'done']);
    assert.deepStrictEqual(await e.poll(), [], 'no E6');
    assert.ok(!(await M.halted(e)).has(slow.id));
    await e.tick(); await e.x.settle();
    assert.deepStrictEqual(M.stepsOf(e).filter((s) => s.task_id === slow.id && s.step === 'rerun_alone').map((s) => s.outcome), ['done']);
    assert.strictEqual((await M.rowOf(e, slow.id)).state, 'done', 'passed alone: it goes on');
    assert.deepStrictEqual(await e.poll(), []);
    assert.deepStrictEqual(M.fixesOf(e, slow.id), []);
  } finally { await e.close(); }
});

test('C2: a failure beside other evaluations that fails alone too is C1: a fix round, after the one re-run', async () => {
  const e = await M.env({ label: 'round-alone-fail' });
  try {
    const hold = `${e.dir}/hold.cjs`; const release = `${e.dir}/release.cjs`; const flag = `${e.dir}/other-ran`;
    fs.writeFileSync(hold, `const fs = require('node:fs'); const end = Date.now() + 25000; (function poll() { if (fs.existsSync(${JSON.stringify(flag)})) process.exit(1); if (Date.now() > end) process.exit(3); setTimeout(poll, 10); })();\n`);
    fs.writeFileSync(release, `require('node:fs').writeFileSync(${JSON.stringify(flag)}, '1');\n`);
    const mk = (label, script) => e.orch.task.create({ spec: label, acceptance: cmd(script), policy: M.PLAN });
    const slow = await mk('slow', hold); const quick = await e.orch.task.create({ spec: 'quick', acceptance: cmd(release) }); // no plan: only the slow work is the plan's
    await e.worker('rv');
    const lease = async (t, w) => { const wc = await e.worker(w); const a = await e.orch.task.assign({ task_id: t.id, worker_id: w }); await wc.lease.release({ lease_id: a.new_lease.id, reason: 'done', result: { branch: 'b', head: 'h' } }); };
    await lease(slow, 'build-slow'); await lease(quick, 'build-quick');
    await Promise.all([M.evaluate(e, slow.id), M.evaluate(e, quick.id)]);
    assert.deepStrictEqual(await e.poll(), []);
    await e.tick(); await e.x.settle();
    assert.deepStrictEqual(M.stepsOf(e).filter((s) => s.task_id === slow.id).map((s) => [s.step, s.outcome]), [['rerun_alone', 'done'], ['fix_eval', 'done']], 'failed alone too: the one re-run, then the round');
    assert.strictEqual((await M.rowOf(e, slow.id)).state, 'assigned', 'failed alone, and already sent back');
    assert.deepStrictEqual(await e.poll(), []);
    assert.deepStrictEqual(stepNames(e).filter((s) => s[0] !== 'review' && s[0] !== 'note_flaky'), [['rerun_alone', 'done'], ['fix_eval', 'done']]);
  } finally { await e.close(); }
});

// Two works that edit one file differently, both held; the first merges, the second conflicts at the policy integrate.
async function conflicting(e, { project = true, third = false } = {}) {
  const repo = makeRepo(e.dir);
  if (project) await e.orch.run.attach({ adapter_pid: process.pid, project_dir: repo }); // the fix task is worked in a tree of the run's repository (tree_of)
  const edit = async (label, text, file = 'a.txt') => {
    const t = await e.orch.task.create({ spec: `${label} edits ${file}`, acceptance: M.PASS, policy: M.PLAN });
    const wt = (await e.op.task.worktreeCreate({ task_id: t.id, repo })).worktree.path;
    write(wt, file, text); commit(wt, `task ${t.id}`);
    assert.strictEqual((await M.handBack(e, `build-${label}`, t, undefined, wt)).state, 'done');
    await M.reviewed(e, t, label, 'holds');
    return { t, wt };
  };
  const a = await edit('a', 'from a\n');
  const b = await edit('b', 'from b\n');
  const c = third ? await edit('c', 'from c\n', 'c.txt') : null;
  return { a: a.t, b: b.t, c: c && c.t, bTree: b.wt, out: await e.tick() };
}
// The builder hands the fix back from its own tree and belay evaluates it there.
async function handBackFix(e, fixId) {
  const l = M.leaseOf(e, fixId);
  const w = await e.worker(l.holder);
  await w.lease.release({ lease_id: l.id, reason: 'done', result: { branch: 'b', head: 'fixed' } });
  return M.evaluate(e, fixId, true);
}

test('C3: a conflict at integrate is a fix task for the builder; when it is done the merge is tried again and lands', async () => {
  const e = await M.env({ label: 'round-conflict' });
  try {
    const { a, b, bTree, out } = await conflicting(e);
    assert.deepStrictEqual(names(out).map((s) => s.slice(0, 1).concat(s.slice(2))), [['integrate', 'done'], ['integrate', 'done']]);
    assert.deepStrictEqual(await e.poll(), [], 'no E3');
    assert.ok(!(await M.halted(e)).has(b.id));
    const fixed = await e.tick();
    assert.deepStrictEqual(names(fixed), [['fix_conflict', b.id, 'done']], JSON.stringify(M.stepsOf(e)));
    const [fix] = M.fixesOf(e, b.id);
    assert.strictEqual(fixed.steps[0].row_ref, `task:${fix.id}`);
    assert.strictEqual(M.leaseOf(e, fix.id).holder, 'build-b', 'the builder of the conflicting task');
    assert.match((await M.rowOf(e, fix.id)).spec, /merge or rebase belay\/integrate\/test-run into your branch and resolve/);
    write(bTree, 'a.txt', 'from a\n'); commit(bTree, 'resolve');
    assert.strictEqual((await handBackFix(e, fix.id)).state, 'done');
    assert.deepStrictEqual(await e.poll(), []);
    const again = await e.tick();
    assert.deepStrictEqual(names(again), [['integrate', b.id, 'done']], 'the merge is retried with the fix, not re-reviewed');
    assert.strictEqual((await M.rowOf(e, b.id)).integration.state, 'merged');
    assert.deepStrictEqual((await e.poll()).map((w) => w.event), ['policy_done'], 'the one routine wake: implementation done, now that the retried merge landed');
    assert.ok(a.id);
  } finally { await e.close(); }
});

test('C3: a conflict at the cap is an E2 wake naming the conflict, not an E3', async () => {
  const e = await M.env({ label: 'round-conflict-cap', attach: { max_fix_rounds: 0 } });
  try {
    const { b } = await conflicting(e, { project: false });
    const w = M.expectOne((await e.poll()).filter((x) => x.exception !== 'E7'), { exception: 'E2', field: 'fix', task_id: b.id, trigger: { table: 'integration', id: e.raw("SELECT id FROM integration WHERE state = 'conflict'")[0].id }, key: e.raw("SELECT id FROM integration WHERE state = 'conflict'")[0].id });
    assert.match(w.text, /Fix cap 0\/0; integrate conflict: a\.txt/, w.text);
    assert.deepStrictEqual(await e.tick().then(names), []);
  } finally { await e.close(); }
});

test('C3: failed integration checks are a fix task for the builder; when it is done the merge is tried again and its checks pass', async () => {
  const e = await M.env({ label: 'round-checks' });
  try {
    const repo = makeRepo(e.dir);
    await e.orch.run.attach({ adapter_pid: process.pid, project_dir: repo });
    const work = async (label, files, acceptance) => {
      const t = await e.orch.task.create({ spec: `${label}`, acceptance, policy: M.PLAN });
      const wt = (await e.op.task.worktreeCreate({ task_id: t.id, repo })).worktree.path;
      for (const [f, text] of Object.entries(files)) write(wt, f, text);
      commit(wt, `task ${t.id}`);
      assert.strictEqual((await M.handBack(e, `build-${label}`, t, undefined, wt)).state, 'done');
      await M.reviewed(e, t, label, 'holds');
      return { t, wt };
    };
    const a = await work('a', { 'bad.txt': 'x\n' }, M.PASS);
    // b's check fails once a's file is in the tree it is merged into: it passes in b's own tree, and fails on the merged head.
    const b = await work('b', { 'check.cjs': "process.exit(require('node:fs').existsSync('bad.txt') ? 1 : 0);\n" }, { commands: [{ argv: [process.execPath, 'check.cjs'], timeout_ms: 20000 }] });
    const first = await e.tick();
    assert.deepStrictEqual(names(first).map((s) => [s[0], s[1], s[2]]), [['integrate', a.t.id, 'done'], ['integrate', b.t.id, 'done']]);
    const newest = async () => (await e.h.integration.list({})).integrations.reduce((x, y) => (Number(y.seq) > Number(x.seq) ? y : x));
    assert.deepStrictEqual([(await newest()).state, (await newest()).passed], ['evaluated', false], 'b\'s merge was checked and failed');
    assert.deepStrictEqual((await e.poll()).filter((w) => w.exception === 'E8' || w.exception === 'E3'), [], 'no E8');
    const fixed = await e.tick();
    assert.deepStrictEqual(names(fixed), [['fix_checks', b.t.id, 'done']]);
    const [fix] = M.fixesOf(e, b.t.id);
    assert.strictEqual(M.leaseOf(e, fix.id).holder, 'build-b');
    git(b.wt, 'merge', '-q', '--no-edit', 'belay/integrate/test-run');
    git(b.wt, 'rm', '-q', 'bad.txt'); commit(b.wt, 'remove the file the check refuses');
    assert.strictEqual((await handBackFix(e, fix.id)).state, 'done');
    assert.deepStrictEqual(names(await e.tick()), [['integrate', b.t.id, 'done']], 'tried again with the fix');
    assert.deepStrictEqual([(await newest()).state, (await newest()).passed], ['evaluated', true]);
    assert.deepStrictEqual((await e.poll()).map((w) => w.event), ['policy_done']);
  } finally { await e.close(); }
});

test('C1: a done hand-back with no commit past its base is a fix task for the same builder; review waits for it, then goes on', async () => {
  const e = await M.env({ label: 'round-nocommit' });
  try {
    const repo = makeRepo(e.dir);
    await e.orch.run.attach({ adapter_pid: process.pid, project_dir: repo });
    const t = await e.orch.task.create({ spec: 'write a.txt', acceptance: M.PASS, policy: M.PLAN });
    const wt = (await e.op.task.worktreeCreate({ task_id: t.id, repo })).worktree;
    const row = await M.handBack(e, 'build-nc', t, undefined, wt.path); // the worker could not commit: nothing new on the branch
    assert.strictEqual(row.state, 'done');
    assert.strictEqual(row.results.head_sha, wt.base_sha);
    await e.worker('rv');
    assert.deepStrictEqual(await e.poll(), [], 'no wake');
    const out = await e.tick();
    assert.deepStrictEqual(names(out), [['fix_commit', t.id, 'done']], 'a fix round, and no review of an empty branch');
    const [fix] = M.fixesOf(e, t.id);
    assert.strictEqual(M.leaseOf(e, fix.id).holder, 'build-nc');
    assert.match((await M.rowOf(e, fix.id)).spec, /nothing new on your branch since [0-9a-f]{8}.*commit your work/);
    assert.deepStrictEqual(await e.tick().then(names), [], 'the fix is not done: nothing is reviewed or merged yet');
    write(wt.path, 'a.txt', 'a\n'); commit(wt.path, 'the work');
    assert.strictEqual((await handBackFix(e, fix.id)).state, 'done');
    assert.deepStrictEqual(names(await e.tick()), [['review', t.id, 'done']]);
    assert.deepStrictEqual(await e.poll(), []);
  } finally { await e.close(); }
});

test('C1: a builder that can never commit burns the cap, and the E2 wake says no commit since base', async () => {
  const e = await M.env({ label: 'round-nocommit-cap', attach: { max_fix_rounds: 0 } });
  try {
    const repo = makeRepo(e.dir);
    const t = await e.orch.task.create({ spec: 'write a.txt', acceptance: M.PASS, policy: M.PLAN });
    const wt = (await e.op.task.worktreeCreate({ task_id: t.id, repo })).worktree;
    assert.strictEqual((await M.handBack(e, 'build-nc', t, undefined, wt.path)).state, 'done');
    const w = M.expectOne(await e.poll(), { exception: 'E2', field: 'fix', task_id: t.id, trigger: await M.tref(e, t.id), key: `${t.id}@${await M.evaluatedAt(e, t.id)}` });
    assert.match(w.text, /Fix cap 0\/0; no commit since base: nothing new on your branch/, w.text);
    assert.deepStrictEqual(await e.tick().then(names), []);
  } finally { await e.close(); }
});

test('C3: a conflict is not superseded by the next work merged in the same pass: task_ids are cumulative, so it still gets its fix round', async () => {
  const e = await M.env({ label: 'round-conflict-next' });
  try {
    const { a, b, c, out } = await conflicting(e, { third: true });
    assert.deepStrictEqual(names(out), [['integrate', a.id, 'done'], ['integrate', b.id, 'done'], ['integrate', c.id, 'done']]);
    assert.deepStrictEqual(await e.poll(), [], 'no E3: the plan takes it');
    assert.deepStrictEqual(names(await e.tick()), [['fix_conflict', b.id, 'done']], 'the conflicting work still gets its round');
  } finally { await e.close(); }
});

test('C3: with no fix step the conflict still wakes E3 when another work was merged after it', async () => {
  const e = await M.env({ label: 'round-conflict-next-e3' });
  try {
    const repo = makeRepo(e.dir);
    const edit = async (label, text, file) => {
      const t = await e.orch.task.create({ spec: label, acceptance: M.PASS, policy: M.without(M.PLAN, 'fix') });
      const wt = (await e.op.task.worktreeCreate({ task_id: t.id, repo })).worktree.path;
      write(wt, file, text); commit(wt, label);
      await M.handBack(e, 'build-' + label, t, undefined, wt); await M.reviewed(e, t, label, 'holds');
      return t;
    };
    await edit('a', 'from a\n', 'a.txt'); const b = await edit('b', 'from b\n', 'a.txt'); await edit('c', 'from c\n', 'c.txt');
    await e.tick();
    assert.deepStrictEqual((await e.poll()).map((w) => [w.exception, w.task_id]), [['E3', b.id]]);
  } finally { await e.close(); }
});

// Work a adds bad.txt; b's check fails once a is in the tree it is merged into; c is unrelated and held.
async function redBranch(e, plan = M.PLAN) {
  const repo = makeRepo(e.dir);
  await e.orch.run.attach({ adapter_pid: process.pid, project_dir: repo });
  const work = async (label, files, acceptance) => {
    const t = await e.orch.task.create({ spec: label, acceptance, policy: plan });
    const wt = (await e.op.task.worktreeCreate({ task_id: t.id, repo })).worktree.path;
    for (const [f, text] of Object.entries(files)) write(wt, f, text);
    commit(wt, `task ${t.id}`);
    assert.strictEqual((await M.handBack(e, `build-${label}`, t, undefined, wt)).state, 'done');
    await M.reviewed(e, t, label, 'holds');
    return { t, wt };
  };
  const a = await work('a', { 'bad.txt': 'x\n' }, M.PASS);
  const b = await work('b', { 'check.cjs': "process.exit(require('node:fs').existsSync('bad.txt') ? 1 : 0);\n" }, { commands: [{ argv: [process.execPath, 'check.cjs'], timeout_ms: 20000 }] });
  const c = await work('c', { 'c.txt': 'c\n' }, M.PASS);
  return { a, b, c };
}
const resolveB = (b) => { git(b.wt, 'merge', '-q', '--no-edit', 'belay/integrate/test-run'); git(b.wt, 'rm', '-q', 'bad.txt'); commit(b.wt, 'remove the file the check refuses'); };

test('C3: nothing is merged onto a red branch: the next work waits until the failing work\'s fix lands, so it is not blamed for it', async () => {
  const e = await M.env({ label: 'round-red-hold' });
  try {
    const { a, b, c } = await redBranch(e);
    const first = await e.tick();
    assert.deepStrictEqual(names(first).filter((s) => s[2] !== 'skipped'), [['integrate', a.t.id, 'done'], ['integrate', b.t.id, 'done']], 'c is held');
    const ints = async () => (await e.h.integration.list({})).integrations;
    assert.ok((await ints()).every((i) => !i.task_ids.includes(c.t.id)), 'c was not merged onto the red branch');
    assert.deepStrictEqual(names(await e.tick()), [['fix_checks', b.t.id, 'done']], 'the failing work gets the round, and still c waits');
    const [fix] = M.fixesOf(e, b.t.id);
    resolveB(b);
    assert.strictEqual((await handBackFix(e, fix.id)).state, 'done');
    assert.deepStrictEqual(names(await e.tick()), [['integrate', b.t.id, 'done']], 'b is merged again first');
    assert.deepStrictEqual(names(await e.tick()), [['integrate', c.t.id, 'done']], 'then c');
    assert.deepStrictEqual((await e.poll()).map((w) => w.event), ['policy_done']);
  } finally { await e.close(); }
});

test('C3: an E8 on failed integration checks lifts when a later merge of that work passes, the orchestrator\'s own included', async () => {
  const e = await M.env({ label: 'round-e8-lift' });
  try {
    const { a, b } = await redBranch(e, M.without(M.PLAN, 'fix'));
    await e.tick();
    const w = (await e.poll()).filter((x) => x.exception === 'E8' && x.task_id === b.t.id); // c, merged after it under a plan with no fix step, has its own E8
    assert.strictEqual(w.length, 1, JSON.stringify(w));
    assert.ok((await M.halted(e)).has(b.t.id), 'halted');
    resolveB(b);
    // The orchestrator's own remedy, as in a real run: a plain task in b's tree (no repairs, no depends_on), handed to b's builder, then a merge by hand.
    const mine = await e.orch.task.create({ spec: 'remove bad.txt', acceptance: M.PASS, tree_of: b.t.id });
    const lease = await e.orch.task.assign({ task_id: mine.id, worker_id: 'build-b' });
    await (await e.worker('build-b')).lease.release({ lease_id: lease.new_lease.id, reason: 'done', result: { branch: 'b', head: 'fixed' } });
    assert.strictEqual((await M.evaluate(e, mine.id, true)).state, 'done');
    const merged = await e.orch.integration.merge({ task_ids: [b.t.id, mine.id] });
    assert.strictEqual(merged.passed, true, JSON.stringify(merged.checks));
    assert.deepStrictEqual(await e.poll(), []);
    assert.ok(!(await M.halted(e)).has(b.t.id), 'the halt lifted with the passing merge');
    assert.ok(a.t.id);
  } finally { await e.close(); }
});

const failBeside = { trigger: 'release', evaluated_at: 20, executable: true, passed: false, checks: [{ kind: 'command', argv: ['node', '--test'], passed: false, exit_code: 1, concurrent: ['B'] }] };
const beside = (over = {}) => ({ runId: 'r1', integrations: [], steps: [], failures: [], rounds: { caps: { max: 2, hard: null } }, now: 30, ...over });

test('C2: a failure beside another evaluation waits only for a real one: a stand-down or an evaluation lost long ago does not hold it', () => {
  const A = T('A', { seq: 10, state: 'released', policy: PLAN, policy_rev: 1, handoff: { by: 'b1', at: 10 }, results: failBeside });
  const standDown = T('B', { seq: 11, state: 'released', policy: PLAN, policy_rev: 1, handoff: { by: 'b2', at: 12, stood_down: 'cannot do it' } });
  assert.deepStrictEqual(due(beside({ tasks: [A, standDown] })).map((c) => c.step), ['rerun_alone'], 'a stand-down is never evaluated: it is not in flight');
  const pending = T('B', { seq: 11, state: 'released', policy: PLAN, policy_rev: 1, handoff: { by: 'b2', at: 12 } });
  assert.deepStrictEqual(due(beside({ tasks: [A, pending] })), [], 'a hand-back being evaluated: wait');
  assert.deepStrictEqual(due(beside({ tasks: [A, pending], now: 20 + 120001 })).map((c) => c.step), ['rerun_alone'], 'past the bound it no longer waits for an evaluation that never lands');
  const byHand = { ...pending, results: { evaluated_at: 25, executable: true, passed: true, checks: [] } };
  assert.deepStrictEqual(due(beside({ tasks: [A, byHand] })).map((c) => c.step), ['rerun_alone'], 'evaluated by the orchestrator, without the release trigger: done being evaluated');
});

test('C1: a reviewer with no verdict is asked again only under a plan with a fix step', () => {
  const R = (plan) => T('R', { seq: 20, state: 'released', policy: plan, policy_rev: 1, acceptance: { verdict: true }, handoff: { by: 'rv', at: 10 }, results: { trigger: 'release', evaluated_at: 20, executable: false, passed: false, checks: [{ kind: 'verdict', executable: false, passed: false }] } });
  assert.deepStrictEqual(due(beside({ tasks: [R(PLAN)] })).map((c) => c.step), ['reask']);
  assert.deepStrictEqual(due(beside({ tasks: [R({ ...PLAN, fix: undefined })] })), [], 'no fix step: the E5 wake as before');
});

test('the rounds are never unbounded: a run that states neither lever gets the default of 2', () => {
  assert.deepStrictEqual(RF.capsOf({}), { max: 2, hard: null });
  assert.deepStrictEqual(RF.capsOf({ max_fix_rounds: 5 }), { max: 5, hard: null });
  assert.deepStrictEqual(RF.capsOf({ fix_hard_cap: 3 }), { max: null, hard: 3 });
});

test('C1: a queue refusal on the re-run reopens the claim: it is taken again, and is not a round that tells the builder to commit', async () => {
  const W = T('W', { state: 'released', policy: PLAN, policy_rev: 1, handoff: { by: 'b1', at: 10 } });
  const env = { core: { task: { get: async () => W, evaluate: async () => { throw Object.assign(new Error('queue full'), { code: 'E_BUSY' }); } }, worker: { list: async () => ({ workers: [{ id: 'b1', worktree: '/w' }] }) } } };
  const res = await RR.RUNNERS.rerun_eval({ step: 'rerun_eval', task_id: 'W' }, env);
  assert.deepStrictEqual([res.outcome, /^E_NOT_NOW/.test(res.error)], ['skipped', true]);
  const failures = [{ id: 'f1', seq: 7, task_id: 'W', code: 'E_BUSY', written_at: 30 }];
  const tried = [{ seq: 1, run_id: 'r1', task_id: 'W', step: 'rerun_eval', trigger_table: 'task', trigger_id: 'W', trigger_seq: 100, outcome: 'skipped', error: res.error, at: 40, finished_at: 41 }];
  assert.deepStrictEqual(due(beside({ tasks: [W], steps: tried, failures })).map((c) => c.step), ['rerun_eval'], 'not fix_run');
});

test('the done wake sees the rounds: it is not done while a retried merge is due', () => {
  const { doneOf } = require('../../src/run/done-wake.cjs');
  const rows = (R, extra) => ({ runId: 'r1', ...extra });
  const W = T('W', { state: 'done', policy: PLAN, policy_rev: 1, handoff: { by: 'b1', at: 10 }, results: { trigger: 'release', evaluated_at: 20, executable: true, passed: true, checks: [], head_sha: 'a1', flaky: true }, review: { state: 'holds', review_id: 'R' }, integration: { state: 'merged' } });
  const R = T('R', { state: 'done', depends_on: ['W'], acceptance: { verdict: true }, results: { trigger: 'release', evaluated_at: 21, executable: true, passed: true, checks: [{ kind: 'verdict', executable: true, passed: true }] } });
  const ints = [{ id: 'I', run_id: 'r1', seq: 5, into_branch: 'belay/integrate/r1', state: 'evaluated', passed: true, head_sha: 'abc', task_ids: ['W'], acted_by: 'policy' }];
  const base = { ...rows(null, {}), tasks: [W, R], integrations: ints, steps: [] };
  assert.ok(doneOf(base), 'without the rounds the flaky note is invisible, as before');
  assert.strictEqual(doneOf({ ...base, rounds: { caps: { max: 2, hard: null } }, failures: [] }), null, 'with them, the note is still due: not done yet');
});

// The rows of a red branch: X merged and its checks failed; W2 is held, reviewed and not merged.
function redRows(plan, redBy = 'policy', steps = []) {
  const rel = (at) => ({ trigger: 'release', evaluated_at: at, executable: true, passed: true, checks: [] });
  const i1 = { id: 'i1', run_id: 'r1', seq: 30, state: 'evaluated', into_branch: 'belay/integrate/r1', acted_by: redBy, passed: false, task_ids: ['X'], checks: [{ argv: ['npm', 'test'], task_ids: ['X'], passed: false, exit_code: 1 }] };
  const X = T('X', { seq: 5, state: 'done', policy: plan, policy_rev: 1, handoff: { by: 'bx', at: 1 }, results: rel(2), review: { state: 'holds', review_id: 'RX' }, integration: { state: 'merged', id: 'i1', passed: false } });
  const RX = T('RX', { seq: 6, state: 'done', acceptance: { verdict: true }, depends_on: ['X'], handoff: { by: 'rv', at: 3 }, results: rel(4) });
  const W2 = T('W2', { seq: 7, state: 'done', policy: plan, policy_rev: 1, handoff: { by: 'bw', at: 1 }, results: rel(2), review: { state: 'holds', review_id: 'RW' }, integration: { state: 'not_merged', into: null } });
  const RW = T('RW', { seq: 8, state: 'done', acceptance: { verdict: true }, depends_on: ['W2'], handoff: { by: 'rv', at: 3 }, results: rel(4) });
  return { runId: 'r1', tasks: [X, RX, W2, RW], integrations: [i1], steps, roundSteps: steps, failures: [], rounds: { caps: { max: 2, hard: null } } };
}

test('C3: the red hold is only for a red the plan carries: a merge the orchestrator made, or a plan with no fix step, holds nothing', () => {
  const steps = (cancelled) => [{ seq: 50, run_id: 'r1', step: 'fix_checks', task_id: 'X', outcome: 'done', row_ref: 'task:F1', trigger_table: 'integration', trigger_id: 'i1', trigger_seq: 30, at: 35 }].concat(cancelled ? [] : []);
  const ids = (snap) => due(snap).filter((c) => c.step === 'integrate').map((c) => c.task_id);
  const F1 = (state) => T('F1', { seq: 40, state, repairs: 'X', depends_on: ['X'] });
  const carried = redRows(PLAN, 'policy', steps());
  carried.tasks.push(F1('assigned'));
  assert.deepStrictEqual(ids(carried), [], 'a policy merge with its fix open: W2 waits');
  const noStep = redRows(PLAN, 'policy', []);
  assert.deepStrictEqual(ids(noStep), [], 'the fix is about to be due: W2 waits');
  const cancelled = redRows(PLAN, 'policy', steps()); cancelled.tasks.push(F1('cancelled'));
  assert.deepStrictEqual(ids(cancelled), ['W2'], 'the fix was cancelled: nothing carries the red, the other merge goes on');
  assert.deepStrictEqual(ids(redRows(PLAN, 'orchestrator')), ['W2'], 'the orchestrator\'s own merge: no fix step is due, so no hold');
  assert.deepStrictEqual(ids(redRows({ ...PLAN, fix: undefined }, 'policy')), ['W2'], 'a plan with no fix step: the E8 wakes as before, and the other merges go on');
  const spent = redRows(PLAN, 'policy', []); spent.rounds = { caps: { max: 0, hard: null } };
  assert.deepStrictEqual(ids(spent), [], 'at the cap E2 is raised and the branch stays held for the orchestrator');
});

test('C2: after the bound a waiting failure still does not start a second re-run, and the idle close holds for it while it waits', () => {
  const A = T('A', { seq: 10, state: 'released', policy: PLAN, policy_rev: 1, handoff: { by: 'b1', at: 10 }, results: failBeside });
  const going = [{ seq: 3, run_id: 'r1', task_id: 'Z', step: 'rerun_alone', trigger_table: 'task', trigger_id: 'Z', trigger_seq: 1, outcome: 'started', at: 25 }];
  assert.deepStrictEqual(due(beside({ tasks: [A], steps: going, now: 20 + 999999 })), [], 'a re-run is in flight: wait, past the bound too');
  const pending = T('B', { seq: 11, state: 'released', policy: PLAN, policy_rev: 1, handoff: { by: 'b2', at: 12 } });
  const rf = RF.ctxOf({ runId: 'r1', now: 30, tasks: [A, pending], steps: [], failures: [], caps: { max: 2, hard: null }, integrations: [] });
  assert.deepStrictEqual(RF.waitingIds(rf, () => PLAN), ['A']);
  const { createPolicyCloseHold } = require('../../src/run/policy-close-hold.cjs');
  const h = createPolicyCloseHold({ now: () => 0, alive: () => true });
  assert.ok(h.holds({ runId: 'r1', tasks: [A, pending], integrations: [], steps: [], failures: [], now: 30, rounds: { caps: { max: 2, hard: null } } }).includes('policy-wait:A'));
});

test('C3: an E8 lifts only on a merge-side step, and only by a merge that put the work on the branch (not by the cumulative task_ids)', () => {
  const PW = require('../../src/run/policy-wakes.cjs');
  const X = T('X', { seq: 5, state: 'done', policy: PLAN, policy_rev: 1, handoff: { by: 'bx', at: 1 }, results: { trigger: 'release', evaluated_at: 2, executable: true, passed: true, checks: [] } });
  const e8 = (step) => ({ seq: 9, run_id: 'r1', task_id: 'X', step, trigger_table: 'task', trigger_id: 'X', trigger_seq: 5, outcome: 'exception', error: 'E_X: it failed', at: 40, finished_at: 41 });
  const merge = (merged) => ({ id: 'I2', run_id: 'r1', seq: 60, written_at: 100, state: 'evaluated', passed: true, task_ids: ['X'], merged });
  const lifted = (step, merged) => PW.derive({ runId: 'r1', tasks: [X], integrations: [merge(merged)], steps: [e8(step)], failures: [] }).filter((x) => x.exception === 'E8').map((x) => !!x.lifted);
  assert.deepStrictEqual(lifted('integrate', [{ task_id: 'X', already: false }]), [true], 'merged by that call');
  assert.deepStrictEqual(lifted('integrate', [{ task_id: 'X', already: true }]), [false], 'only carried: it says nothing about X');
  assert.deepStrictEqual(lifted('review', [{ task_id: 'X', already: false }]), [false], 'a review that failed is not lifted by a merge');
});

test('the plan is what carries it: a plan with no fix step still wakes E5, and the integrate step still ends an exception on failed checks', async () => {
  const e = await M.env({ label: 'round-nofix' });
  try {
    const { task } = await M.workDone(e, 'x', { acceptance: M.FAIL, plan: M.without(M.PLAN, 'fix') });
    const w = M.expectOne(await e.poll(), { exception: 'E5', field: 'none', task_id: task.id, trigger: await M.tref(e, task.id), key: `${task.id}@${await M.evaluatedAt(e, task.id)}` });
    assert.match(w.text, /evaluation failed/);
    assert.deepStrictEqual(await e.tick().then(names), []);
  } finally { await e.close(); }
});

test('policy-rounds: the round count is the fix tasks plus the round steps, on the work a chain began from', () => {
  const W = T('W', { state: 'released', policy: PLAN, policy_rev: 1, handoff: { by: 'b1', at: 10 }, results: { trigger: 'release', evaluated_at: 20, executable: true, passed: false, checks: [{ kind: 'command', argv: ['x'], passed: false, exit_code: 1 }] } });
  const F = T('F', { repairs: 'W', state: 'done' });
  const step = (s, n) => ({ seq: n, run_id: 'r1', task_id: 'W', step: s, outcome: 'done', at: 5 });
  const rf = RF.ctxOf({ runId: 'r1', tasks: [W, F], steps: [step('fix_eval', 1), step('rerun_alone', 2), step('reask', 3)], failures: [], caps: { max: 3, hard: null }, integrations: [] });
  assert.strictEqual(RF.used(rf, 'W'), 2, 'one fix task and one fix_eval; a re-run and a re-ask spend nothing');
  assert.strictEqual(RF.left(rf, 'W'), true);
  assert.strictEqual(RF.left({ ...rf, caps: { max: 2, hard: null } }, 'W'), false);
  assert.strictEqual(RF.left({ ...rf, caps: { max: null, hard: 2 } }, 'W'), false, 'the hard cap too');
});
