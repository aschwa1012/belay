'use strict';
// integration.test.cjs — ADR 0053 decision 5: finished task branches are merged, in order, into an integration branch (never
// the default branch unless named), and the merged tasks' acceptance commands re-run on the result. On a conflict the merge
// is aborted, the tree left clean, and the row names the task and the files. Throwaway repositories under the sandbox only.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { makeRepo, git, write, commit, rejectsCode } = require('./worktree-helpers.cjs');

const { openCore } = core('index.cjs');

let dir, orch, op;

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

const exists = (rel) => ({ argv: [process.execPath, '-e', `require('fs').accessSync(${JSON.stringify(rel)})`] });

// A done task in its own worktree: `files` written and committed there, evaluated with `commands`.
async function doneTask(repo, files, commands, extra = {}) {
  const t = await orch.task.create({ spec: `write ${Object.keys(files).join(', ')}`, acceptance: { commands }, ...extra });
  const w = (await orch.task.worktreeCreate({ task_id: t.id, repo })).worktree;
  for (const [rel, text] of Object.entries(files)) write(w.path, rel, text);
  commit(w.path, `task ${t.id}`);
  const row = await orch.task.evaluate({ task_id: t.id });
  assert.strictEqual(row.state, 'done', JSON.stringify(row.results));
  return { task: row, w };
}

test('two done tasks merge into a new integration branch, and their shared check runs once on the merged tree', async () => {
  const repo = makeRepo(dir);
  const a = await doneTask(repo, { 'a.txt': 'a\n' }, [exists('a.txt'), exists('base/keep.txt')]);
  const b = await doneTask(repo, { 'b.txt': 'b\n' }, [exists('b.txt'), exists('base/keep.txt')]);
  const row = await orch.integration.merge({ task_ids: [a.task.id, b.task.id] });
  assert.strictEqual(row.state, 'evaluated');
  assert.strictEqual(row.into_branch, 'belay/integrate/test-run');
  assert.strictEqual(row.created_worktree, true);
  assert.strictEqual(row.passed, true);
  assert.deepStrictEqual(row.merged.map((m) => [m.task_id, m.already]), [[a.task.id, false], [b.task.id, false]]);
  assert.ok(fs.existsSync(path.join(row.worktree, 'a.txt')) && fs.existsSync(path.join(row.worktree, 'b.txt')));
  assert.strictEqual(row.checks.length, 3, 'the shared base check ran once');
  assert.deepStrictEqual(row.checks.find((c) => c.argv[2].includes('base/keep')).task_ids, [a.task.id, b.task.id]);
  assert.strictEqual(git(repo, 'rev-parse', 'main'), a.w.base_sha, 'main did not move');
  assert.strictEqual(git(row.worktree, 'rev-parse', 'HEAD'), row.head_sha);
  assert.ok(fs.lstatSync(path.join(row.worktree, 'node_modules')).isSymbolicLink(), 'the integration tree has node_modules for its checks');
  const states = (await orch.integration.list({})).integrations.filter((r) => r.id === row.id);
  assert.strictEqual(states.length, 1);
  assert.strictEqual((await orch.integration.get({ id: row.id })).state, 'evaluated');
  // Merging again records the branches as already contained and re-runs the checks.
  const again = await orch.integration.merge({ task_ids: [a.task.id, b.task.id] });
  assert.deepStrictEqual(again.merged.map((m) => m.already), [true, true]);
  assert.strictEqual(again.worktree, row.worktree, 'the branch checked out in the integration tree is merged there');
});

test('a check that passes in each task\'s tree but fails on the merged result fails the integration and leaves the tasks done', async () => {
  const repo = makeRepo(dir);
  // Each task's check passes unless both a.txt and b.txt exist: true alone, false merged.
  const notBoth = { argv: [process.execPath, '-e', "const f=require('fs');process.exit(f.existsSync('a.txt')&&f.existsSync('b.txt')?1:0)"] };
  const a = await doneTask(repo, { 'a.txt': 'a\n' }, [notBoth]);
  const b = await doneTask(repo, { 'b.txt': 'b\n' }, [notBoth]);
  const row = await orch.integration.merge({ task_ids: [a.task.id, b.task.id], into: 'int/notboth' });
  assert.strictEqual(row.state, 'evaluated');
  assert.strictEqual(row.passed, false);
  assert.strictEqual(row.checks[0].exit_code, 1);
  assert.strictEqual((await orch.task.get({ task_id: a.task.id })).state, 'done', 'integration never changes a task row');
});

test('a conflict stops the merge: aborted, the tree clean, the conflicting task and files named, the merges before it kept', async () => {
  const repo = makeRepo(dir);
  const a = await doneTask(repo, { 'base/keep.txt': 'from a\n' }, [exists('base/keep.txt')]);
  const b = await doneTask(repo, { 'base/keep.txt': 'from b\n' }, [exists('base/keep.txt')]);
  const c = await doneTask(repo, { 'c.txt': 'c\n' }, [exists('c.txt')]);
  const row = await orch.integration.merge({ task_ids: [a.task.id, b.task.id, c.task.id], into: 'int/conflict' });
  assert.strictEqual(row.state, 'conflict');
  assert.strictEqual(row.conflict.task_id, b.task.id);
  assert.deepStrictEqual(row.conflict.files, ['base/keep.txt']);
  assert.strictEqual(row.conflict.aborted, true);
  assert.strictEqual(row.conflict.tree_clean, true);
  assert.deepStrictEqual(row.merged.map((m) => m.task_id), [a.task.id], 'c was not tried');
  assert.strictEqual(row.checks, null, 'nothing is evaluated after a conflict');
  assert.strictEqual(git(row.worktree, 'status', '--porcelain'), '');
  assert.strictEqual(fs.readFileSync(path.join(row.worktree, 'base/keep.txt'), 'utf8'), 'from a\n');
  assert.strictEqual(git(row.worktree, 'rev-parse', 'HEAD'), row.head_sha);
});

test('the default branch is merged into only when named, in its own checkout, and only when that checkout is clean', async () => {
  const repo = makeRepo(dir);
  const a = await doneTask(repo, { 'a.txt': 'a\n' }, [exists('a.txt')]);
  write(repo, 'loose.txt', 'dirty\n');
  const e = await rejectsCode(orch.integration.merge({ task_ids: [a.task.id], into: 'main' }), 'E_PRECONDITION');
  assert.deepStrictEqual(e.detail.dirty, ['loose.txt']);
  fs.unlinkSync(path.join(repo, 'loose.txt'));
  const row = await orch.integration.merge({ task_ids: [a.task.id], into: 'main' });
  assert.strictEqual(row.state, 'evaluated');
  assert.strictEqual(row.created_worktree, false);
  assert.strictEqual(row.worktree, repo);
  assert.ok(fs.existsSync(path.join(repo, 'a.txt')));
});

test('refusals: a task not done, a task with no branch, uncommitted work in a task tree, different bases with no base given', async () => {
  const repo = makeRepo(dir);
  const open = await orch.task.create({ spec: 'open', acceptance: { commands: [exists('x')] } });
  await orch.task.worktreeCreate({ task_id: open.id, repo });
  await rejectsCode(orch.integration.merge({ task_ids: [open.id] }), 'E_PRECONDITION');
  const bare = await orch.task.create({ spec: 'bare', acceptance: { commands: [{ argv: [process.execPath, '-e', ''] }] } });
  await orch.task.evaluate({ task_id: bare.id, worktree: repo });
  await rejectsCode(orch.integration.merge({ task_ids: [bare.id] }), 'E_PRECONDITION');
  const a = await doneTask(repo, { 'a.txt': 'a\n' }, [exists('a.txt')]);
  write(a.w.path, 'left.txt', 'uncommitted\n');
  const e = await rejectsCode(orch.integration.merge({ task_ids: [a.task.id] }), 'E_PRECONDITION');
  assert.strictEqual(e.detail.dirty[0].task_id, a.task.id);
  fs.unlinkSync(path.join(a.w.path, 'left.txt'));
  write(repo, 'moved.txt', 'main moves\n');
  commit(repo, 'main moves');
  const b = await doneTask(repo, { 'b.txt': 'b\n' }, [exists('b.txt')]);
  await rejectsCode(orch.integration.merge({ task_ids: [a.task.id, b.task.id], into: 'int/twobases' }), 'E_ARGS');
  const row = await orch.integration.merge({ task_ids: [a.task.id, b.task.id], into: 'int/twobases', base: 'main' });
  assert.strictEqual(row.state, 'evaluated');
  assert.strictEqual(row.passed, true);
  await rejectsCode(orch.integration.merge({ task_ids: [] }), 'E_ARGS');
  await rejectsCode(orch.integration.merge({ task_ids: [a.task.id, a.task.id] }), 'E_ARGS');
  await rejectsCode(orch.integration.merge({ task_ids: [a.task.id], into: '-x' }), 'E_ARGS');
});

test('a command cwd inside the task\'s own worktree is moved to the same place in the integration tree', async () => {
  const repo = makeRepo(dir);
  const id = 'cwd-task';
  const own = `${path.dirname(repo)}/${path.basename(repo)}.worktrees/${id}`; // the default path, known before the tree exists
  const check = { argv: [process.execPath, '-e', "require('fs').accessSync('s.txt')"], cwd: `${own}/sub` };
  const t = await orch.task.create({ id, spec: 'sub', acceptance: { commands: [check] } });
  const w = (await orch.task.worktreeCreate({ task_id: t.id, repo })).worktree;
  assert.strictEqual(w.path, own);
  write(w.path, 'sub/s.txt', 's\n');
  commit(w.path, 'sub');
  assert.strictEqual((await orch.task.evaluate({ task_id: t.id })).state, 'done');
  const row = await orch.integration.merge({ task_ids: [t.id], into: 'int/cwd' });
  assert.strictEqual(row.checks[0].cwd, `${row.worktree}/sub`);
  assert.strictEqual(row.passed, true);
});

test('integration.remove takes away a tree belay made, junction first; the branch stays', async () => {
  const repo = makeRepo(dir);
  const a = await doneTask(repo, { 'a.txt': 'a\n' }, [exists('a.txt')]);
  const row = await orch.integration.merge({ task_ids: [a.task.id], into: 'int/remove' });
  await rejectsCode(orch.integration.remove({ id: row.id }), 'E_ROLE');
  const out = await op.integration.remove({ id: row.id });
  assert.ok(out.removed_at > 0);
  assert.strictEqual(out.removal.junctions_unlinked.length, 1);
  assert.ok(!fs.existsSync(row.worktree));
  assert.ok(fs.existsSync(path.join(repo, 'node_modules', 'dep', 'index.js')));
  assert.strictEqual(git(repo, 'rev-parse', 'int/remove'), row.head_sha);
  await rejectsCode(op.integration.remove({ id: row.id }), 'E_NOT_FOUND');
});
