'use strict';
// worktree-pilot.test.cjs — the pilot's path through tools alone (ADR 0053): an orchestrator with no shell makes two tasks, gives
// each its own tree, spawns a real (fake-substrate) worker into each by task_id alone, is refused removing a tree a live worker
// is in, stops the workers, evaluates each task from its recorded tree and base, integrates both, and removes the trees, the
// repository's node_modules surviving every junction unlink. The commits stand in for the workers' edits (the fake writes none).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { launch, sandboxDir, ROOT } = require('./rpc.cjs');
const { makeRepo, write, commit } = require('../core/worktree-helpers.cjs');

const FAKE_CLAUDE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;
const USER_SETTINGS = `${ROOT}/tests/run/fixtures/user-settings.json`;

const ok = (r) => { assert.strictEqual(r.isError, false, JSON.stringify(r.structuredContent || r.content)); return r.structuredContent; };
const refused = (r, code) => { assert.strictEqual(r.isError, true, 'expected a refusal'); const b = JSON.parse(r.content[0].text); assert.strictEqual(b.error, code, b.message); return b; };
const same = (x, y) => String(x).replace(/\\/g, '/').toLowerCase() === String(y).replace(/\\/g, '/').toLowerCase();


// The run records its project directory before the adapter attaches, as `belay run` does; the adapter's own attach carries it.
async function recordProject(data, run, repo) {
  const { openCore } = require('../../src/core/index.cjs');
  const c = await openCore({ dataDir: data, caller: { role: 'operator', run_id: run, pid: process.pid }, embed: false });
  try { await c.run.attach({ adapter_pid: process.pid, project_dir: repo }); } finally { await c.shutdownOwner(); await c.close(); }
}

test('pilot path: task, worktree, spawn by task_id, evaluate, integrate, remove, through tools only', { timeout: 300000 }, async (t) => {
  const box = sandboxDir('wt-pilot');
  const repo = makeRepo(box);
  await recordProject(`${box}/data`, 'run-1', repo);
  const a = launch({
    role: 'orchestrator', data: `${box}/data`, fake: false, noEmbed: true,
    env: { BELAY_FAKE_PATHS: JSON.stringify({ claudeExe: FAKE_CLAUDE, codexExe: FAKE_CLAUDE, userSettings: USER_SETTINGS }) },
  });
  t.after(async () => { await a.close(); a.kill(); fs.rmSync(box, { recursive: true, force: true }); });
  await a.initialize();

  const check = (f) => ({ argv: [process.execPath, '-e', `require('fs').accessSync('${f}')`] });
  const tasks = [];
  for (const f of ['a.txt', 'b.txt']) {
    tasks.push(ok(await a.call('task_create', { spec: `write ${f}`, files_owned: [f], acceptance: { commands: [check(f)], files_within_owned: true } })));
  }
  // The adapter's run has no project directory (a `belay run` records one), so the repository is named.
  const trees = [];
  for (const task of tasks) trees.push(ok(await a.call('task_worktree', { task_id: task.id, repo }, 60000)).worktree);

  const workers = [];
  for (const task of tasks) workers.push(ok(await a.call('worker_spawn', { substrate: 'claude-code', prompt: 'do it', task_id: task.id }, 60000)));
  workers.forEach((w, i) => assert.ok(same(w.worktree, trees[i].path), `worker ${w.id} runs in ${w.worktree}, not its task's tree ${trees[i].path}`));
  refused(await a.call('task_worktree', { task_id: tasks[0].id, action: 'remove', force: true }, 60000), 'E_WORKER_LIVE');

  ['a.txt', 'b.txt'].forEach((f, i) => { write(trees[i].path, f, `${f}\n`); commit(trees[i].path, f); });
  for (const w of workers) ok(await a.call('worker_stop', { worker_id: w.id, mode: 'kill' }, 60000));

  for (const task of tasks) {
    const ev = ok(await a.call('task_evaluate', { task_id: task.id }, 60000));
    assert.strictEqual(ev.state, 'done', JSON.stringify(ev.results));
    const own = ev.results.checks.find((c) => c.kind === 'files_within_owned').detail;
    assert.strictEqual(own.base_source, 'recorded');
    assert.strictEqual(own.empty_range, false);
  }
  const merged = ok(await a.call('integrate', { task_ids: tasks.map((x) => x.id) }, 120000));
  assert.strictEqual(merged.state, 'evaluated', JSON.stringify(merged));
  assert.strictEqual(merged.passed, true);
  assert.deepStrictEqual(merged.merged.map((m) => m.task_id), tasks.map((x) => x.id));
  for (const f of ['a.txt', 'b.txt']) assert.ok(fs.existsSync(path.join(merged.worktree, f)));

  for (const task of tasks) {
    const removed = ok(await a.call('task_worktree', { task_id: task.id, action: 'remove' }, 60000));
    assert.ok(removed.worktree.removed_at > 0);
    assert.ok(!fs.existsSync(removed.worktree.path));
  }
  assert.ok(fs.existsSync(path.join(repo, 'node_modules', 'dep', 'index.js')), 'the repository node_modules survives every unlink');
});
