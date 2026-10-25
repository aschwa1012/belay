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
