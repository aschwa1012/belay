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

test('a dry run names what it would keep and remove, and removes and writes nothing', async () => {
  const clean = await treeTask();
  const dirty = await treeTask();
  write(dirty.w.path, 'scratch.txt', 'x\n');
  const off = await treeTask();
  git(off.w.path, 'checkout', '-q', '--detach');
  const before = JSON.stringify(rows.currentAll(store, 'task').map((t) => t.worktree));
  const out = await sweep({ dry_run: true });
  assert.strictEqual(out.dry_run, true);
  assert.deepStrictEqual(out.removed, []);
  assert.ok(entryFor(out.would_remove, clean.id), JSON.stringify(out));
  const d = entryFor(out.kept, dirty.id);
  assert.deepStrictEqual([d.reason, d.paths], ['dirty', ['scratch.txt']]);
  assert.strictEqual(entryFor(out.kept, off.id).reason, 'head_off_branch');
  assert.ok(fs.existsSync(clean.w.path) && fs.existsSync(dirty.w.path) && fs.existsSync(off.w.path), 'nothing was removed');
  assert.strictEqual(JSON.stringify(rows.currentAll(store, 'task').map((t) => t.worktree)), before, 'no row was written');
  const real = await sweep();
  assert.ok(entryFor(real.removed, clean.id), 'a real sweep still removes the clean tree');
});

test('a tree dirtied between the check and the removal is kept dirty with its paths, not failed', async () => {
  const { id, w } = await treeTask();
  const real = G.dirtyPaths;
  let calls = 0;
  G.dirtyPaths = async (dir) => { calls += 1; return calls === 1 ? real(dir) : ['late.txt']; }; // clean at the sweep's check, dirty at the removal's
  let out;
  try { out = await sweep(); } finally { G.dirtyPaths = real; }
  const k = entryFor(out.kept, id);
  assert.ok(k, JSON.stringify(out));
  assert.deepStrictEqual([k.reason, k.paths], ['dirty', ['late.txt']]);
  assert.strictEqual(entryFor(out.failed, id), undefined);
  assert.ok(fs.existsSync(w.path));
});
