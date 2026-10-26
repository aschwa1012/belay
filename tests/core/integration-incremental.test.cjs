'use strict';
// integration-incremental.test.cjs — an integration into a branch that already holds tasks keeps them without re-listing, and a
// check that already passed at exactly this head is not run again (ADR 0053 amendment 2, ADR 0061). Real git in throwaway
// repositories under the sandbox. A check that counts its own runs shows what really ran.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { makeRepo, write, commit, rejectsCode } = require('./worktree-helpers.cjs');

const { openCore } = core('index.cjs');

let dir, orch, op, n = 0;

before(async () => {
  dir = sandbox();
  orch = await openCore({ dataDir: `${dir}/data`, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
  op = await openCore({ dataDir: `${dir}/data`, caller: { role: 'operator', run_id: 'cli', pid: process.pid }, embed: false });
});

after(async () => {
  await op.close();
  await orch.shutdownOwner();
  await orch.close();
  cleanup(dir);
});

// A check that passes when `rel` exists (or, with `absent`, when it does not) and appends one line to `counter` each time it runs.
const check = (counter, rel, absent = false) => ({
  argv: [process.execPath, '-e', `require('fs').appendFileSync(${JSON.stringify(counter)}, 'x\\n'); const e = require('fs').existsSync(${JSON.stringify(rel)}); process.exit(e === ${!absent} ? 0 : 1)`],
});
const reset = (counter) => fs.rmSync(counter, { force: true }); // task.evaluate ran the checks once already
const runs = (counter) => (fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').split('\n').filter(Boolean).length : 0);

async function work(repo, files, commands, { evaluate = true } = {}) {
  const t = await orch.task.create({ spec: `write ${Object.keys(files).join(', ')}`, acceptance: { commands } });
  const w = (await op.task.worktreeCreate({ task_id: t.id, repo })).worktree;
  for (const [rel, text] of Object.entries(files)) write(w.path, rel, text);
  commit(w.path, `task ${t.id}`);
  return evaluate ? orch.task.evaluate({ task_id: t.id }) : orch.task.get({ task_id: t.id });
}
const into = () => `int/inc-${++n}`;
const counterFile = () => path.join(dir, `counter-${++n}.txt`);

test('T2 then T1 into one branch keeps T2 without re-listing it, and names every task on the branch', async () => {
  const repo = makeRepo(dir), c = counterFile(), br = into();
  const t2 = await work(repo, { 'two.txt': '2\n' }, [check(c, 'two.txt')]);
  const t1 = await work(repo, { 'one.txt': '1\n' }, [check(c, 'one.txt')]);
  reset(c);
  const r1 = await orch.integration.merge({ task_ids: [t2.id], into: br });
  assert.strictEqual(r1.state, 'evaluated');
  assert.strictEqual(runs(c), 1);
  const r2 = await orch.integration.merge({ task_ids: [t1.id], into: br });
  assert.strictEqual(r2.state, 'evaluated');
  assert.strictEqual(r2.worktree, r1.worktree);
  assert.deepStrictEqual(r2.task_ids, [t2.id, t1.id], 'the row names every task on the branch');
  assert.deepStrictEqual(r2.merged.map((m) => m.task_id), [t2.id, t1.id]);
  const [m2, m1] = r2.merged;
  assert.strictEqual(m2.carried_from, r1.id);
  assert.strictEqual(m2.by_this_call, false);
  assert.strictEqual(m1.by_this_call, true);
  assert.strictEqual(m1.already, false);
  assert.ok(fs.existsSync(path.join(r2.worktree, 'two.txt')) && fs.existsSync(path.join(r2.worktree, 'one.txt')));
  assert.deepStrictEqual(r2.not_merged, []);
  assert.strictEqual(r2.passed, true);
  assert.notStrictEqual(r2.head_sha, r1.head_sha);
  assert.strictEqual(runs(c), 3, 'the head moved, so both tasks\' checks ran again on it');
  const tasks = (await orch.task.list({})).tasks;
  for (const t of [t1, t2]) {
    const i = tasks.find((x) => x.id === t.id).integration;
    assert.strictEqual(i.state, 'merged');
    assert.strictEqual(i.id, r2.id);
    assert.strictEqual(i.head, r2.head_sha);
  }
});

test('an unchanged head reuses the checks that passed at it, recorded as a plain fact; a moved head runs them again', async () => {
  const repo = makeRepo(dir), c = counterFile(), br = into();
  const a = await work(repo, { 'a.txt': 'a\n' }, [check(c, 'a.txt')]);
  const b = await work(repo, { 'b.txt': 'b\n' }, [check(c, 'b.txt')]);
  reset(c);
  const r1 = await orch.integration.merge({ task_ids: [a.id, b.id], into: br });
  assert.strictEqual(r1.passed, true);
  assert.strictEqual(runs(c), 2);
  assert.strictEqual(r1.reused_checks, undefined);

  const r2 = await orch.integration.merge({ task_ids: [b.id], into: br });
  assert.strictEqual(r2.head_sha, r1.head_sha, 'nothing new was merged');
  assert.strictEqual(runs(c), 2, 'no check ran again');
  assert.strictEqual(r2.passed, true);
  assert.strictEqual(r2.checks.length, 2);
  for (const k of r2.checks) {
    assert.strictEqual(k.reused_from, r1.id);
    assert.strictEqual(k.head_sha, r1.head_sha);
    assert.strictEqual(k.passed, true);
    assert.strictEqual(k.exit_code, undefined, 'a reuse records no run it did not make');
  }
  assert.deepStrictEqual(r2.reused_checks.map((x) => x.reused_from), [r1.id, r1.id]);
  const r3 = await orch.integration.merge({ task_ids: [a.id, b.id], into: br, evaluate: true });
  assert.deepStrictEqual(r3.checks.map((k) => k.reused_from), [r1.id, r1.id], 'a reuse is traced to the row that ran the check');
  assert.strictEqual(runs(c), 2);

  const d = await work(repo, { 'd.txt': 'd\n' }, [check(c, 'd.txt')]);
  const r4 = await orch.integration.merge({ task_ids: [d.id], into: br });
  assert.notStrictEqual(r4.head_sha, r1.head_sha);
  assert.strictEqual(runs(c), 6, 'two before, one for the new task evaluation, and all three again at the moved head');
  assert.strictEqual(r4.reused_checks, undefined);
});

test('a check that failed at a head is run again at that head, never reused as passed', async () => {
  const repo = makeRepo(dir), c = counterFile(), br = into();
  const a = await work(repo, { 'a.txt': 'a\n' }, [check(c, 'z.txt', true)]); // passes alone: z.txt is not there yet
  const z = await work(repo, { 'z.txt': 'z\n' }, [check(c, 'z.txt')]);
  assert.strictEqual(a.state, 'done');
  reset(c);
  const r1 = await orch.integration.merge({ task_ids: [a.id, z.id], into: br });
  assert.strictEqual(r1.passed, false);
  const before = runs(c);
  const r2 = await orch.integration.merge({ task_ids: [a.id, z.id], into: br });
  assert.strictEqual(r2.head_sha, r1.head_sha);
  assert.strictEqual(r2.passed, false);
  assert.strictEqual(runs(c), before + 1, 'only the failing check ran again');
  const failed = r2.checks.filter((k) => !k.passed);
  assert.strictEqual(failed.length, 1);
  assert.strictEqual(failed[0].reused_from, undefined);
  assert.strictEqual(failed[0].exit_code, 1);
  assert.ok(r2.checks.some((k) => k.reused_from === r1.id && k.passed), 'the one that passed was reused');
});

test('a forced task\'s failure stays on the row after a later append and is not hidden by a reuse', async () => {
  const repo = makeRepo(dir), c = counterFile(), br = into();
  const f = await work(repo, { 'f.txt': 'f\n' }, [check(c, 'later.txt')]);
  const g = await work(repo, { 'g.txt': 'g\n' }, [check(c, 'g.txt')]);
  assert.notStrictEqual(f.state, 'done');
  reset(c);
  const r1 = await orch.integration.merge({ task_ids: [f.id], into: br, force: true, reason: 'later.txt comes with another task' });
  assert.deepStrictEqual(r1.forced.task_ids, [f.id]);
  const r2 = await orch.integration.merge({ task_ids: [g.id], into: br });
  assert.strictEqual(r2.passed, false);
  assert.deepStrictEqual(r2.task_ids, [f.id, g.id]);
  assert.deepStrictEqual(r2.forced.task_ids, [f.id], 'the forced task is still named, with no force passed this time');
  assert.strictEqual(r2.forced.reason, 'later.txt comes with another task');
  assert.strictEqual(r2.forced.failing.length, 1);
  assert.deepStrictEqual(r2.forced.failing, r1.forced.failing);
  const r3 = await orch.integration.merge({ task_ids: [g.id], into: br });
  assert.strictEqual(r3.head_sha, r2.head_sha);
  assert.strictEqual(r3.passed, false);
  assert.strictEqual(r3.forced.failing.length, 1);
  assert.ok(r3.checks.some((k) => k.reused_from === r2.id && k.passed), 'the passing check was reused');
  assert.ok(r3.checks.some((k) => !k.passed && k.exit_code === 1), 'the forced task\'s failing check ran again');
  const fi = (await orch.task.list({})).tasks.find((t) => t.id === f.id).integration;
  assert.strictEqual(fi.forced, 'later.txt comes with another task');
});

test('naming a task that is not done without force is still refused, whatever the branch holds', async () => {
  const repo = makeRepo(dir), c = counterFile(), br = into();
  const f = await work(repo, { 'f.txt': 'f\n' }, [check(c, 'later.txt')]);
  const g = await work(repo, { 'g.txt': 'g\n' }, [check(c, 'g.txt')]);
  await orch.integration.merge({ task_ids: [f.id], into: br, force: true, reason: 'expected' });
  await rejectsCode(orch.integration.merge({ task_ids: [g.id, f.id], into: br }), 'E_PRECONDITION');
});

test('a conflict in an append keeps the tasks already on the branch and checks them without a second run', async () => {
  const repo = makeRepo(dir), c = counterFile(), br = into();
  const a = await work(repo, { 'same.txt': 'one\n' }, [check(c, 'same.txt')]);
  const b = await work(repo, { 'same.txt': 'two\n' }, [check(c, 'same.txt')]);
  reset(c);
  const r1 = await orch.integration.merge({ task_ids: [a.id], into: br });
  const r2 = await orch.integration.merge({ task_ids: [b.id], into: br });
  assert.strictEqual(r2.state, 'conflict');
  assert.strictEqual(r2.head_sha, r1.head_sha);
  assert.deepStrictEqual(r2.merged.map((m) => m.task_id), [a.id]);
  assert.deepStrictEqual(r2.not_merged.map((m) => [m.task_id, m.reason]), [[b.id, 'conflict']]);
  assert.strictEqual(runs(c), 1, 'the head did not move, so the passed check was reused');
  assert.strictEqual(r2.reused_checks.length, 1);
});

test('two integrates into one branch at once: one is refused, and the retry appends to what the other left', async () => {
  const repo = makeRepo(dir), c = counterFile(), br = into();
  const a = await work(repo, { 'a.txt': 'a\n' }, [check(c, 'a.txt')]);
  const b = await work(repo, { 'b.txt': 'b\n' }, [check(c, 'b.txt')]);
  const settled = await Promise.allSettled([orch.integration.merge({ task_ids: [a.id], into: br }), orch.integration.merge({ task_ids: [b.id], into: br })]);
  assert.ok(settled.filter((s) => s.status === 'rejected').every((s) => s.reason.code === 'E_BUSY'));
  const done = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
  assert.ok(done.length >= 1);
  const left = [a, b].filter((t) => !done.some((r) => r.merged.some((m) => m.task_id === t.id)));
  let last = done[done.length - 1];
  for (const t of left) last = await orch.integration.merge({ task_ids: [t.id], into: br });
  assert.deepStrictEqual([...last.task_ids].sort(), [a.id, b.id].sort());
  assert.ok(fs.existsSync(path.join(last.worktree, 'a.txt')) && fs.existsSync(path.join(last.worktree, 'b.txt')));
  assert.strictEqual(last.passed, true);
});
