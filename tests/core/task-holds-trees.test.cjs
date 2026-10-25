'use strict';
// task-holds-trees.test.cjs — ADR 0059: a file hold gates only tasks that write in the same tree. Two tasks in their own belay
// worktrees may own one file (create and assign report the overlap); tasks in the shared tree still refuse each other; a
// worker sent into a tree other than its task's own makes that task shared; files_within_owned is unchanged. Every repository
// is a throwaway one under the test's sandbox (worktree-helpers.cjs), never this checkout.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { makeRepo, write, commit, rejectsCode } = require('./worktree-helpers.cjs');

const { openCore } = core('index.cjs');

let dir, orch, repo;

before(async () => {
  dir = sandbox();
  repo = makeRepo(dir);
  orch = await openCore({ dataDir: `${dir}/data`, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid, project_dir: repo });
});

after(async () => {
  await orch.shutdownOwner(); // the only way to stop an owner; never a signal
  await orch.close();
  cleanup(dir);
});

let n = 0;
const task = (files) => orch.task.create({ spec: `work ${++n}`, files_owned: files, acceptance: { files_within_owned: true } });
const own = async (t) => (await orch.task.worktreeCreate({ task_id: t.id })).worktree.path;
const worker = (id, worktree) => orch.worker.write({ id, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: `s-${id}`, worktree });
const ids = (o) => (o || []).map((x) => x.task_id);

test('two tasks in their own worktrees own one file: both are created and assigned, each reporting the other', async () => {
  const a = await task(['lib/registry.js']);
  const pa = await own(a);
  const b = await task(['lib/registry.js']);
  assert.deepStrictEqual(b.overlaps, [{ task_id: a.id, run_id: a.run_id, files: ['lib/registry.js'], worktree: pa }]);
  assert.strictEqual(b.state, 'open');
  const pb = await own(b);
  assert.deepStrictEqual(ids((await orch.task.assign({ task_id: b.id, check_only: true })).overlaps), [a.id], 'check_only reports it too');
  await worker('w-a', pa);
  await worker('w-b', pb);
  const ga = await orch.task.assign({ task_id: a.id, worker_id: 'w-a' });
  assert.deepStrictEqual(ids(ga.overlaps), [b.id]);
  assert.strictEqual(ga.overlaps[0].worktree, pb);
  const gb = await orch.task.assign({ task_id: b.id, worker_id: 'w-b' });
  assert.deepStrictEqual(ids(gb.overlaps), [a.id]);
  assert.strictEqual(gb.task.state, 'assigned');
  // The operator's take-control works the task in its own tree too, so the other tree's holder does not refuse it.
  const op = await openCore({ dataDir: `${dir}/data`, caller: { role: 'operator', run_id: 'cli', pid: process.pid }, embed: false });
  try { assert.strictEqual((await op.lease.takeControl({ task_id: a.id })).new_lease.holder, 'operator'); } finally { await op.close(); }
  assert.ok(!('overlaps' in (await task(['lib/elsewhere.js']))), 'no overlap, no field');
});

test('tasks in the shared tree still serialise, and the refusal says a worktree would lift it', async () => {
  const c = await task(['shared/x.js']);
  const e = await rejectsCode(task(['shared/x.js']), 'E_FILES_OVERLAP');
  assert.strictEqual(e.detail.other_task_id, c.id);
  assert.match(e.message, /same tree/);
  assert.match(e.message, new RegExp(`task ${c.id} is given its own worktree`));
  await worker('w-shared', repo);
  await orch.task.assign({ task_id: c.id, worker_id: 'w-shared' });
  await rejectsCode(task(['shared/x.js/inner']), 'E_FILES_OVERLAP'); // an assigned holder in the shared tree, a nested path
});

test('mixed: a shared-tree task may overlap one in its own worktree, but not another shared one, nor enter that worktree', async () => {
  const e = await task(['mixed/m.js']);
  const pe = await own(e);
  const f = await task(['mixed/m.js']); // judged as shared at create; e is in its own tree
  assert.deepStrictEqual(ids(f.overlaps), [e.id]);
  await rejectsCode(task(['mixed/m.js']), 'E_FILES_OVERLAP'); // f is shared, and so is the new one
  // f worked from inside e's worktree writes in e's tree: refused, naming e.
  await worker('w-into-e', pe);
  const into = await rejectsCode(orch.task.assign({ task_id: f.id, worker_id: 'w-into-e' }), 'E_FILES_OVERLAP');
  assert.strictEqual(into.detail.other_task_id, e.id);
  assert.match(into.message, new RegExp(`give task ${f.id} its own worktree`));
  // f worked from the shared checkout is in another tree from e: assigned, reporting e.
  await worker('w-mixed', repo);
  const g = await orch.task.assign({ task_id: f.id, worker_id: 'w-mixed' });
  assert.deepStrictEqual(ids(g.overlaps), [e.id]);
  assert.strictEqual(g.overlaps[0].worktree, pe);
});

test('a task with a worktree worked by a worker elsewhere is shared, and so is one whose worktree was removed', async () => {
  const h = await task(['moved/h.js']);
  await own(h);
  const i = await task(['moved/h.js']); // shared, beside h's own tree
  await worker('w-moved', repo);
  // h assigned to a worker in the shared checkout writes in the shared tree, where i holds the path.
  const e1 = await rejectsCode(orch.task.assign({ task_id: h.id, worker_id: 'w-moved' }), 'E_FILES_OVERLAP');
  assert.strictEqual(e1.detail.other_task_id, i.id);
  await orch.task.worktreeRemove({ task_id: h.id });
  const e2 = await rejectsCode(orch.task.assign({ task_id: h.id, worker_id: 'w-moved', check_only: true }), 'E_FILES_OVERLAP');
  assert.strictEqual(e2.detail.other_task_id, i.id);
});

test('files_within_owned is unchanged: each task is judged against its own files in its own worktree', async () => {
  const a = await task(['fwo/same.js']);
  const pa = await own(a);
  const b = await task(['fwo/same.js']);
  const pb = await own(b);
  write(pa, 'fwo/same.js', 'a\n');
  commit(pa, 'a');
  write(pb, 'fwo/same.js', 'b\n');
  write(pb, 'fwo/stray.js', 'stray\n');
  commit(pb, 'b');
  const ra = await orch.task.evaluate({ task_id: a.id });
  const ca = ra.results.checks.find((x) => x.kind === 'files_within_owned');
  assert.deepStrictEqual([ca.passed, ca.detail.changed], [true, ['fwo/same.js']]);
  assert.strictEqual(ra.state, 'done');
  const cb = (await orch.task.evaluate({ task_id: b.id })).results.checks.find((x) => x.kind === 'files_within_owned');
  assert.deepStrictEqual([cb.passed, cb.detail.outside], [false, ['fwo/stray.js']]);
});

test('the MCP tools turn the overlaps into a warning, beside the no-check warning on create', async () => {
  const { createCompose } = require('../../src/mcp/compose.cjs');
  const o = [{ task_id: 't-other', run_id: 'r', files: ['lib/registry.js'], worktree: '/w' }];
  const callCore = async (m) => (m === 'task.create' ? { id: 't1', acceptance: null, overlaps: o } : { task: { id: 't1' }, new_lease: { id: 'l' }, overlaps: o });
  const c = createCompose({ callCore, manager: () => null });
  const made = await c.create({ spec: 'x' });
  assert.match(made.warning, /declares no acceptance check/);
  assert.match(made.warning, /task t-other \(lib\/registry\.js\) in another tree; integrate may stop on a conflict there/);
  const got = await c.assign({ task_id: 't1', worker_id: 'w1', deliver: false });
  assert.match(got.warning, /task t-other/);
  const plain = await createCompose({ callCore: async () => ({ id: 't2', acceptance: { files_within_owned: true } }), manager: () => null }).create({ spec: 'y' });
  assert.ok(!('warning' in plain));
});
