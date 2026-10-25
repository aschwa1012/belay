'use strict';
// review-tree.test.cjs — ADR 0054 amendment 1. A reviewer has no Edit or Write, but Bash can still write, so task.evaluate
// reads the reviewer's worktree beside the verdict check: HEAD against the worker row's base_sha, and the uncommitted paths.
// It flags the verdict (detail.tree, detail.tree_changed) and never fails it. Real core, sandbox store, a real git repository.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { openCore } = core('index.cjs');

let dir, orch;
const workers = [];
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
  return { wt, base: git(wt, 'rev-parse', 'HEAD') };
}

before(async () => {
  dir = sandbox();
  orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
});

after(async () => {
  for (const c of workers) await c.close();
  try { await orch.shutdownOwner(); } finally { await orch.close(); cleanup(dir); }
});

// A done work task, a review over it, and a reviewer whose row names `wt` and `base` (HEAD at its spawn); then `between`
// runs (what the reviewer did to the tree) and the reviewer hands back `holds`. Returns the verdict check of the evaluation.
async function review(label, wt, base, between) {
  const t = await orch.task.create({ spec: `${label} work`, acceptance: PASS });
  const coder = `coder-${label}`;
  await orch.worker.write({ id: coder, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: `s-${coder}`, last_event_at: Date.now() });
  const cw = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: coder }), embed: false }); workers.push(cw);
  const a1 = await orch.task.assign({ task_id: t.id, worker_id: coder });
  await cw.lease.release({ lease_id: a1.new_lease.id, reason: 'done' });
  assert.strictEqual((await orch.task.evaluate({ task_id: t.id, worktree: dir })).state, 'done');
  const r = await orch.task.create({ spec: `${label} review`, depends_on: [t.id], acceptance: { verdict: true } });
  const id = `rev-${label}`;
  await orch.worker.write({ id, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: `s-${id}`, last_event_at: Date.now(), worktree: wt, base_sha: base });
  const rw = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: id }), embed: false }); workers.push(rw);
  const a2 = await orch.task.assign({ task_id: r.id, worker_id: id });
  between();
  await rw.lease.release({ lease_id: a2.new_lease.id, reason: 'done', result: { verdict: 'holds', summary: 'fine' } });
  const row = await orch.task.evaluate({ task_id: r.id, worktree: wt });
  return { row, check: row.results.checks.find((c) => c.kind === 'verdict') };
}

test('an untouched tree: the verdict carries the tree, unchanged, and passes', async () => {
  const { wt, base } = repo('clean');
  const { row, check } = await review('clean', wt, base, () => {});
  assert.strictEqual(row.state, 'done');
  assert.strictEqual(check.detail.tree_changed, false);
  assert.deepStrictEqual([check.detail.tree.base_sha, check.detail.tree.head_sha, check.detail.tree.head_moved, check.detail.tree.uncommitted_count], [base, base, false, 0]);
  assert.strictEqual(check.detail.tree.worker_id, 'rev-clean');
});

test('a reviewer\'s uncommitted write is flagged by path, and the verdict still passes: a flag, not a refusal', async () => {
  const { wt, base } = repo('dirty');
  const { row, check } = await review('dirty', wt, base, () => { fs.writeFileSync(path.join(wt, 'a.txt'), 'two\n'); fs.writeFileSync(path.join(wt, 'new.txt'), 'x\n'); });
  assert.strictEqual(row.state, 'done');
  assert.strictEqual(check.passed, true);
  assert.strictEqual(check.detail.tree_changed, true);
  assert.strictEqual(check.detail.tree.head_moved, false);
  assert.deepStrictEqual(check.detail.tree.uncommitted.sort(), ['a.txt', 'new.txt']);
  assert.match(check.detail.tree.note, /2 uncommitted or untracked path\(s\) now \(they may predate the review\)/);
});

test('a commit after the reviewer was spawned is flagged as HEAD moved', async () => {
  const { wt, base } = repo('commit');
  let head;
  const { check } = await review('commit', wt, base, () => {
    fs.writeFileSync(path.join(wt, 'a.txt'), 'three\n');
    git(wt, 'commit', '-q', '-am', 'by the reviewer');
    head = git(wt, 'rev-parse', 'HEAD');
  });
  assert.strictEqual(check.detail.tree_changed, true);
  assert.deepStrictEqual([check.detail.tree.head_moved, check.detail.tree.head_sha, check.detail.tree.uncommitted_count], [true, head, 0]);
  assert.match(check.detail.tree.note, new RegExp(`HEAD moved from ${base.slice(0, 12)} to ${head.slice(0, 12)}`));
});

test('a reviewer row with no base_sha says a commit cannot be seen, and still reports the uncommitted paths', async () => {
  const { wt } = repo('nobase');
  const { check } = await review('nobase', wt, null, () => fs.writeFileSync(path.join(wt, 'b.txt'), 'x\n'));
  assert.strictEqual(check.detail.tree.head_moved, null);
  assert.match(check.detail.tree.error, /no base_sha/);
  assert.deepStrictEqual([check.detail.tree.uncommitted, check.detail.tree_changed], [['b.txt'], true]);
});
