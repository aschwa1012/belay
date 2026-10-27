'use strict';
// worktrees-sweep-cut.test.cjs — task.worktreeSweep when it is cut, counts what goes with a tree, meets a tree git no longer
// lists or one already gone, and leaves a tree the disk kept. The engine runs in this process, so a held or failing git call is a
// seam on git.cjs and nothing is locked for real.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { makeRepo, git, write } = require('./worktree-helpers.cjs');

const { Engine } = core('engine.cjs');
const { Store } = core('store.cjs');
const rows = core('rows.cjs');
const G = core('git.cjs');

let dir, store, E, repo;
const orch = () => callerFor('orchestrator');
const op = () => ({ role: 'operator', run_id: 'cli', pid: process.pid });
const call = (method, args, caller = orch()) => E.handle(method, { caller, ...args });
const sweep = (extra = {}) => call('task.worktreeSweep', { run_id: 'test-run', ...extra }, op());
const entryFor = (list, id) => list.find((x) => x.task_ids.includes(id));

before(async () => {
  dir = sandbox();
  repo = makeRepo(dir);
  store = new Store(`${dir}/memory.db`);
  E = new Engine({ dataDir: dir, store, getEmbedder: null, owner: null, establishedBy: 'test' });
  await call('run.attach', { adapter_pid: process.pid, project_dir: repo });
});
after(() => { store.close(); cleanup(dir); });

let n = 0;
async function treeTask() {
  const t = await call('task.create', { spec: `cut ${++n}`, files_owned: [`c${n}`] });
  const row = await call('task.worktreeCreate', { task_id: t.id, repo }, op());
  return { id: t.id, w: row.worktree };
}
const end = (id) => call('task.cancel', { task_id: id, reason: 'sweep test' });

test('a cancel while a removal is in flight lets that tree finish, leaves the next alone and names it interrupted', async () => {
  const a = await treeTask();
  const b = await treeTask();
  await end(a.id); await end(b.id);
  const real = G.run;
  let entered, release;
  const inGit = new Promise((r) => { entered = r; });
  const hold = new Promise((r) => { release = r; });
  let held = false;
  G.run = async (cwd, args, opts) => {
    if (!held && args[0] === 'worktree' && args[1] === 'remove') { held = true; entered(); await hold; }
    return real(cwd, args, opts);
  };
  let out;
  try {
    const running = sweep();
    await inGit; // the first removal is inside git, held
    const c = await call('task.worktreeSweepCancel', { run_id: 'test-run' }, op());
    assert.strictEqual(c.cancel_requested, true);
    release();
    out = await running;
  } finally { G.run = real; release(); }
  assert.strictEqual(out.skipped, 'interrupted');
  assert.ok(entryFor(out.removed, a.id), 'the tree in flight was finished');
  assert.notStrictEqual(rows.current(store, 'task', a.id).worktree.removed_at, null, 'and recorded before the call returned');
  assert.strictEqual(entryFor(out.kept, b.id).reason, 'interrupted');
  assert.ok(fs.existsSync(b.w.path) && rows.current(store, 'task', b.id).worktree.removed_at === null);
  assert.ok(entryFor((await sweep()).removed, b.id), 'the flag is spent: a later sweep runs whole');
});

test('the receipt counts the ignored files that go with a tree', async () => {
  fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '*.log\n');
  const { id, w } = await treeTask();
  write(w.path, 'build/out.log', 'x\n');
  await end(id);
  const r = entryFor((await sweep()).removed, id);
  assert.strictEqual(r.ignored_removed.count, 1);
  assert.deepStrictEqual(r.ignored_removed.first, ['build/out.log']);
});

test('a path git no longer lists is kept (not_listed), a path already gone is reported and neither is removed; no row is written', async () => {
  const unlisted = await treeTask();
  const gone = await treeTask();
  await end(unlisted.id); await end(gone.id);
  fs.rmSync(path.join(repo, '.git', 'worktrees', path.basename(unlisted.w.path)), { recursive: true, force: true });
  fs.unlinkSync(path.join(gone.w.path, 'node_modules'));
  fs.rmSync(gone.w.path, { recursive: true, force: true });
  const out = await sweep();
  assert.strictEqual(entryFor(out.kept, unlisted.id).reason, 'not_listed');
  assert.strictEqual(entryFor(out.kept, gone.id).reason, 'already_gone');
  assert.ok(!entryFor(out.removed, unlisted.id) && !entryFor(out.removed, gone.id));
  assert.ok(fs.existsSync(unlisted.w.path));
  for (const x of [unlisted, gone]) assert.strictEqual(rows.current(store, 'task', x.id).worktree.removed_at, null, 'the row is untouched');
});

test('a tree git dropped but the disk kept is failed as LEFTOVER, its row stays active, and worktree remove can still finish it', async () => {
  const { id, w } = await treeTask();
  await end(id);
  const real = G.run;
  G.run = async (cwd, args, opts) => {
    const r = await real(cwd, args, opts);
    if (args[0] === 'worktree' && args[1] === 'remove' && r.ok) { fs.mkdirSync(w.path, { recursive: true }); fs.writeFileSync(path.join(w.path, 'held.txt'), 'x'); }
    return r;
  };
  let out;
  try { out = await sweep(); } finally { G.run = real; }
  const f = entryFor(out.failed, id);
  assert.strictEqual(f.code, 'LEFTOVER');
  assert.strictEqual(f.leftover, true);
  assert.strictEqual(rows.current(store, 'task', id).worktree.removed_at, null, 'the row says the tree is still there');
  const row = await call('task.worktreeRemove', { task_id: id }, op());
  assert.ok(row.worktree.removed_at, 'the operator\'s later remove is not E_NOT_FOUND');
});
