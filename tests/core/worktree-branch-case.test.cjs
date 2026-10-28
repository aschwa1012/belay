'use strict';
// worktree-branch-case.test.cjs — a task branch named as another spelling of an existing branch is refused, even when that branch's ref is
// packed (a packed ref is not found by resolving a variant). Otherwise commits on the variant would move the user's branch on a host whose
// refs compare equal across case.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { makeRepo, git, rejectsCode } = require('./worktree-helpers.cjs');

const { openCore } = core('index.cjs');

let dir, orch, repo;

before(async () => {
  dir = sandbox();
  repo = makeRepo(dir);
  orch = await openCore({ dataDir: `${dir}/data`, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid, project_dir: repo });
});

after(async () => {
  await orch.shutdownOwner();
  await orch.close();
  cleanup(dir);
});

test('a branch that is another spelling of a packed branch is refused, and nothing is made', async () => {
  git(repo, 'pack-refs', '--all');
  const before = git(repo, 'rev-parse', 'refs/heads/main');
  const t = await orch.task.create({ spec: 'a', acceptance: { commands: [{ argv: [process.execPath, '-e', '0'] }] } });
  const e = await rejectsCode(orch.task.worktreeCreate({ task_id: t.id, branch: 'Main' }), 'E_EXISTS');
  assert.strictEqual(e.detail.existing, 'main');
  assert.strictEqual(git(repo, 'branch', '--list', 'Main'), '', 'no variant branch was made');
  assert.strictEqual(git(repo, 'rev-parse', 'refs/heads/main'), before);
  assert.ok((await orch.task.worktreeCreate({ task_id: t.id, branch: 'belay/fresh' })).worktree, 'a new name is still accepted');
});
