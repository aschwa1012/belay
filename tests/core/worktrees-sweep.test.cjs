'use strict';
// worktrees-sweep.test.cjs — task.worktreeSweep (the run's close removes the task trees it can prove finished): each reason a
// tree is kept, the removal's proof, a failed removal left alone, orphans reported and never removed, and the check that a tree's
// HEAD is on its branch (which task.worktreeRemove gains too). Throwaway repositories under the sandbox; the engine runs in this
// process, so a failing git call is a seam on git.cjs and nothing is locked for real.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { makeRepo, git, write, commit, rejectsCode } = require('./worktree-helpers.cjs');

const { Engine } = core('engine.cjs');
const { Store } = core('store.cjs');
const rows = core('rows.cjs');
const G = core('git.cjs');

let dir, store, E, repo;
const orch = () => callerFor('orchestrator');
const op = () => ({ role: 'operator', run_id: 'cli', pid: process.pid });
const call = (method, args, caller = orch()) => E.handle(method, { caller, ...args });
const sweep = (extra = {}) => call('task.worktreeSweep', { run_id: 'test-run', ...extra }, op());

before(async () => {
  dir = sandbox();
  repo = makeRepo(dir);
  store = new Store(`${dir}/memory.db`);
  E = new Engine({ dataDir: dir, store, getEmbedder: null, owner: null, establishedBy: 'test' });
  await call('run.attach', { adapter_pid: process.pid, project_dir: repo });
});
after(() => { store.close(); cleanup(dir); });

let n = 0;
// A task with its own tree, then ended (cancelled) unless `end` is false.
async function treeTask({ end = true, repoDir = repo } = {}) {
  const t = await call('task.create', { spec: `work ${++n}`, files_owned: [`s${n}`] });
  const row = await call('task.worktreeCreate', { task_id: t.id, repo: repoDir }, op());
  if (end) await call('task.cancel', { task_id: t.id, reason: 'sweep test' });
  return { id: t.id, w: row.worktree };
}
const entryFor = (list, id) => list.find((x) => x.task_ids.includes(id));

test('a finished clean tree is removed with proof, its branch and the main checkout are left alone', async () => {
  const { id, w } = await treeTask();
  const head = git(w.path, 'rev-parse', 'HEAD');
  const out = await sweep();
  const r = entryFor(out.removed, id);
  assert.ok(r, JSON.stringify(out));
  assert.deepStrictEqual([r.path, r.branch, r.head, r.branch_head_after, r.path_gone], [w.path, w.branch, head, head, true]);
  assert.strictEqual(r.junctions_unlinked.length, 1);
  assert.ok(!fs.existsSync(w.path));
  assert.ok(fs.existsSync(path.join(repo, 'node_modules', 'dep', 'index.js')), 'the junction target is intact');
  assert.strictEqual(git(repo, 'rev-parse', `refs/heads/${w.branch}`), head, 'the branch survives');
  const task = await call('task.get', { task_id: id });
  assert.ok(task.worktree.removed_at && task.worktree.removed_by, 'the row records the removal');
  assert.deepStrictEqual(out.failed, []);
});

test('a second sweep has nothing left to do', async () => {
  const out = await sweep();
  assert.deepStrictEqual([out.removed, out.kept, out.failed, out.skipped], [[], [], [], null]);
});

test('an unfinished task keeps its tree (task_open) until it ends', async () => {
  const open = await treeTask({ end: false });
  const out = await sweep();
  const k = entryFor(out.kept, open.id);
  assert.strictEqual(k.reason, 'task_open');
  assert.ok(fs.existsSync(open.w.path));
  await call('task.cancel', { task_id: open.id, reason: 'done with it' });
  assert.ok(entryFor((await sweep()).removed, open.id), 'removed once it ended');
});

test('a dirty tree is kept and names its paths', async () => {
  const { id, w } = await treeTask();
  write(w.path, 'scratch.txt', 'x\n');
  const k = entryFor((await sweep()).kept, id);
  assert.strictEqual(k.reason, 'dirty');
  assert.deepStrictEqual(k.paths, ['scratch.txt']);
  assert.ok(fs.existsSync(w.path));
});

test('a live worker and a parked worker keep their trees', async () => {
  const live = await treeTask();
  const parked = await treeTask();
  await call('worker.write', { id: 'sw-live', substrate: 'claude-code', pid: process.pid, state: 'running', worktree: live.w.path });
  await call('worker.write', { id: 'sw-parked', substrate: 'claude-code', pid: null, state: 'paused', paused_by: 'test', paused_at: Date.now(), worktree: parked.w.path });
  const out = await sweep();
  assert.strictEqual(entryFor(out.kept, live.id).reason, 'live_worker');
  assert.strictEqual(entryFor(out.kept, parked.id).reason, 'parked_worker');
  assert.ok(fs.existsSync(live.w.path) && fs.existsSync(parked.w.path));
});

test('a worker the close could not prove ended keeps its tree, whatever its row says', async () => {
  const { id, w } = await treeTask();
  await call('worker.write', { id: 'sw-unproven', substrate: 'claude-code', pid: null, state: 'stopped', worktree: w.path });
  const k = entryFor((await sweep({ unproven_workers: ['sw-unproven'] })).kept, id);
  assert.strictEqual(k.reason, 'kill_unproven');
});

test('an integration tree is kept and listed, and a tree an integration is merging into is kept', async () => {
  const a = await treeTask();
  rows.append(store, 'integration', { id: 'int-sw-1', run_id: 'test-run', repo, into_branch: a.w.branch, worktree: `${dir}/elsewhere`, created_worktree: true, state: 'merging', task_ids: [a.id] }, 'test', Date.now());
  rows.append(store, 'integration', { id: 'int-sw-2', run_id: 'test-run', repo, into_branch: 'belay/integrate/x', worktree: `${dir}/int-tree`, created_worktree: true, state: 'evaluated', task_ids: [] }, 'test', Date.now());
  const out = await sweep();
  assert.strictEqual(entryFor(out.kept, a.id).reason, 'integration_target');
  assert.ok(out.integration_kept.some((i) => i.id === 'int-sw-2' && i.path === `${dir}/int-tree`));
  rows.append(store, 'integration', { id: 'int-sw-1', run_id: 'test-run', repo, into_branch: a.w.branch, worktree: `${dir}/elsewhere`, created_worktree: true, state: 'evaluated', task_ids: [a.id], removed_at: Date.now() }, 'test', Date.now());
  assert.ok(entryFor((await sweep()).removed, a.id));
});

test('a tree a live run also records is kept', async () => {
  const a = await treeTask();
  await call('run.attach', { adapter_pid: process.pid }, { role: 'orchestrator', run_id: 'other-live', pid: process.pid });
  const t = rows.current(store, 'task', a.id);
  rows.append(store, 'task', { ...t, id: 'other-live-task', run_id: 'other-live', state: 'cancelled', worktree: { ...t.worktree } }, 'test', Date.now());
  const k = entryFor((await sweep()).kept, a.id);
  assert.strictEqual(k.reason, 'shared_with_live_run');
});

test('a removal that fails lands in failed after one attempt, and the tree and branch stay', async () => {
  const { id, w } = await treeTask();
  const real = G.run;
  let attempts = 0;
  G.run = async (cwd, args, opts) => {
    if (args[0] === 'worktree' && args[1] === 'remove') { attempts += 1; return { ok: false, argv: ['git', ...args], cwd, exit_code: 128, stdout: '', stderr: 'error: failed to delete: Permission denied\n' }; }
    return real(cwd, args, opts);
  };
  let out;
  try { out = await sweep(); } finally { G.run = real; }
  const f = entryFor(out.failed, id);
  assert.ok(f, JSON.stringify(out));
  assert.strictEqual(f.code, 'E_GIT');
  assert.strictEqual(f.git_still_lists, true);
  assert.strictEqual(attempts, 1, 'one attempt, no retry');
  assert.ok(fs.existsSync(w.path));
  assert.strictEqual(rows.current(store, 'task', id).worktree.removed_at, null, 'nothing is recorded removed');
  assert.ok(entryFor((await sweep()).removed, id), 'a later sweep removes it once git can');
});

test('a tree git lists on a belay branch that no row records is reported as an orphan and never removed', async () => {
  const p = `${path.dirname(repo)}/${path.basename(repo)}.worktrees/orphan-sw`;
  git(repo, 'worktree', 'add', '-b', 'belay/orphan-sw', '--', p, 'HEAD');
  const out = await sweep();
  const o = out.orphans.find((x) => x.path === p);
  assert.ok(o, JSON.stringify(out.orphans));
  assert.deepStrictEqual([o.branch, o.at_base], ['belay/orphan-sw', true]);
  assert.ok(fs.existsSync(p), 'not removed');
});

test('a run with no trees sweeps to nothing, and the method is the operator\'s only', async () => {
  const out = await call('task.worktreeSweep', { run_id: 'no-such-run' }, op());
  assert.deepStrictEqual([out.removed, out.kept, out.failed, out.integration_kept, out.skipped], [[], [], [], [], null]);
  await rejectsCode(call('task.worktreeSweep', { run_id: 'test-run' }), 'E_ROLE');
  await rejectsCode(sweep({ unproven_workers: 'x' }), 'E_ARGS');
});

test('the sweep stops at its budget and names the trees it did not reach', async () => {
  const a = await treeTask();
  const out = await sweep({ budget_ms: 0 });
  assert.strictEqual(out.skipped, 'budget');
  assert.strictEqual(entryFor(out.kept, a.id).reason, 'budget');
  assert.ok(fs.existsSync(a.w.path));
});

// The HEAD check, last, because the trees it leaves are detached.
test('a detached HEAD keeps the tree; task.worktreeRemove refuses it unless forced', async () => {
  const { id, w } = await treeTask();
  git(w.path, 'checkout', '-q', '--detach');
  write(w.path, 'only-here.txt', 'work\n');
  commit(w.path, 'commit on a detached head');
  const k = entryFor((await sweep()).kept, id);
  assert.strictEqual(k.reason, 'head_off_branch');
  const e = await rejectsCode(call('task.worktreeRemove', { task_id: id }, op()), 'E_PRECONDITION');
  assert.match(e.message, /not on its branch/);
  assert.ok(fs.existsSync(w.path));
  const forced = await call('task.worktreeRemove', { task_id: id, force: true }, op());
  assert.ok(forced.worktree.removed_at, 'force overrides it');
});

test('a tree on another branch than the recorded one is refused by task.worktreeRemove', async () => {
  const { id, w } = await treeTask();
  git(w.path, 'checkout', '-q', '-b', 'somewhere-else');
  const e = await rejectsCode(call('task.worktreeRemove', { task_id: id }, op()), 'E_PRECONDITION');
  assert.match(e.message, /refs\/heads\/somewhere-else/);
  git(w.path, 'checkout', '-q', w.branch);
  assert.ok((await call('task.worktreeRemove', { task_id: id }, op())).worktree.removed_at, 'back on its branch it goes');
});
