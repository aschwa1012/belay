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

test('close_pending: a live worker the close will end does not hide a dirty or off-branch tree, and the real sweep is unchanged', async () => {
  const dirty = await treeTask();
  write(dirty.w.path, 'wip.txt', 'x\n');
  const off = await treeTask();
  git(off.w.path, 'checkout', '-q', '--detach');
  const clean = await treeTask();
  const parked = await treeTask();
  write(parked.w.path, 'wip.txt', 'x\n');
  for (const [name, t] of [['cp-dirty', dirty], ['cp-off', off], ['cp-clean', clean]]) {
    await call('worker.write', { id: name, substrate: 'claude-code', pid: process.pid, state: 'running', worktree: t.w.path });
  }
  await call('worker.write', { id: 'cp-parked', substrate: 'claude-code', pid: null, state: 'paused', paused_by: 'test', paused_at: Date.now(), worktree: parked.w.path });
  const plain = await sweep({ dry_run: true });
  assert.strictEqual(entryFor(plain.kept, dirty.id).reason, 'live_worker', 'without close_pending the live worker still keeps it');
  const out = await sweep({ dry_run: true, close_pending: true });
  assert.deepStrictEqual([entryFor(out.kept, dirty.id).reason, entryFor(out.kept, dirty.id).paths], ['dirty', ['wip.txt']]);
  assert.strictEqual(entryFor(out.kept, off.id).reason, 'head_off_branch');
  assert.ok(entryFor(out.would_remove, clean.id), JSON.stringify(out));
  assert.strictEqual(entryFor(out.kept, parked.id).reason, 'parked_worker', 'a parked worker holds the close, so it still keeps its tree');
  const real = await sweep();
  assert.strictEqual(entryFor(real.kept, dirty.id).reason, 'live_worker');
  assert.strictEqual(entryFor(real.kept, clean.id).reason, 'live_worker');
  for (const bad of [{ close_pending: true }, { dry_run: true, close_pending: 'yes' }]) await rejectsCode(sweep(bad), 'E_ARGS');
  for (const n of ['cp-dirty', 'cp-off', 'cp-clean', 'cp-parked']) await call('worker.write', { id: n, substrate: 'claude-code', pid: null, state: 'dead' });
});

test('the pre-close notice over a real plan: an idle worker in a dirty or off-branch tree is named, a clean tree is not', async () => {
  const { createPreCloseNotice } = require('../../src/run/pre-close-wake.cjs');
  const mine = new Set(); // earlier tests leave trees in this run: the plan is the real one, narrowed to this test's tasks
  const notice = (runId) => createPreCloseNotice({ core: { task: { worktreeSweep: async (a) => { const p = await call('task.worktreeSweep', a, op()); return { ...p, kept: p.kept.filter((k) => k.task_ids.some((i) => mine.has(i))) }; } } }, runId });
  const mk = async (runId, prep) => {
    const t = await call('task.create', { spec: `pc ${++n}`, files_owned: [`p${n}`] });
    await call('run.attach', { adapter_pid: process.pid, project_dir: repo, run_id: runId }).catch(() => {});
    const row = await call('task.worktreeCreate', { task_id: t.id, repo }, op());
    await call('task.cancel', { task_id: t.id, reason: 'pre-close test' });
    prep(row.worktree.path);
    await call('worker.write', { id: `pc-${n}`, substrate: 'claude-code', pid: process.pid, state: 'running', worktree: row.worktree.path });
    mine.add(t.id);
    return { id: t.id, path: row.worktree.path, wid: `pc-${n}` };
  };
  const a = await mk('test-run', (p) => write(p, 'wip.txt', 'x\n'));
  const b = await mk('test-run', (p) => git(p, 'checkout', '-q', '--detach'));
  const c = await mk('test-run', () => {});
  const r = await notice('test-run').check();
  assert.ok(r.ran && r.wake, JSON.stringify(r));
  assert.match(r.wake.text, /wip\.txt/);
  assert.ok(r.wake.text.includes(a.path) && r.wake.text.includes(b.path), r.wake.text);
  assert.ok(!r.wake.text.includes(c.path), 'a clean tree with an idle worker is not named');
  for (const x of [a, b, c]) await call('worker.write', { id: x.wid, substrate: 'claude-code', pid: null, state: 'dead' });
});
