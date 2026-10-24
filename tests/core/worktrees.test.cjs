'use strict';
// worktrees.test.cjs — ADR 0053 decisions 1 to 4: a worktree and branch per task, made from a recorded base and removed by
// belay, with node_modules junctioned only when git ignores it and unlinked before the tree is removed; task.evaluate judges
// from the recorded base. Every repository is a throwaway one under the OS temp dir (helpers.cjs), never this checkout.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { makeRepo, git, write, commit, rejectsCode } = require('./worktree-helpers.cjs');

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

let n = 0;
const newTask = (extra = {}) => orch.task.create({ spec: `work ${++n}`, files_owned: [`t${n}`], acceptance: { files_within_owned: true }, ...extra });

test('create records repo, path, branch and base, checks the branch out from the base, and junctions an ignored node_modules', async () => {
  const t = await newTask();
  const row = await orch.task.worktreeCreate({ task_id: t.id });
  const w = row.worktree;
  assert.strictEqual(w.repo, repo);
  assert.strictEqual(w.branch, `belay/${t.id}`);
  assert.strictEqual(w.base_ref, 'HEAD');
  assert.strictEqual(w.base_sha, git(repo, 'rev-parse', 'HEAD'));
  assert.strictEqual(w.path, `${path.dirname(repo).split('\\').join('/')}/${path.basename(repo)}.worktrees/${t.id}`);
  assert.strictEqual(git(w.path, 'rev-parse', '--abbrev-ref', 'HEAD'), w.branch);
  assert.strictEqual(git(w.path, 'rev-parse', 'HEAD'), w.base_sha);
  assert.strictEqual(w.junctions.length, 1);
  const link = path.join(w.path, 'node_modules');
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'node_modules is a link');
  assert.ok(fs.existsSync(path.join(link, 'dep', 'index.js')), 'the link reaches the repository\'s node_modules');
  assert.strictEqual(git(w.path, 'status', '--porcelain', '--untracked-files=all'), '', 'the junction is ignored, so the tree is clean');
  assert.strictEqual((await orch.task.get({ task_id: t.id })).worktree.path, w.path, 'the row carries it');
});

test('a junction git does not ignore is not made, and is named with the reason', async () => {
  const r2 = makeRepo(dir, { ignore: false });
  const t = await newTask();
  const row = await orch.task.worktreeCreate({ task_id: t.id, repo: r2 });
  assert.deepStrictEqual(row.worktree.junctions, []);
  assert.strictEqual(row.worktree.junctions_skipped[0].path, 'node_modules');
  assert.match(row.worktree.junctions_skipped[0].reason, /does not ignore/);
  assert.ok(!fs.existsSync(path.join(row.worktree.path, 'node_modules')), 'no link left behind');
});

test('create refuses: a second worktree, a done task, an unknown task, a bad branch, an unknown base, an existing branch, a path from the orchestrator', async () => {
  const t = await newTask();
  await orch.task.worktreeCreate({ task_id: t.id });
  await rejectsCode(orch.task.worktreeCreate({ task_id: t.id }), 'E_EXISTS');
  await rejectsCode(orch.task.worktreeCreate({ task_id: 'nope' }), 'E_NOT_FOUND');
  const t2 = await newTask();
  await rejectsCode(orch.task.worktreeCreate({ task_id: t2.id, branch: 'a..b' }), 'E_ARGS');
  await rejectsCode(orch.task.worktreeCreate({ task_id: t2.id, branch: '-x' }), 'E_ARGS');
  await rejectsCode(orch.task.worktreeCreate({ task_id: t2.id, base: 'no-such-ref' }), 'E_GIT');
  await rejectsCode(orch.task.worktreeCreate({ task_id: t2.id, base: '--all' }), 'E_ARGS');
  await rejectsCode(orch.task.worktreeCreate({ task_id: t2.id, branch: `belay/${t.id}` }), 'E_EXISTS');
  await rejectsCode(orch.task.worktreeCreate({ task_id: t2.id, path: `${dir}/elsewhere` }), 'E_ROLE');
  await rejectsCode(orch.task.worktreeCreate({ task_id: t2.id, junction: ['../up'] }), 'E_ARGS');
  assert.strictEqual((await orch.task.get({ task_id: t2.id })).worktree, null, 'nothing was recorded for the refused task');
  const done = await orch.task.create({ spec: 'already done', acceptance: { commands: [{ argv: [process.execPath, '-e', ''] }] } });
  assert.strictEqual((await orch.task.evaluate({ task_id: done.id, worktree: repo })).state, 'done');
  await rejectsCode(orch.task.worktreeCreate({ task_id: done.id }), 'E_TASK_DONE');
});

test('evaluate defaults to the recorded worktree and base: a branch merged into main still shows its committed files', async () => {
  const t = await newTask();
  const w = (await orch.task.worktreeCreate({ task_id: t.id })).worktree;
  write(w.path, `t${n}/a.txt`, 'mine\n');
  commit(w.path, 'work');
  // main moves to the task's head: under the old default, merge-base HEAD main is HEAD and the range is empty.
  git(repo, 'merge', '-q', '--ff-only', w.branch);
  const row = await orch.task.evaluate({ task_id: t.id });
  const c = row.results.checks.find((x) => x.kind === 'files_within_owned');
  assert.strictEqual(c.detail.base_source, 'recorded');
  assert.strictEqual(c.detail.base_sha, w.base_sha);
  assert.strictEqual(c.detail.empty_range, false);
  assert.deepStrictEqual(c.detail.changed, [`t${n}/a.txt`]);
  assert.strictEqual(row.state, 'done');
  const t2 = await newTask();
  const w2 = (await orch.task.worktreeCreate({ task_id: t2.id })).worktree;
  write(w2.path, 'not-owned.txt', 'x\n');
  commit(w2.path, 'stray');
  const c2 = (await orch.task.evaluate({ task_id: t2.id, worktree: w2.path })).results.checks.find((x) => x.kind === 'files_within_owned');
  assert.strictEqual(c2.detail.base_source, 'recorded', 'an explicit worktree still takes the recorded base');
  assert.deepStrictEqual(c2.detail.outside, ['not-owned.txt']);
  const c3 = (await orch.task.evaluate({ task_id: t2.id, base: 'HEAD' })).results.checks.find((x) => x.kind === 'files_within_owned');
  assert.strictEqual(c3.detail.base_source, 'arg', 'an explicit base wins');
  const bare = await newTask();
  await rejectsCode(orch.task.evaluate({ task_id: bare.id }), 'E_ARGS');
});

test('remove refuses a dirty tree, then unlinks the junction before git removes the tree; the branch is kept', async () => {
  const t = await newTask();
  const w = (await orch.task.worktreeCreate({ task_id: t.id })).worktree;
  write(w.path, 'loose.txt', 'uncommitted\n');
  const e = await rejectsCode(orch.task.worktreeRemove({ task_id: t.id }), 'E_PRECONDITION');
  assert.deepStrictEqual(e.detail.dirty, ['loose.txt']);
  const row = await orch.task.worktreeRemove({ task_id: t.id, force: true });
  assert.ok(!fs.existsSync(w.path), 'the tree is gone');
  assert.ok(fs.existsSync(path.join(repo, 'node_modules', 'dep', 'index.js')), 'the repository\'s node_modules survived');
  assert.strictEqual(row.removal.junctions_unlinked.length, 1);
  assert.strictEqual(row.removal.forced, true);
  assert.ok(row.worktree.removed_at > 0);
  assert.strictEqual(git(repo, 'rev-parse', '--verify', `refs/heads/${w.branch}`).length, 40, 'the branch holds the work and stays');
  await rejectsCode(orch.task.worktreeRemove({ task_id: t.id }), 'E_NOT_FOUND');
});

test('remove with delete_branch deletes a merged branch and keeps an unmerged one, saying why', async () => {
  const merged = await newTask();
  const wm = (await orch.task.worktreeCreate({ task_id: merged.id })).worktree;
  assert.strictEqual((await orch.task.worktreeRemove({ task_id: merged.id, delete_branch: true })).removal.branch_deleted, true);
  assert.strictEqual(git(repo, 'branch', '--list', wm.branch), '');
  const open = await newTask();
  const wo = (await orch.task.worktreeCreate({ task_id: open.id })).worktree;
  write(wo.path, 'x.txt', 'x\n');
  commit(wo.path, 'unmerged');
  const out = (await orch.task.worktreeRemove({ task_id: open.id, delete_branch: true })).removal;
  assert.strictEqual(out.branch_deleted, false);
  assert.match(out.branch_kept, /refused/);
});

test('remove refuses while a live worker works in the tree, and refuses a recorded junction that is now a real directory', async () => {
  const t = await newTask();
  const w = (await orch.task.worktreeCreate({ task_id: t.id })).worktree;
  await orch.worker.write({ id: `wk-${t.id}`, substrate: 'claude-code', pid: process.pid, state: 'running', worktree: w.path });
  await rejectsCode(orch.task.worktreeRemove({ task_id: t.id }), 'E_WORKER_LIVE');
  await orch.worker.write({ id: `wk-${t.id}`, state: 'stopped', exited_at: Date.now() });
  const link = path.join(w.path, 'node_modules');
  fs.unlinkSync(link);
  fs.mkdirSync(path.join(link, 'real'), { recursive: true });
  fs.writeFileSync(path.join(link, 'real', 'keep.txt'), 'keep');
  await rejectsCode(orch.task.worktreeRemove({ task_id: t.id, force: true }), 'E_PRECONDITION');
  assert.ok(fs.existsSync(path.join(link, 'real', 'keep.txt')), 'nothing under it was removed');
});

test('a failure after git made the tree rolls it back: junctions unlinked, tree removed, branch deleted, nothing recorded', async () => {
  // At the base `sub` is a file; at HEAD it is a directory holding x. A junction for sub/x then has a target but no parent to sit in.
  const r3 = makeRepo(dir);
  write(r3, 'sub', 'a file\n');
  commit(r3, 'sub as a file');
  const fileBase = git(r3, 'rev-parse', 'HEAD');
  git(r3, 'rm', '-q', 'sub');
  write(r3, 'sub/x/y.txt', 'y\n');
  commit(r3, 'sub as a directory');
  const t = await newTask();
  const e = await rejectsCode(orch.task.worktreeCreate({ task_id: t.id, repo: r3, base: fileBase, junction: ['node_modules', 'sub/x'] }), null);
  assert.strictEqual(e.detail.rollback.worktree_removed, true);
  assert.strictEqual(e.detail.rollback.branch_deleted, true);
  assert.strictEqual(e.detail.rollback.junctions.length, 1, 'the node_modules junction made before the failure was unlinked');
  assert.ok(fs.existsSync(path.join(r3, 'node_modules', 'dep', 'index.js')), 'and its target survived');
  assert.strictEqual(git(r3, 'branch', '--list', `belay/${t.id}`), '');
  assert.strictEqual((await orch.task.get({ task_id: t.id })).worktree, null);
});

test('a worker caller may not create or remove a worktree', async () => {
  const w = await openCore({ dataDir: `${dir}/data`, caller: callerFor('worker', { worker_id: 'w-x' }), embed: false });
  try {
    const t = await newTask();
    await rejectsCode(w.task.worktreeCreate({ task_id: t.id }), 'E_ROLE');
    await rejectsCode(w.task.worktreeRemove({ task_id: t.id }), 'E_ROLE');
  } finally { await w.close(); }
});

test('a task id that is not a path id gets no default tree: refused, never rewritten onto another name', async () => {
  for (const id of ['has space', 'con', 'dot.', 'a/b']) {
    const t = await orch.task.create({ id, spec: 'odd id' });
    const e = await rejectsCode(orch.task.worktreeCreate({ task_id: t.id }), 'E_ARGS');
    assert.match(e.message, /not a valid id/);
  }
});

test('files_within_owned reads the whole change: a path outside the owned set past the first 2 KB of git output is seen', async () => {
  const t = await orch.task.create({ spec: 'many files', files_owned: ['owned'], acceptance: { files_within_owned: true } });
  const w = (await orch.task.worktreeCreate({ task_id: t.id })).worktree;
  // 60 committed and 60 uncommitted owned paths of about 60 characters each: both listings run well past 2,000 characters,
  // and the one path outside the owned set sorts after all of them.
  const long = (i, tag) => `owned/${tag}-${String(i).padStart(3, '0')}-${'x'.repeat(48)}.txt`;
  for (let i = 0; i < 60; i += 1) write(w.path, long(i, 'c'), 'c\n');
  write(w.path, 'zzz-outside-committed.txt', 'out\n');
  commit(w.path, 'many');
  for (let i = 0; i < 60; i += 1) write(w.path, long(i, 'u'), 'u\n');
  write(w.path, 'zzz-outside-loose.txt', 'out\n');
  assert.ok(git(w.path, 'diff', '--name-only', w.base_sha, 'HEAD').length > 2000, 'the committed listing is longer than the old cut');
  const c = (await orch.task.evaluate({ task_id: t.id })).results.checks.find((x) => x.kind === 'files_within_owned');
  assert.strictEqual(c.executable, true);
  assert.strictEqual(c.detail.changed_count, 122);
  assert.deepStrictEqual(c.detail.outside, ['zzz-outside-committed.txt', 'zzz-outside-loose.txt']);
  assert.strictEqual(c.passed, false);
});
