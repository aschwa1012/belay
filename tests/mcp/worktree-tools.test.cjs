'use strict';
require('../helpers/tmp.cjs'); // every test process gets its own spawn register and tmp cleanup (tests/helpers/tmp.cjs), however it is run
// worktree-tools.test.cjs — ADR 0053 decision 6 through the real adapter and the real core: task_worktree creates and removes a
// task's tree, worker_spawn takes the task's tree when worktree is left out and refuses another one, task_evaluate defaults to
// the recorded tree and base, and integrate merges and re-checks. The repository is a throwaway one in the test's sandbox.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { launch, sandboxDir } = require('./rpc.cjs');
const { makeRepo, write, commit } = require('../core/worktree-helpers.cjs');

const ok = (r) => { assert.strictEqual(r.isError, false, JSON.stringify(r.structuredContent || r.content)); return r.structuredContent; };
const refused = (r, code) => { assert.strictEqual(r.isError, true, 'expected a refusal'); const b = JSON.parse(r.content[0].text); assert.strictEqual(b.error, code, b.message); return b; };


// The run records its project directory before the adapter attaches, as `belay run` does; the adapter's own attach carries it.
async function recordProject(data, run, repo) {
  const { openCore } = require('../../src/core/index.cjs');
  const c = await openCore({ dataDir: data, caller: { role: 'operator', run_id: run, pid: process.pid }, embed: false });
  try { await c.run.attach({ adapter_pid: process.pid, project_dir: repo }); } finally { await c.shutdownOwner(); await c.close(); }
}

test('task_worktree, worker_spawn, task_evaluate and integrate drive one task from its own tree to a merged, re-checked branch', async (t) => {
  const box = sandboxDir('wt-tools');
  const repo = makeRepo(box);
  await recordProject(`${box}/data`, 'run-1', repo);
  const a = launch({ role: 'orchestrator', data: `${box}/data`, fake: false });
  t.after(async () => { await a.close(); a.kill(); fs.rmSync(box, { recursive: true, force: true }); });
  await a.initialize();
  const names = (await a.list()).map((x) => x.name);
  assert.ok(names.includes('task_worktree') && names.includes('integrate'));

  const check = { argv: [process.execPath, '-e', "require('fs').accessSync('a.txt')"] };
  const task = ok(await a.call('task_create', { spec: 'write a.txt', files_owned: ['a.txt'], acceptance: { commands: [check], files_within_owned: true } }));
  // The adapter's run has no project directory, so the repository is named (an argument the listing does not advertise).
  const made = ok(await a.call('task_worktree', { task_id: task.id, repo }, 60000));
  const w = made.worktree;
  assert.strictEqual(made.base, w.base_sha, 'the reply names the base the tree was made from, not a null');
  assert.strictEqual(w.branch, `belay/${task.id}`);
  assert.ok(fs.existsSync(w.path));

  refused(await a.call('worker_spawn', { substrate: 'claude-code', prompt: 'x', task_id: task.id, worktree: repo }), 'E_ARGS');
  const other = ok(await a.call('task_create', { spec: 'no tree' }));
  refused(await a.call('worker_spawn', { substrate: 'claude-code', prompt: 'x', task_id: other.id }), 'E_ARGS');
  refused(await a.call('worker_spawn', { substrate: 'claude-code', prompt: 'x' }), 'E_ARGS');

  write(w.path, 'a.txt', 'a\n');
  commit(w.path, 'a');
  const evaluated = ok(await a.call('task_evaluate', { task_id: task.id }, 60000));
  assert.strictEqual(evaluated.state, 'done', JSON.stringify(evaluated.results));
  assert.strictEqual(evaluated.results.checks.find((c) => c.kind === 'files_within_owned').detail.base_source, 'recorded');

  const merged = ok(await a.call('integrate', { task_ids: [task.id] }, 60000));
  assert.strictEqual(merged.state, 'evaluated');
  assert.strictEqual(merged.passed, true);
  assert.ok(fs.existsSync(path.join(merged.worktree, 'a.txt')));

  const removed = ok(await a.call('task_worktree', { task_id: task.id, action: 'remove' }, 60000));
  assert.ok(removed.worktree.removed_at > 0);
  assert.ok(!fs.existsSync(w.path));
  refused(await a.call('task_worktree', { task_id: task.id, action: 'drop' }), 'E_ARGS');
});

test('worker_spawn for a review task starts the reviewer in the reviewed task\'s tree, and says why when there is none', async (t) => {
  const box = sandboxDir('wt-review');
  const repo = makeRepo(box);
  await recordProject(`${box}/data`, 'run-1', repo);
  const a = launch({ role: 'orchestrator', data: `${box}/data`, fake: false });
  t.after(async () => { await a.close(); a.kill(); fs.rmSync(box, { recursive: true, force: true }); });
  await a.initialize();
  const work = ok(await a.call('task_create', { spec: 'write a.txt', files_owned: ['a.txt'], acceptance: { files_within_owned: true } }));
  const bare = ok(await a.call('task_create', { spec: 'no tree', files_owned: ['b.txt'], acceptance: { files_within_owned: true } }));
  const rv = ok(await a.call('task_create', { id: 'rv-bare', spec: 'review it', depends_on: [bare.id], acceptance: { verdict: true } }));
  const gone = refused(await a.call('worker_spawn', { substrate: 'claude-code', prompt: 'x', task_id: rv.id }), 'E_ARGS');
  assert.match(gone.message, /reviews no task that has a belay worktree/);
  assert.strictEqual(gone.detail.missing, 'worktree');

  const made = ok(await a.call('task_worktree', { task_id: work.id, repo }, 60000));
  const rw = ok(await a.call('task_create', { id: 'rv-work', spec: 'review it', depends_on: [work.id], acceptance: { verdict: true } }));
  const r = await a.call('worker_spawn', { substrate: 'claude-code', prompt: 'x', task_id: rw.id });
  const text = JSON.stringify(r.structuredContent || r.content);
  assert.match(text, /E_DEPENDENCY_OPEN/, "past the worktree stage, the spawn stops at the open dependency (nothing launched)");
  assert.ok(!/needs worktree|reviews no task|trees, so no one tree/.test(text), `the reviewed tree ${made.worktree.path} was not resolved: ${text}`);
});

test('worker_spawn for a review whose reviewed tree was removed says the tree was removed, not that there is none', async (t) => {
  const box = sandboxDir('wt-review-removed');
  const repo = makeRepo(box);
  await recordProject(`${box}/data`, 'run-1', repo);
  const a = launch({ role: 'orchestrator', data: `${box}/data`, fake: false });
  t.after(async () => { await a.close(); a.kill(); fs.rmSync(box, { recursive: true, force: true }); });
  await a.initialize();
  const work = ok(await a.call('task_create', { spec: 'write a.txt', files_owned: ['a.txt'], acceptance: { files_within_owned: true } }));
  ok(await a.call('task_worktree', { task_id: work.id, repo }, 60000));
  ok(await a.call('task_worktree', { task_id: work.id, action: 'remove' }, 60000));
  const rv = ok(await a.call('task_create', { id: 'rv-removed', spec: 'review it', depends_on: [work.id], acceptance: { verdict: true } }));
  const b = refused(await a.call('worker_spawn', { substrate: 'claude-code', prompt: 'x', task_id: rv.id }), 'E_ARGS');
  assert.match(b.message, /was removed, so there is no tree to start the reviewer in/);
  assert.ok(!/reviews no task/.test(b.message));
});
