'use strict';
// task-holds-trees-2.test.cjs — ADR 0059, the cases an independent check raised against the first build: a task is judged by
// its latest lease's holder, released or not, and the operator as the shared tree; trees compare by containment; take-control
// reports what it lets through. Every repository is a throwaway one under the test's sandbox (worktree-helpers.cjs).

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { makeRepo, rejectsCode } = require('./worktree-helpers.cjs');

const { openCore } = core('index.cjs');

let dir, orch, op, repo;

before(async () => {
  dir = sandbox();
  repo = makeRepo(dir);
  orch = await openCore({ dataDir: `${dir}/data`, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid, project_dir: repo });
  op = await openCore({ dataDir: `${dir}/data`, caller: { role: 'operator', run_id: 'cli', pid: process.pid }, embed: false });
});

after(async () => {
  await op.close();
  await orch.shutdownOwner(); // the only way to stop an owner; never a signal
  await orch.close();
  cleanup(dir);
});

let n = 0;
const task = (files, extra = {}) => orch.task.create({ spec: `w2 ${++n}`, files_owned: files, acceptance: { files_within_owned: true }, ...extra });
const own = async (t) => (await orch.task.worktreeCreate({ task_id: t.id })).worktree.path;
const worker = (id, worktree) => orch.worker.write({ id, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: `s-${id}`, worktree });
const ids = (o) => (o || []).map((x) => x.task_id);

test('a task whose latest lease is the operator\'s, even released, is judged as in the shared tree', async () => {
  const a = await task(['b1/a.js']);
  await own(a);
  const b = await task(['b1/a.js']);
  await own(b);
  const took = await op.lease.takeControl({ task_id: a.id });
  await op.lease.release({ lease_id: took.new_lease.id });
  // a's work may now be wherever the operator made it, so a shared-tree task may not take the same file.
  const e = await rejectsCode(task(['b1/a.js']), 'E_FILES_OVERLAP');
  assert.strictEqual(e.detail.other_task_id, a.id);
});

test('a worker in a directory inside another task\'s worktree is in that tree, and so is one whose path differs only in case on Windows', async () => {
  const a = await task(['s1/a.js']);
  const pa = await own(a);
  await worker('s1-wa', pa);
  await orch.task.assign({ task_id: a.id, worker_id: 's1-wa' });
  const b = await task(['s1/a.js']); // shared, beside a's own tree
  assert.deepStrictEqual(ids(b.overlaps), [a.id]);
  await worker('s1-wb', `${pa}/s1`);
  const e = await rejectsCode(orch.task.assign({ task_id: b.id, worker_id: 's1-wb' }), 'E_FILES_OVERLAP');
  assert.strictEqual(e.detail.other_task_id, a.id);
  if (process.platform === 'win32') {
    await worker('s1-wc', pa.toUpperCase());
    await rejectsCode(orch.task.assign({ task_id: b.id, worker_id: 's1-wc' }), 'E_FILES_OVERLAP');
  }
  await worker('s1-wd', repo); // the shared checkout is another tree from a's
  assert.deepStrictEqual(ids((await orch.task.assign({ task_id: b.id, worker_id: 's1-wd' })).overlaps), [a.id]);
});

test('the operator\'s take-control is judged as the shared tree: a shared-tree holder refuses it, one in its own tree is reported', async () => {
  const e = await task(['s2/e.js']);
  await own(e);
  const f = await task(['s2/f.js', 's2/e.js']); // shared, beside e's own tree
  await worker('s2-wf', repo);
  await orch.task.assign({ task_id: f.id, worker_id: 's2-wf' });
  const r = await rejectsCode(op.lease.takeControl({ task_id: e.id }), 'E_FILES_OVERLAP');
  assert.strictEqual(r.detail.other_task_id, f.id);
  const g = await task(['s2/g.js']);
  await own(g);
  const h = await task(['s2/g.js']);
  await own(h);
  assert.deepStrictEqual(ids((await op.lease.takeControl({ task_id: g.id })).overlaps), [h.id]);
});

test('a check_only judges the task in the directory the spawn names', async () => {
  const e = await task(['s4/e.js']);
  const pe = await own(e);
  const f = await task(['s4/e.js']); // shared, beside e's own tree
  const into = await rejectsCode(orch.task.assign({ task_id: f.id, check_only: true, worktree: `${pe}/sub` }), 'E_FILES_OVERLAP');
  assert.strictEqual(into.detail.other_task_id, e.id);
  const ok = await orch.task.assign({ task_id: f.id, check_only: true, worktree: repo });
  assert.deepStrictEqual([ok.assignable, ids(ok.overlaps)], [true, [e.id]]);
  // A task with its own worktree and a spawn elsewhere gets the tree error, not a hold's remedy.
  await rejectsCode(orch.task.assign({ task_id: e.id, check_only: true, worktree: repo }), 'E_PRECONDITION');
});

// Runs other than the orchestrator's, on the same store, for the resume and relaunch paths. Only the run process (role
// operator) opens a new epoch over an ended run.
const reopen = async (runId) => {
  const c = await openCore({ dataDir: `${dir}/data`, caller: { role: 'operator', run_id: runId, pid: process.pid }, embed: false });
  try { return await c.run.attach({ adapter_pid: process.pid, project_dir: repo }); } finally { await c.close(); }
};
const runCore = async (runId) => {
  const c = await openCore({ dataDir: `${dir}/data`, caller: callerFor('orchestrator', { run_id: runId }), embed: false });
  await c.run.attach({ adapter_pid: process.pid, project_dir: repo });
  return c;
};

test('a resumed run\'s task in its own tree reports no overlap with a shared-tree task taken while it was ended', async () => {
  const x = await runCore('m6-x');
  try {
    const a = await x.task.create({ spec: 'm6 a', files_owned: ['m6/a.js'], acceptance: { files_within_owned: true } });
    const pa = (await x.task.worktreeCreate({ task_id: a.id })).worktree.path;
    await x.worker.write({ id: 'm6-wa', substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's-m6-wa', worktree: pa });
    await x.task.assign({ task_id: a.id, worker_id: 'm6-wa' });
    await x.run.end({ exit_reason: 'test' });
    const b = await task(['m6/a.js']); // a holds nothing while its run is ended
    await worker('m6-wb', repo);
    await orch.task.assign({ task_id: b.id, worker_id: 'm6-wb' });
    const back = await reopen('m6-x');
    assert.deepStrictEqual(back.overlaps, [], 'a in its own tree and b in the shared one do not clash');
  } finally { await x.close(); }
});

test('a relaunch that re-homes a task is judged in its worker\'s directory', async () => {
  const p = await runCore('m7-p');
  const q = await runCore('m7-q');
  try {
    const b = await p.task.create({ id: 'm7-b', spec: 'm7 b', files_owned: ['m7/b.js'], acceptance: { files_within_owned: true } });
    const pb = (await p.task.worktreeCreate({ task_id: b.id })).worktree.path;
    await p.run.end({ exit_reason: 'test' }); // b stops holding
    const x = await q.task.create({ spec: 'm7 x', files_owned: ['m7/b.js'], acceptance: { files_within_owned: true } });
    await q.worker.write({ id: 'm7-wx', substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's-m7-wx', worktree: pb });
    await q.task.assign({ task_id: x.id, worker_id: 'm7-wx' }); // x has no worktree; its worker runs in b's
    await q.run.end({ exit_reason: 'test' });
    await reopen('m7-p'); // b holds again
    const e = await rejectsCode(orch.task.ensureHold({ task_id: x.id, worker_id: 'm7-wx' }), 'E_FILES_OVERLAP');
    assert.strictEqual(e.detail.other_task_id, b.id);
  } finally { await p.close(); await q.close(); }
});

// A worker row's directory is read on every check, never cached on the task: a row rewritten to another directory moves the
// task's tree with it (the derived rule, invariant 4), whichever side of the comparison the task is on.
test('a task\'s tree follows its holder\'s row: a holder moved out of the task\'s worktree is shared, one moved inside another tree clashes', async () => {
  const a = await task(['rw/a.js']);
  const pa = await own(a);
  await worker('rw-wa', pa);
  await orch.task.assign({ task_id: a.id, worker_id: 'rw-wa' });
  await worker('rw-wa', repo); // a's holder now runs in the shared checkout
  const e1 = await rejectsCode(task(['rw/a.js']), 'E_FILES_OVERLAP');
  assert.strictEqual(e1.detail.other_task_id, a.id);

  const e = await task(['rw/e.js']);
  const pe = await own(e);
  const f = await task(['rw/e.js']); // shared, beside e's own tree
  await worker('rw-wf', repo);
  await orch.task.assign({ task_id: f.id, worker_id: 'rw-wf' });
  await worker('rw-wf', `${pe}/sub`); // f's holder now runs inside e's worktree
  await worker('rw-we', pe);
  const e2 = await rejectsCode(orch.task.assign({ task_id: e.id, worker_id: 'rw-we' }), 'E_FILES_OVERLAP');
  assert.strictEqual(e2.detail.other_task_id, f.id);
});
