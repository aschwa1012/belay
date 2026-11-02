'use strict';
// worktrees-prune.test.cjs — ADR 0065 amendment 3: the pin that keeps a removed tree's head, the link walk that stops on an error,
// the live-worker guard by real path, and task.worktreePrune (the sweep's removal for runs that lapsed: ended, or every recorded
// process proven gone). Throwaway repositories under the sandbox; the engine runs in this process, so a failing call is a seam.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor, deadPid } = require('./helpers.cjs');
const { makeRepo, git, write, rejectsCode } = require('./worktree-helpers.cjs');

const { Engine } = core('engine.cjs');
const { Store } = core('store.cjs');
const rows = core('rows.cjs');
const G = core('git.cjs');
const ID = core('proc-identity.cjs');

let dir, store, E, repo;
const op = (run = 'cli') => ({ role: 'operator', run_id: run, pid: process.pid });
const orch = (run) => callerFor('orchestrator', { run_id: run });
const call = (method, args, caller) => E.handle(method, { caller, ...args });
const prune = (extra = {}) => call('task.worktreePrune', extra, op());
const sweep = (run, extra = {}) => call('task.worktreeSweep', { run_id: run, ...extra }, op());
const has = (list, id) => list.find((x) => x.task_ids.includes(id));

before(async () => {
  dir = sandbox();
  repo = makeRepo(dir);
  store = new Store(`${dir}/memory.db`);
  E = new Engine({ dataDir: dir, store, getEmbedder: null, owner: null, establishedBy: 'test' });
});
after(() => { store.close(); cleanup(dir); });

let n = 0;
// A run (attached by `adapter` pid as an operator) with one cancelled task and its own tree.
async function runWithTree(runId, { adapter = process.pid, end = false, open = false, setup = null } = {}) {
  await call('run.attach', { adapter_pid: adapter, project_dir: repo }, op(runId));
  const t = await call('task.create', { spec: `prune work ${++n}`, files_owned: [`p${n}`] }, orch(runId));
  const row = await call('task.worktreeCreate', { task_id: t.id, repo }, op(runId));
  if (!open) await call('task.cancel', { task_id: t.id, reason: 'prune test' }, orch(runId));
  const made = { id: t.id, w: row.worktree };
  if (setup) await setup(made);
  if (end) await call('run.end', { exit_reason: 'test' }, op(runId));
  return made;
}
const refsOf = () => git(repo, 'for-each-ref', '--format=%(refname)', 'refs/belay/kept/').split('\n').filter(Boolean);

test('a removed tree leaves its head pinned: the pin survives deleting the branch and a gc', async () => {
  const a = await runWithTree('pin-run', { end: true });
  const head = git(a.w.path, 'rev-parse', 'HEAD');
  write(a.w.path, 'only-here.txt', 'work\n');
  git(a.w.path, 'add', '-A');
  git(a.w.path, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'work in the tree');
  const work = git(a.w.path, 'rev-parse', 'HEAD');
  assert.notStrictEqual(work, head);
  const out = await sweep('pin-run');
  const r = has(out.removed, a.id);
  assert.ok(r, JSON.stringify(out));
  assert.deepStrictEqual(r.kept_by, { ref: `refs/belay/kept/${a.id}/${work.slice(0, 12)}`, sha: work });
  assert.strictEqual(git(repo, 'rev-parse', r.kept_by.ref), work);
  git(repo, 'branch', '-D', '--', a.w.branch);
  git(repo, 'gc', '-q', '--prune=now');
  assert.strictEqual(git(repo, 'cat-file', '-t', work), 'commit', 'the commit survives the branch and a gc');
  assert.strictEqual((await call('task.get', { task_id: a.id }, op())).worktree.kept_by.sha, work, 'the row records the pin');
});

test('a head that cannot be pinned keeps the tree (pin_failed); a forced remove is refused E_GIT; nothing is touched', async () => {
  const a = await runWithTree('pinfail-run', { end: true });
  const real = G.run;
  G.run = async (cwd, args, opts) => (args[0] === 'update-ref' ? { ok: false, argv: ['git', ...args], cwd, exit_code: 128, stdout: '', stderr: 'fatal: cannot lock ref\n' } : real(cwd, args, opts));
  try {
    const k = has((await sweep('pinfail-run')).kept, a.id);
    assert.strictEqual(k && k.reason, 'pin_failed');
    assert.match(k.detail, /could not be pinned/);
    const e = await rejectsCode(call('task.worktreeRemove', { task_id: a.id, force: true }, op()), 'E_GIT');
    assert.strictEqual(e.detail.pin_failed, true);
  } finally { G.run = real; }
  assert.ok(fs.existsSync(a.w.path) && fs.lstatSync(`${a.w.path}/node_modules`).isSymbolicLink(), 'the tree and its junction are as they were');
  assert.strictEqual(rows.current(store, 'task', a.id).worktree.removed_at, null);
  assert.ok(has((await sweep('pinfail-run')).removed, a.id), 'removed once the pin can be written');
});

test('a forced removal of a detached tree pins the detached head', async () => {
  const a = await runWithTree('detached-run', { end: true });
  git(a.w.path, 'checkout', '-q', '--detach');
  write(a.w.path, 'det.txt', 'x\n');
  git(a.w.path, 'add', '-A');
  git(a.w.path, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'detached work');
  const head = git(a.w.path, 'rev-parse', 'HEAD');
  const row = await call('task.worktreeRemove', { task_id: a.id, force: true }, op());
  assert.deepStrictEqual(row.removal.kept_by, { ref: `refs/belay/kept/${a.id}/${head.slice(0, 12)}`, sha: head });
  assert.strictEqual(git(repo, 'cat-file', '-t', head), 'commit');
});

test('an unreadable directory keeps the tree (walk_failed) before anything is unlinked', async () => {
  const a = await runWithTree('walk-run', { end: true });
  write(a.w.path, 'base/deep/x.txt', 'x\n');
  git(a.w.path, 'add', '-A');
  git(a.w.path, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'deeper');
  const real = fs.readdirSync;
  const bad = path.join(a.w.path, 'base', 'deep');
  fs.readdirSync = (p, ...rest) => { if (path.resolve(String(p)) === path.resolve(bad)) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); return real(p, ...rest); };
  try {
    const k = has((await sweep('walk-run')).kept, a.id);
    assert.strictEqual(k && k.reason, 'walk_failed', JSON.stringify(k));
    const e = await rejectsCode(call('task.worktreeRemove', { task_id: a.id }, op()), 'E_PRECONDITION');
    assert.strictEqual(e.detail.walk_failed, true);
  } finally { fs.readdirSync = real; }
  assert.ok(fs.lstatSync(`${a.w.path}/node_modules`).isSymbolicLink(), 'the recorded junction was not unlinked');
  assert.deepStrictEqual(refsOf().filter((r) => r.includes(a.id)), [], 'and no pin was written for a tree that stays');
  assert.ok(has((await sweep('walk-run')).removed, a.id));
});

test('a link belay did not record is unlinked, never followed: the canary beside it survives the removal', async () => {
  const a = await runWithTree('canary-run', { end: true });
  const canary = `${dir}/canary-${n}`;
  write(canary, 'precious.txt', 'keep\n');
  fs.appendFileSync(`${repo}/.git/info/exclude`, `\nstray-link-${n}\n`);
  fs.symlinkSync(canary, `${a.w.path}/stray-link-${n}`, process.platform === 'win32' ? 'junction' : 'dir');
  const r = has((await sweep('canary-run')).removed, a.id);
  assert.ok(r, 'removed');
  assert.ok(r.links_unlinked.some((p) => p.endsWith(`stray-link-${n}`)));
  assert.strictEqual(fs.readFileSync(`${canary}/precious.txt`, 'utf8'), 'keep\n');
  assert.ok(fs.existsSync(`${repo}/node_modules/dep/index.js`), 'nor was the main checkout touched');
});

test('a worker under another spelling of a tree (a junction to it) keeps it; one in a deleted directory only while its run is live', async () => {
  const jp = () => `${dir}/spelling-${n}`;
  const a = await runWithTree('real-run', { setup: async (t) => {
    fs.symlinkSync(t.w.path, jp(), process.platform === 'win32' ? 'junction' : 'dir');
    await call('worker.write', { id: 'pr-spelled', substrate: 'claude-code', pid: process.pid, state: 'running', worktree: jp() }, orch('real-run'));
  } });
  let k = has((await sweep('real-run')).kept, a.id);
  assert.strictEqual(k && k.reason, 'live_worker', JSON.stringify(k));
  await call('worker.write', { id: 'pr-spelled', substrate: 'claude-code', pid: null, state: 'stopped', worktree: jp() }, orch('real-run'));
  // The directory below the junction is gone: it resolves nowhere, but its nearest existing ancestor is the tree.
  await call('worker.write', { id: 'pr-vanished', substrate: 'claude-code', pid: null, state: 'paused', paused_by: 't', paused_at: Date.now(), worktree: `${jp()}/gone/deeper` }, orch('real-run'));
  k = has((await sweep('real-run')).kept, a.id);
  assert.strictEqual(k && k.reason, 'path_unresolved', JSON.stringify(k));
  assert.ok(fs.existsSync(a.w.path));
  await call('run.end', { exit_reason: 'test' }, op('real-run'));
  assert.ok(has((await sweep('real-run')).removed, a.id), 'the same row of an ended run blocks nothing');
});

test('a stale parked row with a deleted directory elsewhere blocks an unrelated tree nowhere', async () => {
  const a = await runWithTree('stale-run', { end: true, setup: () => call('worker.write', { id: 'pr-stale', substrate: 'claude-code', pid: null, state: 'paused', paused_by: 't', paused_at: Date.now(), worktree: `${dir}/nowhere-at-all/x` }, orch('stale-run')) });
  assert.ok(has((await sweep('stale-run')).removed, a.id));
});

test('prune: a preview removes and writes nothing; --yes removes a lapsed run\'s tree with the pin; a live run\'s tree is kept whole', async () => {
  const ended = await runWithTree('pr-ended', { end: true });
  const live = await runWithTree('pr-live', { end: false });
  const before = store.p('SELECT COUNT(*) AS c FROM task').get().c + store.p('SELECT COUNT(*) AS c FROM run').get().c;
  const refsBefore = refsOf();
  const p = await prune();
  assert.strictEqual(p.dry_run, true);
  assert.ok(has(p.would_remove, ended.id), JSON.stringify(p));
  assert.strictEqual(has(p.kept, live.id).reason, 'run_not_lapsed');
  assert.deepStrictEqual(p.runs.filter((r) => r.run_id === 'pr-live').map((r) => r.lapsed), [false]);
  assert.ok(fs.existsSync(ended.w.path) && fs.existsSync(live.w.path), 'nothing removed');
  assert.strictEqual(store.p('SELECT COUNT(*) AS c FROM task').get().c + store.p('SELECT COUNT(*) AS c FROM run').get().c, before, 'no row written');
  assert.deepStrictEqual(refsOf(), refsBefore, 'no pin written');
  const y = await prune({ yes: true });
  const r = has(y.removed, ended.id);
  assert.ok(r, JSON.stringify(y));
  assert.strictEqual(r.run_id, 'pr-ended');
  assert.strictEqual(r.kept_by.sha, git(repo, 'rev-parse', `refs/heads/${ended.w.branch}`));
  assert.ok(!fs.existsSync(ended.w.path) && fs.existsSync(live.w.path));
  assert.strictEqual(has(y.kept, live.id).reason, 'run_not_lapsed');
});

test('prune: a run is lapsed when its row is unended but every process it recorded is proven gone; not on the adapter alone', async () => {
  const dead = await runWithTree('pr-dead', { adapter: deadPid() });
  await call('run.attach', { adapter_pid: deadPid() }, orch('pr-dead')); // the orchestrator's adapter over the run process
  const one = await runWithTree('pr-one', { adapter: deadPid() }); // one recorded process: no evidence of a run process
  const real = ID.processSnapshot;
  const mine = process.pid;
  const runner = await runWithTree('pr-runner2', { adapter: mine }); // the run process still answers, with no creation time to compare
  await call('run.attach', { adapter_pid: deadPid() }, orch('pr-runner2'));
  ID.processSnapshot = async () => new Map([[mine, { ppid: 1, created: Date.now(), image: 'node.exe' }]]);
  let p;
  try { p = await prune(); } finally { ID.processSnapshot = real; }
  assert.ok(has(p.would_remove, dead.id), JSON.stringify(p.kept));
  assert.deepStrictEqual(p.runs.find((r) => r.run_id === 'pr-dead'), { run_id: 'pr-dead', lapsed: true, reason: 'run_dead' });
  assert.strictEqual(has(p.kept, one.id).reason, 'run_not_lapsed');
  assert.strictEqual(p.runs.find((r) => r.run_id === 'pr-one').reason, 'runner_unrecorded');
  assert.strictEqual(has(p.kept, runner.id).reason, 'run_not_lapsed');
  assert.strictEqual(p.runs.find((r) => r.run_id === 'pr-runner2').reason, 'process_unproven');
  ID.processSnapshot = async () => null; // an unreadable snapshot proves nothing either
  try { p = await prune({ run_id: 'pr-runner2' }); } finally { ID.processSnapshot = real; }
  assert.strictEqual(has(p.kept, runner.id).reason, 'run_not_lapsed');
});

test('prune --yes keeps every tree the sweep keeps: dirty, parked worker, open task, off-branch HEAD', async () => {
  const dirty = await runWithTree('pk-dirty', { end: true });
  write(dirty.w.path, 'scratch.txt', 'x\n');
  const parked = await runWithTree('pk-parked', { end: true, setup: (t) => call('worker.write', { id: 'pk-parked-w', substrate: 'claude-code', pid: null, state: 'paused', paused_by: 't', paused_at: Date.now(), worktree: t.w.path }, orch('pk-parked')) });
  const open = await runWithTree('pk-open', { end: true, open: true });
  const off = await runWithTree('pk-off', { end: true });
  git(off.w.path, 'checkout', '-q', '--detach');
  const y = await prune({ yes: true });
  for (const [t, why] of [[dirty, 'dirty'], [parked, 'parked_worker'], [open, 'task_open'], [off, 'head_off_branch']]) {
    assert.strictEqual(has(y.kept, t.id) && has(y.kept, t.id).reason, why, `${t.id}: ${JSON.stringify(y.kept.filter((k) => k.task_ids.includes(t.id)))}`);
    assert.ok(fs.existsSync(t.w.path), `${t.id} is still there`);
  }
  assert.deepStrictEqual(refsOf().filter((r) => [dirty, parked, open, off].some((t) => r.includes(t.id))), [], 'a kept tree is not pinned');
});

test('prune: a run revived after it was judged lapsed is not swept (the recheck before each tree)', async () => {
  const a = await runWithTree('pr-revive', { end: true });
  const seq = rows.current(store, 'run', 'pr-revive').seq;
  await call('run.attach', { adapter_pid: process.pid, project_dir: repo }, op('pr-revive')); // a new life, its process answering
  const k = has((await sweep('pr-revive', { lapsed_seq: seq })).kept, a.id);
  assert.strictEqual(k && k.reason, 'run_not_lapsed', JSON.stringify(k));
  assert.ok(fs.existsSync(a.w.path));
});

test('prune is the operator\'s only, and a bad argument is refused', async () => {
  await rejectsCode(call('task.worktreePrune', { yes: true }, orch('pr-ended')), 'E_ROLE');
  await rejectsCode(prune({ yes: 'yes' }), 'E_ARGS');
  await rejectsCode(prune({ run_id: '' }), 'E_ARGS');
});
