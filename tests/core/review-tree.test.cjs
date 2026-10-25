'use strict';
// review-tree.test.cjs — ADR 0054 amendment 1. A reviewer can write (Edit, Write, Bash). belay snapshots the
// reviewer's worktree at the review lease's grant, again at the hand-back, and stores the comparison in the handoff, which
// the verdict check shows (detail.tree, detail.tree_changed) without failing the verdict. Only a change made while the
// review lease was held is flagged: never the coder's leftovers, a commit before the grant, or a fixer after the hand-back.
// Real core, sandbox store, real git repositories.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { openCore } = core('index.cjs');

let dir, orch;
const cores = new Map();
const PASS = { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] };

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

function repo(label) {
  const wt = path.join(dir, `repo-${label}`).split('\\').join('/');
  fs.mkdirSync(wt);
  git(wt, 'init', '-q');
  fs.writeFileSync(path.join(wt, 'a.txt'), 'one\n');
  git(wt, 'add', 'a.txt');
  git(wt, 'commit', '-q', '-m', 'base');
  return wt;
}

before(async () => {
  dir = sandbox();
  orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
});

after(async () => {
  for (const c of cores.values()) await c.close();
  try { await orch.shutdownOwner(); } finally { await orch.close(); cleanup(dir); }
});

async function worker(id, wt) {
  if (!cores.has(id)) {
    await orch.worker.write({ id, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: `s-${id}`, last_event_at: Date.now(), worktree: wt });
    cores.set(id, await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: id }), embed: false }));
  }
  return cores.get(id);
}

async function doneWork(label, wt, dependsOn = []) {
  const t = await orch.task.create({ spec: `${label} work`, acceptance: PASS, ...(dependsOn.length ? { depends_on: dependsOn } : {}) });
  const c = await worker(`coder-${label}`, wt);
  const a = await orch.task.assign({ task_id: t.id, worker_id: `coder-${label}` });
  await c.lease.release({ lease_id: a.new_lease.id, reason: 'done' });
  assert.strictEqual((await orch.task.evaluate({ task_id: t.id, worktree: wt })).state, 'done');
  return t;
}

// A review of `work` by `reviewer`: grant, then `during()` (what happens while the lease is held), then the hand-back.
async function review(work, reviewer, wt, during = () => {}, verdict = 'holds') {
  const r = await orch.task.create({ spec: `review ${work.id}`, depends_on: [work.id], acceptance: { verdict: true } });
  const rc = await worker(reviewer, wt);
  const a = await orch.task.assign({ task_id: r.id, worker_id: reviewer });
  assert.ok(a.new_lease.tree && a.new_lease.tree.head, 'the grant snapshot is on the lease');
  assert.strictEqual(a.new_lease.tree.entries, undefined, 'the answer carries the head and count only');
  during();
  await rc.lease.release({ lease_id: a.new_lease.id, reason: 'done', result: { verdict, summary: 'judged' } });
  const row = await orch.task.evaluate({ task_id: r.id, worktree: wt });
  return { r, row, check: row.results.checks.find((c) => c.kind === 'verdict') };
}

test('an untouched tree is unchanged; an uncommitted write during the lease is flagged by path; the verdict still passes', async () => {
  const wt = repo('basic');
  const w = await doneWork('basic', wt);
  const clean = await review(w, 'rev-basic', wt);
  assert.strictEqual(clean.row.state, 'done');
  assert.strictEqual(clean.check.detail.tree_changed, false);
  assert.strictEqual(clean.check.detail.tree.head_moved, false);
  const w2 = await doneWork('basic2', wt);
  const dirty = await review(w2, 'rev-basic2', wt, () => { fs.writeFileSync(path.join(wt, 'a.txt'), 'two\n'); fs.writeFileSync(path.join(wt, 'new.txt'), 'x\n'); });
  assert.strictEqual(dirty.check.passed, true, 'a flag, not a refusal');
  assert.strictEqual(dirty.check.detail.tree_changed, true);
  assert.deepStrictEqual(dirty.check.detail.tree.changed_paths, ['a.txt', 'new.txt']);
  assert.match(dirty.check.detail.tree.note, /2 uncommitted or untracked path\(s\) changed while the review lease was held/);
});

test('a commit during the lease is HEAD moved', async () => {
  const wt = repo('commit');
  const w = await doneWork('commit', wt);
  const base = git(wt, 'rev-parse', 'HEAD');
  let head;
  const { check } = await review(w, 'rev-commit', wt, () => { fs.writeFileSync(path.join(wt, 'a.txt'), 'three\n'); git(wt, 'commit', '-q', '-am', 'by the reviewer'); head = git(wt, 'rev-parse', 'HEAD'); });
  assert.deepStrictEqual([check.detail.tree_changed, check.detail.tree.head_moved, check.detail.tree.head_at_grant, check.detail.tree.head_at_release], [true, true, base, head]);
});

test('the coder\'s uncommitted leftovers are not the reviewer\'s; a further edit to one during the lease is', async () => {
  const wt = repo('left');
  fs.writeFileSync(path.join(wt, 'a.txt'), 'coder left this\n');
  fs.writeFileSync(path.join(wt, 'scratch.txt'), 'untracked leftover\n');
  const w = await doneWork('left', wt);
  const left = await review(w, 'rev-left', wt);
  assert.strictEqual(left.check.detail.tree_changed, false, 'leftovers present at the grant are not flagged');
  const w2 = await doneWork('left2', wt);
  const edited = await review(w2, 'rev-left2', wt, () => fs.writeFileSync(path.join(wt, 'scratch.txt'), 'the reviewer changed the leftover, and its size\n'));
  assert.deepStrictEqual([edited.check.detail.tree_changed, edited.check.detail.tree.changed_paths], [true, ['scratch.txt']]);
});

test('a reviewer spawned before the coder\'s last commit, and reused across a fix round, is never flagged; a re-evaluate after a fixer starts keeps the hand-back\'s answer', async () => {
  const wt = repo('rounds');
  await worker('rev-rounds', wt); // the reviewer's row exists before the coder's last commit
  fs.writeFileSync(path.join(wt, 'a.txt'), 'the coder\'s last change\n');
  git(wt, 'commit', '-q', '-am', 'coder last commit');
  const w = await doneWork('rounds', wt);
  const first = await review(w, 'rev-rounds', wt, () => {}, 'refuted');
  assert.strictEqual(first.check.detail.tree_changed, false, 'the commit before the grant is not the reviewer\'s');
  // The fixer starts: a commit and an uncommitted change, after the hand-back. The refuted review is evaluated again.
  fs.writeFileSync(path.join(wt, 'a.txt'), 'fixed\n');
  git(wt, 'commit', '-q', '-am', 'fix');
  fs.writeFileSync(path.join(wt, 'wip.txt'), 'fixer in progress\n');
  const again = await orch.task.evaluate({ task_id: first.r.id, worktree: wt });
  assert.strictEqual(again.results.checks.find((c) => c.kind === 'verdict').detail.tree_changed, false, 'the fixer\'s work after the hand-back is not flagged');
  fs.rmSync(path.join(wt, 'wip.txt'));
  const fix = await doneWork('rounds-fix', wt, [w.id]);
  const second = await review(fix, 'rev-rounds', wt); // the same reviewer, the next round
  assert.strictEqual(second.check.detail.tree_changed, false, 'a reused reviewer is snapshotted at its new grant');
});

test('a hand-back with no result, or a lease that is not a review\'s, carries no tree', async () => {
  const wt = repo('none');
  const w = await doneWork('none', wt);
  const t = await orch.task.create({ spec: 'plain work, not a review', acceptance: PASS });
  const c = await worker('plain-none', wt);
  const a = await orch.task.assign({ task_id: t.id, worker_id: 'plain-none' });
  assert.ok(a.new_lease.tree == null, 'only a review lease is snapshotted');
  const rel = await c.lease.release({ lease_id: a.new_lease.id, reason: 'done', result: { branch: 'b' } });
  assert.ok(rel.handoff.tree == null);
  const r = await orch.task.create({ spec: 'review', depends_on: [w.id], acceptance: { verdict: true } });
  const rc = await worker('rev-none', wt);
  const a2 = await orch.task.assign({ task_id: r.id, worker_id: 'rev-none' });
  const rel2 = await rc.lease.release({ lease_id: a2.new_lease.id, reason: 'no result yet' });
  assert.ok(!rel2.handoff, 'no hand-back, so no tree');
});

test('a probe written in the reviewer\'s scratch folder does not flag; its size is on the hand-back; past 50 MB it is flagged, never cut', async () => {
  const RS = require('../../src/run/review-scratch.cjs');
  const wt = repo('scratch');
  const w = await doneWork('scratch', wt);
  const scratch = RS.ensure(dir, 'rev-scratch', 'test-run');
  assert.ok(scratch, 'the scratch folder was made');
  const probe = await review(w, 'rev-scratch', wt, () => fs.writeFileSync(path.join(scratch, 'probe.cjs'), 'console.log("C:\\path")\n'));
  assert.strictEqual(probe.check.detail.tree_changed, false, 'the scratch folder is outside the tree');
  assert.deepStrictEqual([probe.check.detail.scratch.path, probe.check.detail.scratch.files, probe.check.detail.scratch_over_limit], [scratch, 1, false]);
  assert.ok(probe.check.detail.scratch.bytes > 0);
  const w2 = await doneWork('scratch2', wt);
  const big = RS.ensure(dir, 'rev-big', 'test-run');
  assert.ok(big, 'the scratch folder was made');
  const large = await review(w2, 'rev-big', wt, () => { const fd = fs.openSync(path.join(big, 'big.bin'), 'w'); fs.ftruncateSync(fd, 51 * 1024 * 1024); fs.closeSync(fd); });
  assert.strictEqual(large.check.passed, true, 'the size is a flag, not a refusal');
  assert.deepStrictEqual([large.check.detail.scratch_over_limit, large.check.detail.scratch.bytes], [true, 51 * 1024 * 1024]);
  assert.ok(fs.existsSync(path.join(big, 'big.bin')), 'nothing is cut');
});

test('a grant cancelled before its snapshot is attached keeps no snapshot: the attach reads the lease again and discards it', async () => {
  const RT = require('../../src/core/review-tree.cjs');
  const wt = repo('discard');
  const w = await doneWork('discard', wt);
  const r = await orch.task.create({ spec: 'review to be cancelled', depends_on: [w.id], acceptance: { verdict: true } });
  await worker('rev-discard', wt);
  const real = RT.snapshot;
  RT.snapshot = async (dir) => { const s = await real(dir); await orch.task.cancel({ task_id: r.id, reason: 'cancelled before the snapshot landed' }); return s; };
  let a;
  try { a = await orch.task.assign({ task_id: r.id, worker_id: 'rev-discard' }); } finally { RT.snapshot = real; }
  assert.ok(a.new_lease.tree == null, 'the answer carries no snapshot');
  const lease = (await orch.task.get({ task_id: r.id })).lease;
  assert.strictEqual(lease, null, 'the cancel released the lease');
});

// A seam on the snapshot (afterGrant calls it through the export): `during` runs after the grant committed, before the attach.
async function withSnapshotSeam(during, fn) {
  const RT = require('../../src/core/review-tree.cjs');
  const real = RT.snapshot;
  RT.snapshot = async (dir) => { const s = await real(dir); await during(); return s; };
  try { return await fn(); } finally { RT.snapshot = real; }
}

test('a snapshot taken after the reviewer had already acted under the lease is baseline_late, and the hand-back counts it as changed', async () => {
  const wt = repo('late');
  const w = await doneWork('late', wt);
  const r = await orch.task.create({ spec: 'late review', depends_on: [w.id], acceptance: { verdict: true } });
  const rc = await worker('rev-late', wt);
  let a;
  await withSnapshotSeam(async () => {
    await orch.worker.write({ id: 'rev-late', last_event_at: Date.now() + 5 });
    const lease = (await orch.task.get({ task_id: r.id })).lease;
    await rc.continuity.checkpoint({ task_id: r.id, worker_id: 'rev-late', turn: 1, files_touched: [], tool_digest: [], lease_id: lease && lease.id });
  }, async () => { a = await orch.task.assign({ task_id: r.id, worker_id: 'rev-late' }); });
  await rc.lease.release({ lease_id: a.new_lease.id, reason: 'done', result: { verdict: 'holds', summary: 'judged' } });
  const check = (await orch.task.evaluate({ task_id: r.id, worktree: wt })).results.checks.find((c) => c.kind === 'verdict');
  assert.strictEqual(check.detail.tree_changed, true, 'treated as changed although the tree did not change');
  assert.strictEqual(check.detail.tree.baseline_late, true);
  assert.ok(check.detail.tree.baseline_late_by.includes('last_event_at'), JSON.stringify(check.detail.tree.baseline_late_by));
  assert.ok(check.detail.tree.baseline_late_by.includes('checkpoint'), JSON.stringify(check.detail.tree.baseline_late_by));
  assert.match(check.detail.tree.note, /taken after the worker had acted under the lease/);
  assert.strictEqual(check.passed, true, 'a flag, not a refusal');
  const w2 = await doneWork('late2', wt);
  const quiet = await review(w2, 'rev-late2', wt);
  assert.strictEqual(quiet.check.detail.tree.baseline_late, undefined, 'a quiet grant is not late');
});

test('a snapshot that throws leaves the committed grant standing; the answer names the error and the hand-back says no snapshot was attached', async () => {
  const RT = require('../../src/core/review-tree.cjs');
  const wt = repo('throw');
  const w = await doneWork('throw', wt);
  const r = await orch.task.create({ spec: 'review with a failing snapshot', depends_on: [w.id], acceptance: { verdict: true } });
  const rc = await worker('rev-throw', wt);
  const real = RT.snapshot;
  RT.snapshot = async () => { throw new Error('git vanished'); };
  let a;
  try { a = await orch.task.assign({ task_id: r.id, worker_id: 'rev-throw' }); } finally { RT.snapshot = real; }
  assert.strictEqual(a.task.state, 'assigned', 'the grant stands');
  assert.match(a.new_lease.tree.error, /not attached: git vanished/);
  const rel = await rc.lease.release({ lease_id: a.new_lease.id, reason: 'done', result: { verdict: 'holds', summary: 'judged' } });
  assert.deepStrictEqual(rel.handoff.tree, { changed: null, error: 'no grant snapshot was attached' });
  const check = (await orch.task.evaluate({ task_id: r.id, worktree: wt })).results.checks.find((c) => c.kind === 'verdict');
  assert.strictEqual(check.detail.tree_changed, null, 'unknown, not unchanged');
});

test('P1: a running reviewer that asks the core and writes between the grant and the attach leaves a core_call trace: baseline_late', async () => {
  const wt = repo('p1');
  const w = await doneWork('p1', wt);
  const r = await orch.task.create({ spec: 'p1 review', depends_on: [w.id], acceptance: { verdict: true } });
  const rc = await worker('rev-p1', wt);
  await rc.task.list({}); // a running worker, busy before the grant: its earlier calls are not late
  let a;
  await withSnapshotSeam(async () => {
    await rc.task.get({ task_id: r.id }); // it sees its lease before assign answers
    fs.writeFileSync(path.join(wt, 'a.txt'), 'written before the baseline\n');
  }, async () => { a = await orch.task.assign({ task_id: r.id, worker_id: 'rev-p1' }); });
  await rc.lease.release({ lease_id: a.new_lease.id, reason: 'done', result: { verdict: 'holds', summary: 'judged' } });
  const check = (await orch.task.evaluate({ task_id: r.id, worktree: wt })).results.checks.find((c) => c.kind === 'verdict');
  assert.deepStrictEqual([check.detail.tree.baseline_late, check.detail.tree.baseline_late_by, check.detail.tree_changed], [true, ['core_call'], true]);
});

test('P0: a running reviewer that did not call the core in the window is not late', async () => {
  const wt = repo('p0');
  const w = await doneWork('p0', wt);
  const rc = await worker('rev-p0', wt);
  await rc.task.list({});
  const quiet = await review(w, 'rev-p0', wt);
  assert.strictEqual(quiet.check.detail.tree.baseline_late, undefined);
  assert.strictEqual(quiet.check.detail.tree_changed, false);
});

test('a hand-back whose snapshot is not of the granted tree says there is no hand-back snapshot', async () => {
  const RT = require('../../src/core/review-tree.cjs');
  const wt = repo('p3');
  const w = await doneWork('p3', wt);
  const r = await orch.task.create({ spec: 'p3 review', depends_on: [w.id], acceptance: { verdict: true } });
  const rc = await worker('rev-p3', wt);
  const a = await orch.task.assign({ task_id: r.id, worker_id: 'rev-p3' });
  const real = RT.snapshot;
  RT.snapshot = async (dir) => ({ ...(await real(dir)), worktree: `${dir}-elsewhere` });
  let rel;
  try { rel = await rc.lease.release({ lease_id: a.new_lease.id, reason: 'done', result: { verdict: 'holds', summary: 'judged' } }); } finally { RT.snapshot = real; }
  assert.deepStrictEqual(rel.handoff.tree, { changed: null, error: 'no hand-back snapshot' });
});

test('lateBy: an engine that started after the grant cannot know the worker\'s calls and says owner_changed', () => {
  const RT = require('../../src/core/review-tree.cjs');
  const store = { p: () => ({ get: () => undefined, all: () => [] }) }; // no worker row, no checkpoint, no permission, no event
  const lease = { granted_at: 1000, holder: 'w' };
  assert.deepStrictEqual(RT.lateBy({ store, startedAt: 1500, workerCalls: new Map([['w', 1200]]) }, lease), ['owner_changed']);
  assert.deepStrictEqual(RT.lateBy({ store, startedAt: 500, workerCalls: new Map([['w', 1200]]) }, lease), ['core_call']);
  assert.deepStrictEqual(RT.lateBy({ store, startedAt: 500, workerCalls: new Map([['w', 900]]) }, lease), [], 'a call before the grant is not late');
});
