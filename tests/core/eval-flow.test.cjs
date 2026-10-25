'use strict';
// eval-flow.test.cjs — the try-2 evaluation gaps: one evaluation of a task at a time (a second with other arguments is refused
// E_BUSY naming the running one, the same arguments join it; gap 4), a task's own diff base used when task.evaluate names none
// (gap 3), and the failing-test section kept in a check's stdout tail, in task.evaluate and integration.merge alike (gap 10). Real
// core, a sandbox store and a throwaway repository; the slow evaluation waits on a file the test writes, never on a clock.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { makeRepo, git, write, commit, rejectsCode } = require('./worktree-helpers.cjs');
const RE = require('../../src/run/release-eval.cjs');

const { openCore } = core('index.cjs');
const fwd = (p) => p.split('\\').join('/');

let dir, repo, orch, n = 0;
const workers = [];

before(async () => {
  dir = sandbox();
  repo = makeRepo(dir);
  orch = await openCore({ dataDir: `${dir}/data`, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid, project_dir: repo });
});

after(async () => {
  for (const c of workers) await c.close();
  try { await orch.shutdownOwner(); } finally { await orch.close(); cleanup(dir); }
});

async function handBack(taskId, worktree) {
  const id = `w-${++n}`;
  await orch.worker.write({ id, substrate: 'claude-code', pid: process.pid, state: 'idle', session_id: `s-${id}`, last_event_at: Date.now(), worktree });
  const w = await openCore({ dataDir: `${dir}/data`, caller: callerFor('worker', { worker_id: id }), embed: false });
  workers.push(w);
  const a = await orch.task.assign({ task_id: taskId, worker_id: id });
  await w.lease.release({ lease_id: a.new_lease.id, reason: 'done', result: { branch: 'b' } });
}

test('gap 4: while a release evaluation runs, one with another base is refused naming it, the same one joins, and the result is the one row', async () => {
  const gate = fwd(path.join(dir, 'gate-open'));
  const started = fwd(path.join(dir, 'gate-started'));
  const wait = { argv: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(started)}, ''); const t = setInterval(() => { if (require('fs').existsSync(${JSON.stringify(gate)})) { clearInterval(t); } }, 20);`], timeout_ms: 60000 };
  const t = await orch.task.create({ spec: 'no tree', acceptance: { commands: [wait] } }); // no worktree on the row
  await handBack(t.id, dir);
  const release = orch.task.evaluate({ task_id: t.id, worktree: dir, trigger: 'release' });
  while (!fs.existsSync(started)) await new Promise((r) => setTimeout(r, 20)); // the command has started: the evaluation is in flight
  const e = await rejectsCode(orch.task.evaluate({ task_id: t.id, worktree: dir, base: 'HEAD' }), 'E_BUSY');
  assert.deepStrictEqual([e.detail.running.trigger, e.detail.running.base, e.detail.running.worktree.toLowerCase()], ['release', null, fwd(dir).toLowerCase()]);
  assert.match(e.message, /being evaluated already \(at release, in .*\); its result comes as a wake and in task_list/);
  const joined = orch.task.evaluate({ task_id: t.id, worktree: dir });
  fs.writeFileSync(gate, '');
  const [r, j] = await Promise.all([release, joined]);
  assert.deepStrictEqual([r.state, r.results.trigger, r.results.checks[0].detail.cwd], ['done', 'release', fwd(dir)], 'the holder\'s directory, at once');
  assert.deepStrictEqual([j.joined_evaluation, j.rev], [true, r.rev], 'the same call joined the running one');
  // Once it has landed, the refusal is gone: a done task is refused as done, as before.
  await rejectsCode(orch.task.evaluate({ task_id: t.id, worktree: dir, base: 'HEAD' }), 'E_TASK_DONE');
  assert.match(RE.clause([{ task_id: 'x', error: 'E_BUSY' }], 400), /task x not evaluated at release: another evaluation of it is running/);
});

test('gap 3: a task\'s own base judges files_within_owned when task.evaluate names none; a fix inherits it; a bad base is refused', async () => {
  // Another task's file arrives on the branch first (a merge; here a plain commit), then the task's own change.
  const twoCommits = (tree) => { write(tree, 'src/other.cjs', 'x\n'); commit(tree, 'other task'); write(tree, 'src/mine.cjs', 'y\n'); commit(tree, 'mine'); };
  // Without a base the recorded tree base counts the other file.
  let u = await orch.task.create({ spec: 'no base', acceptance: { files_within_owned: true }, files_owned: ['src/mine.cjs'] });
  u = await orch.task.worktreeCreate({ task_id: u.id });
  twoCommits(u.worktree.path);
  await handBack(u.id, u.worktree.path);
  const without = await orch.task.evaluate({ task_id: u.id, trigger: 'release', worktree: u.worktree.path });
  assert.deepStrictEqual([without.state, without.results.checks[0].detail.outside], ['released', ['src/other.cjs']]);
  // With the base on the row, the release evaluation (no base argument) judges from it.
  let v = await orch.task.create({ spec: 'base on the row', acceptance: { files_within_owned: true }, files_owned: ['src/mine.cjs'], base: 'HEAD~1' });
  v = await orch.task.worktreeCreate({ task_id: v.id });
  twoCommits(v.worktree.path);
  await handBack(v.id, v.worktree.path);
  const rowBase = await orch.task.evaluate({ task_id: v.id, trigger: 'release', worktree: v.worktree.path });
  const c = rowBase.results.checks[0];
  assert.deepStrictEqual([rowBase.state, c.detail.base_source, c.detail.base_ref, c.detail.changed], ['done', 'task', 'HEAD~1', ['src/mine.cjs']]);
  for (const bad of ['', '-x', 7, 'a\u0000b', 'a\nb', 'a\u007fb']) await rejectsCode(orch.task.create({ spec: 'bad base', acceptance: { files_within_owned: true }, base: bad }), 'E_ARGS');
  // A fix of it is judged from the same base.
  const r = await orch.task.create({ spec: 'review', depends_on: [v.id], acceptance: { verdict: true } });
  const id = `j-${++n}`;
  await orch.worker.write({ id, substrate: 'claude-code', pid: process.pid, state: 'idle', session_id: `s-${id}`, last_event_at: Date.now(), worktree: dir });
  const jw = await openCore({ dataDir: `${dir}/data`, caller: callerFor('worker', { worker_id: id }), embed: false });
  workers.push(jw);
  const a = await orch.task.assign({ task_id: r.id, worker_id: id });
  await jw.lease.release({ lease_id: a.new_lease.id, reason: 'done', result: { verdict: 'refuted', summary: 's', findings: [] } });
  await orch.task.evaluate({ task_id: r.id, worktree: dir });
  assert.strictEqual((await orch.task.fixFromReview({ review_id: r.id })).base, 'HEAD~1');
});

test('gap 10: the failing-test section survives a long output, in task.evaluate and in integrate\'s re-run alike', async () => {
  const script = fwd(path.join(dir, 'suite.cjs'));
  // Passes in the task's tree; in the integration tree it prints a long run, the failure section, then a long trace.
  fs.writeFileSync(script, [
    "const inInt = process.cwd().replace(/\\\\/g, '/').includes('integrate-');",
    "if (!inInt && !process.env.FORCE_FAIL) process.exit(0);",
    "for (let i = 0; i < 300; i++) console.log('✔ a passing test number ' + i + ' (1.2ms)');",
    "console.log('ℹ tests 301'); console.log('ℹ fail 1');",
    "console.log('✖ failing tests:'); console.log(''); console.log('test at test/x.test.js:1:1');",
    "console.log('✖ the-broken-test-name (3.1ms)');",
    "for (let i = 0; i < 100; i++) console.log('    at frame ' + i + ' (node:internal/some/long/path.js:1:1)');",
    'process.exit(1);',
  ].join('\n'));
  const cmd = { argv: [process.execPath, script], timeout_ms: 60000 };
  let t = await orch.task.create({ spec: 'suite', acceptance: { commands: [cmd] }, files_owned: ['src/suite.cjs'] });
  t = await orch.task.worktreeCreate({ task_id: t.id });
  write(t.worktree.path, 'src/suite.cjs', 's\n');
  commit(t.worktree.path, 'suite');
  await handBack(t.id, t.worktree.path);
  assert.strictEqual((await orch.task.evaluate({ task_id: t.id })).state, 'done');
  const row = await orch.integration.merge({ task_ids: [t.id], into: 'int/suite' });
  assert.strictEqual(row.checks[0].passed, false);
  assert.match(row.checks[0].stdout_tail, /✖ failing tests:[\s\S]*the-broken-test-name/);
  // The same text through task.evaluate's capture keeps it too.
  const { runCommand, outputTails } = require('../../src/core/evaluate.cjs');
  const r = await runCommand([process.execPath, script], dir, 60000, { keep: 'ends', env: { ...process.env, FORCE_FAIL: '1' } });
  assert.match(outputTails(r).stdout_tail, /^✖ failing tests:[\s\S]*the-broken-test-name/);
  const keep = outputTails({ stdout: 'x'.repeat(2000) + '\n✖ failing tests:\n✖ y' + 'z'.repeat(600) + 'THE-END', stdout_failing: '✖ failing tests:\n✖ y' + 'z'.repeat(500), stderr: '' }).stdout_tail;
  assert.ok(keep.length <= 400 && keep.endsWith('THE-END') && keep.startsWith('✖ failing tests:') && keep.includes('[... end of output ...]'), 'the section and the end of the output both stay within the cap');
  const short = outputTails({ stdout: 'ok\n✖ failing tests:\n✖ x', stdout_failing: '✖ failing tests:\n✖ x', stderr: '' });
  assert.strictEqual(short.stdout_tail, 'ok\n✖ failing tests:\n✖ x', 'a section already in the tail leaves the tail as it was');
});

test('two joiners of a cancelled evaluation run one re-run between them', async () => {
  const EC = require('../../src/core/evaluate-cancel.cjs');
  const rows = require('../../src/core/rows.cjs'), W = require('../../src/core/methods-worktree.cjs');
  const { err } = require('../../src/core/errors.cjs');
  const realCurrent = rows.current, realTarget = W.evaluateTarget;
  rows.current = () => ({ id: 'race-t' });
  W.evaluateTarget = () => ({ worktree: 'C:/w', base: 'abc', baseSource: 'task' });
  try {
    let running = 0, peak = 0;
    const runs = [];
    const mk = () => () => { running++; peak = Math.max(peak, running); return new Promise((res, rej) => runs.push({ res: (v) => { running--; res(v); }, rej: (e) => { running--; rej(e); } })); };
    const first = EC.joinOrRun({}, { task_id: 'race-t', trigger: 'release' }, mk()).catch((e) => e);
    const j1 = EC.joinOrRun({}, { task_id: 'race-t' }, mk());
    const j2 = EC.joinOrRun({}, { task_id: 'race-t' }, mk());
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(runs.length, 1);
    runs[0].rej(err('E_BUSY', 'cancelled', { cancelled: true }));
    await first;
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(runs.length, 2, 'one re-run, not one per joiner');
    assert.strictEqual(peak, 1);
    runs[1].res({ id: 'race-t' });
    const [a, b] = await Promise.all([j1, j2]);
    assert.strictEqual(a.joined_evaluation === true || b.joined_evaluation === true, true);
  } finally { rows.current = realCurrent; W.evaluateTarget = realTarget; }
});
