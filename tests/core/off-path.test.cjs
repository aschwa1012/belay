'use strict';
// off-path.test.cjs — work that drifts off the straight path (ADR 0061): an amend revises a task's acceptance as a new row of the
// same task; tree_of gives a conflict fix the conflicting task's tree and its own base, so it is judged there and integrate
// merges it, covering the work; a hand-back whose head is not the judged head is flagged handoff_stale; each command check names
// the evaluations that ran beside it. Real core, a sandbox store and a throwaway repository; a slow evaluation waits on a file
// the test writes, never on a clock.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { makeRepo, git, write, commit, rejectsCode } = require('./worktree-helpers.cjs');

const { openCore } = core('index.cjs');
const fwd = (p) => p.split('\\').join('/');
const PASS = { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] };
const FAIL = { commands: [{ argv: [process.execPath, '-e', 'process.exit(3)'], timeout_ms: 20000 }] };

let dir, repo, orch, n = 0;
const workers = new Map();

before(async () => {
  dir = sandbox();
  repo = makeRepo(dir);
  orch = await openCore({ dataDir: `${dir}/data`, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid, project_dir: repo, fix_hard_cap: 1 });
});

after(async () => {
  for (const c of workers.values()) await c.close();
  try { await orch.shutdownOwner(); } finally { await orch.close(); cleanup(dir); }
});

async function worker(id, worktree) {
  if (workers.has(id)) return workers.get(id);
  await orch.worker.write({ id, substrate: 'claude-code', pid: process.pid, state: 'idle', session_id: `s-${id}`, last_event_at: Date.now(), worktree });
  const c = await openCore({ dataDir: `${dir}/data`, caller: callerFor('worker', { worker_id: id }), embed: false });
  workers.set(id, c);
  return c;
}

async function handBack(taskId, workerId, worktree, result = { branch: 'b' }) {
  const w = await worker(workerId, worktree);
  const a = await orch.task.assign({ task_id: taskId, worker_id: workerId });
  return w.lease.release({ lease_id: a.new_lease.id, reason: 'done', result });
}

// A command that writes `started` and then waits until the test writes `gate`.
function gated(name) {
  const started = fwd(path.join(dir, `${name}-started`)), gate = fwd(path.join(dir, `${name}-gate`));
  const argv = [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(started)}, ''); const t = setInterval(() => { if (require('fs').existsSync(${JSON.stringify(gate)})) clearInterval(t); }, 20);`];
  return {
    command: { argv, timeout_ms: 60000 },
    async whenStarted() { while (!fs.existsSync(started)) await new Promise((r) => setImmediate(r)); },
    open() { fs.writeFileSync(gate, ''); },
  };
}

// ---- section 1: amend ----------------------------------------------------------------------------------------------------

test('amend: a not-done task keeps its id and dependents; the old acceptance is kept and the old results are marked stale', async () => {
  const t = await orch.task.create({ id: 'flaky-suite', spec: 'the work', acceptance: FAIL });
  const dep = await orch.task.create({ spec: 'waits on it', depends_on: [t.id], acceptance: PASS });
  await handBack(t.id, `a-${++n}`, dir);
  const failed = await orch.task.evaluate({ task_id: t.id, worktree: dir });
  assert.strictEqual(failed.state, 'released');
  const again = await rejectsCode(orch.task.create({ id: t.id, spec: 'the work', acceptance: PASS }), 'E_ARGS');
  assert.match(again.message, /pass amend: true to revise its acceptance/);

  const a = await orch.task.create({ id: t.id, amend: true, acceptance: PASS });
  assert.deepStrictEqual([a.id, a.state, a.spec, a.acceptance], [t.id, 'released', 'the work', PASS], 'the same task, its spec and state kept');
  assert.ok(a.seq > failed.seq, 'a new row');
  assert.strictEqual(a.amended.length, 1);
  assert.deepStrictEqual(a.amended[0].acceptance, FAIL, 'the acceptance it replaced is on the row');
  assert.ok(a.amended[0].at && a.amended[0].by && !('spec' in a.amended[0]), 'when and by whom; the spec did not change');
  assert.deepStrictEqual([a.results.stale, a.results.passed], ['acceptance amended', false], 'the old results stay, marked stale');
  assert.deepStrictEqual(a.handoff, failed.handoff, 'the hand-back is untouched');

  const b = await orch.task.create({ id: t.id, amend: true, acceptance: PASS, spec: 'the work, revised' });
  assert.deepStrictEqual([b.spec, b.amended.length, b.amended[1].spec], ['the work, revised', 2, 'the work']);

  const done = await orch.task.evaluate({ task_id: t.id, worktree: dir });
  assert.strictEqual(done.state, 'done', 'judged on the amended acceptance');
  assert.strictEqual(done.results.stale, undefined, 'fresh results are not stale');
  assert.strictEqual((await orch.task.assign({ task_id: dep.id, check_only: true })).assignable, true, 'the dependent names the same id and is free');
  await rejectsCode(orch.task.create({ id: t.id, amend: true, acceptance: FAIL }), 'E_TASK_DONE');
});

test('amend: refused with nothing written on a cancelled task, under a held lease, beside another field, or with no acceptance', async () => {
  const before = (await orch.task.list({})).tasks.length;
  const c = await orch.task.create({ spec: 'to cancel', acceptance: PASS });
  await orch.task.cancel({ task_id: c.id });
  await rejectsCode(orch.task.create({ id: c.id, amend: true, acceptance: FAIL }), 'E_ARGS');

  const h = await orch.task.create({ spec: 'held', acceptance: PASS });
  await worker('holder', dir);
  const lease = (await orch.task.assign({ task_id: h.id, worker_id: 'holder' })).new_lease;
  const held = await rejectsCode(orch.task.create({ id: h.id, amend: true, acceptance: FAIL }), 'E_PRECONDITION');
  assert.deepStrictEqual([held.detail.lease_id, held.detail.holder], [lease.id, 'holder']);

  const e = await rejectsCode(orch.task.create({ id: h.id, amend: true, acceptance: FAIL, files_owned: ['x'], depends_on: [c.id] }), 'E_ARGS');
  assert.deepStrictEqual(e.detail.fields, ['files_owned', 'depends_on']);
  await rejectsCode(orch.task.create({ id: h.id, amend: true }), 'E_ARGS');
  await rejectsCode(orch.task.create({ id: h.id, amend: 'yes', acceptance: PASS }), 'E_ARGS');
  await rejectsCode(orch.task.create({ amend: true, acceptance: PASS }), 'E_ARGS');
  await rejectsCode(orch.task.create({ id: 'no-such-task', amend: true, acceptance: PASS }), 'E_NOT_FOUND');
  await rejectsCode(orch.task.create({ id: h.id, amend: true, acceptance: { verdict: false } }), 'E_ARGS');
  const rows = (await orch.task.list({})).tasks;
  assert.strictEqual(rows.length, before + 2);
  assert.deepStrictEqual((await orch.task.get({ task_id: h.id })).acceptance, PASS, 'the held task is unchanged');
  assert.strictEqual((await orch.task.get({ task_id: h.id })).amended, null);
});

test('amend: refused E_BUSY while an evaluation of the task runs; the evaluation writes what it judged', async () => {
  const g = gated('amend-busy');
  const t = await orch.task.create({ spec: 'slow', acceptance: { commands: [g.command] } });
  await handBack(t.id, `a-${++n}`, dir);
  const running = orch.task.evaluate({ task_id: t.id, worktree: dir });
  await g.whenStarted();
  const e = await rejectsCode(orch.task.create({ id: t.id, amend: true, acceptance: FAIL }), 'E_BUSY');
  assert.deepStrictEqual([e.detail.op, e.detail.running.worktree.toLowerCase()], ['evaluate', fwd(dir).toLowerCase()]);
  g.open();
  const r = await running;
  assert.deepStrictEqual([r.state, r.amended], ['done', null]);
});

// ---- section 2: tree_of ----------------------------------------------------------------------------------------------------

const sh = (cwd, ...args) => spawnSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' });

test('tree_of: a conflict fix is worked in the work\'s tree from its own base, spends no fix round, and integrate covers the work', async () => {
  let w = await orch.task.create({ spec: 'add c', acceptance: { files_within_owned: true }, files_owned: ['src/c.cjs', 'src/w-only.cjs'] });
  w = await orch.task.worktreeCreate({ task_id: w.id });
  const tree = w.worktree.path;
  write(tree, 'src/c.cjs', 'ours\n'); write(tree, 'src/w-only.cjs', 'w\n');
  commit(tree, 'add c');
  await handBack(w.id, 'c-off', tree, { branch: w.worktree.branch });
  assert.strictEqual((await orch.task.evaluate({ task_id: w.id })).state, 'done');
  // Another task lands on main first, touching the same file: integrating the work conflicts.
  write(repo, 'src/c.cjs', 'theirs\n'); write(repo, 'src/other.cjs', 'other task\n');
  commit(repo, 'another task lands');
  const into = git(repo, 'rev-parse', 'HEAD');
  const conflicted = await orch.integration.merge({ task_ids: [w.id], into: 'int/off', base: into });
  assert.ok(JSON.stringify(conflicted).includes('conflict'), JSON.stringify(conflicted));

  await rejectsCode(orch.task.create({ spec: 'x', tree_of: 'no-such-task' }), 'E_NOT_FOUND');
  const plain = await orch.task.create({ spec: 'no tree', acceptance: PASS });
  await rejectsCode(orch.task.create({ spec: 'x', tree_of: plain.id }), 'E_PRECONDITION');
  const f = await orch.task.create({ spec: 'resolve the conflict', tree_of: w.id, base: into, acceptance: { files_within_owned: true }, files_owned: w.files_owned });
  assert.deepStrictEqual([f.worktree.path, f.worktree.branch, f.worktree.base_sha, f.worktree.inherited_from, f.base, f.repairs], [tree, w.worktree.branch, w.worktree.base_sha, w.id, into, null]);

  // The coder idle in that tree merges the integration branch's base and resolves the conflict.
  assert.strictEqual(sh(tree, 'merge', '--no-edit', into).status !== 0, true, 'the merge conflicts');
  write(tree, 'src/c.cjs', 'ours and theirs\n');
  git(tree, 'add', '-A'); git(tree, 'commit', '-q', '--no-edit');
  await rejectsCode(handBack(f.id, `elsewhere-${++n}`, dir), null); // a worker in another tree cannot take it
  await handBack(f.id, 'c-off', tree, { branch: w.worktree.branch, head: git(tree, 'rev-parse', '--short', 'HEAD') });
  const judged = await orch.task.evaluate({ task_id: f.id });
  const files = judged.results.checks.find((c) => c.kind === 'files_within_owned');
  assert.strictEqual(judged.state, 'done', JSON.stringify(judged.results.checks));
  assert.deepStrictEqual([files.detail.base_source, judged.handoff_stale], ['task', undefined], 'judged from its own base; the hand-back head is current');

  // Without that base the recorded tree base would count the other task's file (try-2 gap 3, the coupling of section 2).
  const g = await orch.task.create({ spec: 'same, no base', tree_of: w.id, acceptance: { files_within_owned: true }, files_owned: w.files_owned });
  await handBack(g.id, 'c-off', tree);
  const noBase = await orch.task.evaluate({ task_id: g.id });
  assert.strictEqual(noBase.state, 'released');
  assert.ok(noBase.results.checks[0].detail.outside.includes('src/other.cjs'), JSON.stringify(noBase.results.checks[0].detail));
  await orch.task.cancel({ task_id: g.id });

  const landed = await orch.integration.merge({ task_ids: [f.id], into: 'int/off' });
  const m = landed.merged.find((x) => x.task_id === f.id);
  assert.ok(m && m.covers.includes(w.id) && m.covers.includes(f.id), JSON.stringify(landed.merged));
  // fix_hard_cap is 1 and no fix round was spent: a review fix of the work can still be made.
  assert.strictEqual((await orch.task.create({ spec: 'a review fix', repairs: w.id, acceptance: PASS })).repairs, w.id);
});

// ---- section 3: handoff_stale -------------------------------------------------------------------------------------------------

test('handoff_stale: set when the hand-back\'s head is not the judged head, absent when it is or names no head', async () => {
  let t = await orch.task.create({ spec: 'stale', acceptance: { files_within_owned: true }, files_owned: ['src/stale.cjs'] });
  t = await orch.task.worktreeCreate({ task_id: t.id });
  const tree = t.worktree.path;
  write(tree, 'src/stale.cjs', '1\n'); commit(tree, 'one');
  const first = git(tree, 'rev-parse', '--short', 'HEAD');
  await handBack(t.id, 'c-stale', tree, { head: first });
  write(tree, 'src/stale.cjs', '2\n'); commit(tree, 'two, after a follow-up message');
  const r = await orch.task.evaluate({ task_id: t.id });
  assert.strictEqual(r.state, 'done');
  const view = await orch.task.get({ task_id: t.id });
  assert.strictEqual(view.handoff_stale, true, `hand-back ${first}, judged ${view.results.head_sha}`);
  assert.strictEqual((await orch.task.list({})).tasks.find((x) => x.id === t.id).handoff_stale, true);

  const D = require('../../src/core/task-derived.cjs');
  const head = view.results.head_sha;
  assert.strictEqual(D.handoffStale({ ...view, handoff: { result: { head: head.slice(0, 7) } } }), false, 'an abbreviation of the judged head');
  assert.strictEqual(D.handoffStale({ ...view, handoff: { result: { branch: 'b' } } }), false, 'no head named');
  assert.strictEqual(D.handoffStale({ ...view, handoff: { result: { head: 'HEAD' } } }), false, 'not a sha');
  assert.strictEqual(D.handoffStale({ ...view, results: null }), false, 'not judged');
});

// ---- section 4: concurrent --------------------------------------------------------------------------------------------------

test('concurrent: each command check names the evaluations that ran beside it; one alone names none', async () => {
  const ga = gated('conc-a'), gb = gated('conc-b');
  const a = await orch.task.create({ spec: 'a', acceptance: { commands: [ga.command] } });
  const b = await orch.task.create({ spec: 'b', acceptance: { commands: [gb.command] } });
  const ea = orch.task.evaluate({ task_id: a.id, worktree: dir });
  await ga.whenStarted();
  const eb = orch.task.evaluate({ task_id: b.id, worktree: dir });
  await gb.whenStarted();
  gb.open();
  const rb = await eb;
  ga.open();
  const ra = await ea;
  const [ca, cb] = [ra.results.checks[0].concurrent, rb.results.checks[0].concurrent];
  assert.deepStrictEqual(cb.map((x) => x.task_id), [a.id]);
  assert.deepStrictEqual(ca.map((x) => x.task_id), [b.id]);
  assert.ok(ca[0].overlap_ms >= 0 && cb[0].overlap_ms > 0 && ca[0].overlap_ms <= ra.results.checks[0].ms + 50);
  const alone = await orch.task.evaluate({ task_id: (await orch.task.create({ spec: 'alone', acceptance: PASS })).id, worktree: dir });
  assert.strictEqual(alone.results.checks[0].concurrent, undefined);
  const V = require('../../src/mcp/views.cjs');
  const failing = V.compactTask({ ...ra, results: { ...ra.results, passed: false, checks: [{ ...ra.results.checks[0], passed: false, exit_code: 1 }] } }).results.failing;
  assert.deepStrictEqual(failing, ['command ' + ra.results.checks[0].argv.slice(0, 3).join(' ') + ' exit 1 (ran beside 1 other evaluation)'], 'a listing says a failing check ran beside another');
  // A listing counts the revisions of an amended task and keeps the stale mark of its results.
  const listed = V.compactTask({ ...ra, amended: [{}, {}], results: { ...ra.results, stale: 'acceptance amended' } });
  assert.deepStrictEqual([listed.amended, listed.results.stale], [2, 'acceptance amended']);
});

test('concurrent: a span is kept while an evaluation that overlapped it runs, then pruned', async () => {
  const EC = require('../../src/core/evaluate-cancel.cjs');
  const rows = require('../../src/core/rows.cjs'), W = require('../../src/core/methods-worktree.cjs');
  const realCurrent = rows.current, realTarget = W.evaluateTarget;
  rows.current = (store, kind, id) => ({ id });
  W.evaluateTarget = (task) => ({ worktree: `C:/w/${task.id}`, base: null });
  try {
    const held = [];
    const mk = () => () => new Promise((res) => held.push(res));
    const p = EC.joinOrRun({}, { task_id: 'span-p' }, mk());
    const t0 = Date.now();
    const q = EC.joinOrRun({}, { task_id: 'span-q' }, mk());
    while (Date.now() < t0 + 3) await new Promise((r) => setImmediate(r)); // q runs for a measurable span
    held[1]({ id: 'span-q' }); await q; // q ended while p runs: kept, p's commands overlapped it
    assert.ok(EC.SPANS.some((s) => s.task_id === 'span-q' && s.end != null), 'the ended span is kept');
    assert.deepStrictEqual(EC.during('span-p', t0 - 1000, Date.now() + 1).map((x) => x.task_id), ['span-q']);
    assert.deepStrictEqual(EC.during('span-q', t0 - 1000, Date.now() + 1).map((x) => x.task_id), ['span-p']);
    held[0]({ id: 'span-p' }); await p;
    assert.strictEqual(EC.SPANS.filter((s) => s.task_id.startsWith('span-')).length, 0, 'none runs, so none is kept');
  } finally { rows.current = realCurrent; W.evaluateTarget = realTarget; }
});
