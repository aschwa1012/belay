'use strict';
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

test('task_worktree, worker_spawn, task_evaluate and integrate drive one task from its own tree to a merged, re-checked branch', async (t) => {
  const box = sandboxDir('wt-tools');
  const repo = makeRepo(box);
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
