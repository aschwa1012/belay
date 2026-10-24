'use strict';
// worktrees-check.test.cjs — the independent check of ADR 0053's build: reading a tree never rewrites its index; a link a
// worker made is unlinked, never followed, and a tree git leaves behind is recorded rather than stuck; no merge lands under a
// live worker, parked or in a subdirectory; the orchestrator stays in its run's repository and names no junction; null
// arguments are absent; an empty branch says so; a cwd under the repository is moved; two calls for one task cannot overlap.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor, deadPid } = require('./helpers.cjs');
const { makeRepo, git, write, commit, rejectsCode } = require('./worktree-helpers.cjs');

const { openCore } = core('index.cjs');
const G = core('git.cjs');

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
  await orch.shutdownOwner();
  await orch.close();
  cleanup(dir);
});

let n = 0;
const newTask = (extra = {}) => orch.task.create({ spec: `check ${++n}`, files_owned: [`c${n}`], acceptance: { files_within_owned: true }, ...extra });
const indexOf = (tree) => path.resolve(tree, git(tree, 'rev-parse', '--git-path', 'index'));

test('finding 1: files_within_owned and the dirty check read the tree without rewriting its index', async () => {
  const t = await newTask();
  const w = (await orch.task.worktreeCreate({ task_id: t.id })).worktree;
  // A tracked file whose stat no longer matches the index: a plain git status refreshes the entry and writes the index back.
  const keep = path.join(w.path, 'base', 'keep.txt');
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(keep, later, later);
  const idx = indexOf(w.path);
  const before = fs.statSync(idx).mtimeMs;
  const c = (await orch.task.evaluate({ task_id: t.id })).results.checks.find((x) => x.kind === 'files_within_owned');
  assert.strictEqual(c.executable, true);
  assert.deepStrictEqual(await G.dirtyPaths(w.path), []);
  assert.strictEqual(fs.statSync(idx).mtimeMs, before, 'the index was not rewritten');
});

test('finding 2: a link a worker made in the tree is unlinked, never followed, and the tree is removed', async () => {
  const t = await newTask();
  const w = (await orch.task.worktreeCreate({ task_id: t.id })).worktree;
  const target = path.join(dir, `precious-${t.id}`);
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'keep.txt'), 'keep');
  write(w.path, 'pkg/.gitignore', 'node_modules\n');
  commit(w.path, 'pkg');
  fs.symlinkSync(target, path.join(w.path, 'pkg', 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const row = await orch.task.worktreeRemove({ task_id: t.id });
  assert.deepStrictEqual(row.removal.links_unlinked, [G.fwd(path.join(w.path, 'pkg', 'node_modules'))]);
  assert.strictEqual(row.removal.leftover, false);
  assert.ok(!fs.existsSync(w.path));
  assert.ok(fs.existsSync(path.join(target, 'keep.txt')), 'the link\'s target survived');
  assert.ok(fs.existsSync(path.join(repo, 'node_modules', 'dep', 'index.js')));
});

test('finding 2: a tree git cannot finish deleting is recorded removed with leftover, and a second call says it is gone', { skip: process.platform !== 'win32' && 'a process\'s working directory blocks its delete only on Windows' }, async () => {
  const t = await newTask();
  const w = (await orch.task.worktreeCreate({ task_id: t.id })).worktree;
  write(w.path, 'held/.gitignore', 'open.log\n');
  commit(w.path, 'held');
  // Windows will not delete a directory that a live process has as its working directory. The holder says it is ready, and
  // ends when its stdin closes: the test waits on those two events, never on a clock.
  const { spawn } = require('node:child_process');
  const holder = spawn(process.execPath, ['-e', "process.stdout.write('ready\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"], { cwd: path.join(w.path, 'held'), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const exited = new Promise((r) => holder.once('exit', r));
  await new Promise((r) => holder.stdout.once('data', r));
  let row;
  try { row = await orch.task.worktreeRemove({ task_id: t.id }); } finally { holder.stdin.end(); await exited; }
  // git deleted what it could, dropped its entry and exited 255; no retry of git could finish, so the removal is recorded.
  assert.strictEqual(row.removal.leftover, true);
  assert.match(row.removal.leftover_note, /left .* on disk/);
  assert.ok(row.worktree.removed_at > 0);
  assert.strictEqual(row.worktree.leftover, true);
  assert.ok(fs.existsSync(w.path), 'the directory is still there, and belay deleted nothing more');
  await rejectsCode(orch.task.worktreeRemove({ task_id: t.id }), 'E_NOT_FOUND');
});

test('finding 3: no merge into a tree where a live or parked worker works, at its root or below it', async () => {
  const t = await newTask({ acceptance: { commands: [{ argv: [process.execPath, '-e', ''] }] } });
  const w = (await orch.task.worktreeCreate({ task_id: t.id })).worktree;
  write(w.path, `c${n}/f.txt`, 'f\n');
  commit(w.path, 'f');
  assert.strictEqual((await orch.task.evaluate({ task_id: t.id })).state, 'done');
  await orch.worker.write({ id: `wk-sub-${t.id}`, substrate: 'claude-code', pid: process.pid, state: 'running', worktree: `${repo}/base` });
  const e = await rejectsCode(orch.integration.merge({ task_ids: [t.id], into: 'main' }), 'E_WORKER_LIVE');
  assert.strictEqual(e.detail.worker_id, `wk-sub-${t.id}`);
  await orch.worker.write({ id: `wk-sub-${t.id}`, state: 'stopped', exited_at: Date.now() });
  // A parked worker has no process, but its session resumes in the tree.
  const parked = `wk-park-${t.id}`;
  await orch.worker.write({ id: parked, substrate: 'claude-code', pid: process.pid, state: 'running', worktree: repo });
  await orch.worker.write({ id: parked, state: 'paused', pid: deadPid(), paused_at: Date.now(), paused_by: 'operator' }); // a park ends the process
  await rejectsCode(orch.integration.merge({ task_ids: [t.id], into: 'main' }), 'E_WORKER_LIVE');
  await orch.worker.write({ id: parked, state: 'stopped', exited_at: Date.now(), paused_at: null, paused_by: null });
  assert.strictEqual((await orch.integration.merge({ task_ids: [t.id], into: 'main' })).state, 'evaluated');
});

test('finding 3: removal refuses a parked worker and a worker in a subdirectory', async () => {
  const t = await newTask();
  const w = (await orch.task.worktreeCreate({ task_id: t.id })).worktree;
  const id = `wk-in-${t.id}`;
  await orch.worker.write({ id, substrate: 'claude-code', pid: process.pid, state: 'running', worktree: `${w.path}/base` });
  await rejectsCode(orch.task.worktreeRemove({ task_id: t.id }), 'E_WORKER_LIVE');
  await orch.worker.write({ id, state: 'paused', pid: deadPid(), paused_at: Date.now(), paused_by: 'operator' });
  await rejectsCode(orch.task.worktreeRemove({ task_id: t.id }), 'E_WORKER_LIVE');
  await orch.worker.write({ id, state: 'stopped', exited_at: Date.now(), paused_at: null, paused_by: null });
  assert.ok((await orch.task.worktreeRemove({ task_id: t.id })).worktree.removed_at > 0);
});

test('finding 4: the orchestrator acts only in its run\'s repository, and names no junction; the operator may do both', async () => {
  const other = makeRepo(dir);
  const t = await newTask();
  const e = await rejectsCode(orch.task.worktreeCreate({ task_id: t.id, repo: other }), 'E_ROLE');
  assert.strictEqual(e.detail.repo, other);
  await rejectsCode(orch.task.worktreeCreate({ task_id: t.id, junction: [] }), 'E_ROLE');
  assert.strictEqual((await orch.task.get({ task_id: t.id })).worktree, null);
  // A directory inside the run's own repository is that repository.
  assert.strictEqual((await orch.task.worktreeCreate({ task_id: t.id, repo: `${repo}/base` })).worktree.repo, repo);
  const t2 = await newTask();
  assert.strictEqual((await op.task.worktreeCreate({ task_id: t2.id, repo: other, junction: [] })).worktree.repo, other);
  // A run with no project directory gives the orchestrator no repository at all.
  const bare = await openCore({ dataDir: `${dir}/data`, caller: callerFor('orchestrator', { run_id: 'no-project' }), embed: false });
  try {
    await bare.run.attach({ adapter_pid: process.pid });
    const t3 = await bare.task.create({ spec: 'no project' });
    await rejectsCode(bare.task.worktreeCreate({ task_id: t3.id, repo }), 'E_ARGS');
  } finally { await bare.close(); }
});

test('nits: null optional arguments are absent; an empty branch says so; a cwd under the repository is moved', async () => {
  const t = await newTask({ acceptance: { commands: [{ argv: [process.execPath, '-e', "require('fs').accessSync('keep.txt')"], cwd: `${repo}/base` }] } });
  const w = (await orch.task.worktreeCreate({ task_id: t.id, base: null, branch: null, junction: null, repo: null })).worktree;
  assert.strictEqual(w.branch, `belay/${t.id}`);
  assert.strictEqual(w.junctions.length, 1);
  assert.strictEqual((await orch.task.evaluate({ task_id: t.id })).state, 'done', 'nothing committed, nothing outside');
  const row = await orch.integration.merge({ task_ids: [t.id], into: `int/empty-${n}`, base: null, evaluate: null });
  assert.deepStrictEqual(row.merged.map((m) => [m.already, m.empty]), [[true, true]]);
  assert.strictEqual(row.checks[0].cwd, `${row.worktree}/base`, 'the cwd in the main checkout runs in the integration tree');
  assert.strictEqual(row.passed, true);
  assert.ok((await orch.task.worktreeRemove({ task_id: t.id, force: null, delete_branch: null })).worktree.removed_at > 0);
});

test('nits: two worktree calls for one task never overlap: one is made, the other refused E_BUSY', async () => {
  const t = await newTask();
  const [a, b] = await Promise.allSettled([orch.task.worktreeCreate({ task_id: t.id }), orch.task.worktreeCreate({ task_id: t.id })]);
  const codes = [a, b].map((r) => (r.status === 'fulfilled' ? 'made' : r.reason.code)).sort();
  assert.deepStrictEqual(codes, ['E_BUSY', 'made']);
  assert.ok((await orch.task.get({ task_id: t.id })).worktree.path);
});

test('nits: a rename in a dirty tree names both paths', async () => {
  const t = await newTask();
  const w = (await orch.task.worktreeCreate({ task_id: t.id })).worktree;
  git(w.path, 'mv', 'base/keep.txt', 'base/moved.txt');
  assert.deepStrictEqual((await G.dirtyPaths(w.path)).sort(), ['base/keep.txt', 'base/moved.txt']);
});
