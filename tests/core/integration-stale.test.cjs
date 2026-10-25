'use strict';
// integration-stale.test.cjs — ADR 0053 amendment 2: an integration whose owner process ends mid-merge leaves a `merging` row.
// It reads stale (its recorded pid is gone), and it never blocks the branch for good: the next merge or removal of that branch,
// holding the one lock every merge into it holds, closes it `abandoned`, and a tree it left mid-merge is refused with the way
// out. The owner runs in its own process and is ended by its exact child handle while a git hook holds the merge; that is the
// crash under test. Throwaway repositories under the sandbox only.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor, startOwnerProcess, stopOwnerProcesses } = require('./helpers.cjs');
const { makeRepo, git, write, commit, rejectsCode } = require('./worktree-helpers.cjs');

const { openCore } = core('index.cjs');
const opened = [];
after(async () => {
  for (const { dir, cores } of opened) {
    for (const c of cores.slice(1)) await c.close().catch(() => {});
    await cores[0].shutdownOwner().catch(() => {});
    await cores[0].close().catch(() => {});
    await stopOwnerProcesses(`${dir}/data`);
    cleanup(dir);
  }
});

const exists = (rel) => ({ argv: [process.execPath, '-e', `require('fs').accessSync(${JSON.stringify(rel)})`] });

// Waits for a file the hook writes: the real event, polled, bounded.
async function until(file, ms = 60000) {
  const end = Date.now() + ms;
  while (!fs.existsSync(file)) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${file}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

// An owner in its own process merges [a, b]; a hook holds b's merge until released, and the owner is ended meanwhile.
async function crashMidMerge(into) {
  const dir = sandbox();
  const owner = await startOwnerProcess(`${dir}/data`);
  const orch = await openCore({ dataDir: `${dir}/data`, caller: callerFor('orchestrator'), embed: false });
  const op = await openCore({ dataDir: `${dir}/data`, caller: { role: 'operator', run_id: 'cli', pid: process.pid }, embed: false });
  opened.push({ dir, cores: [orch, op] });
  await orch.run.attach({ adapter_pid: process.pid });
  const repo = makeRepo(dir);
  const marks = `${dir}/marks`;
  fs.mkdirSync(marks);
  const hook = path.join(repo, '.git', 'hooks', 'pre-merge-commit');
  fs.writeFileSync(hook, `#!/bin/sh\nif [ -f block.txt ]; then\n  echo > "${marks}/entered"\n  while [ ! -f "${marks}/release" ]; do sleep 0.1; done\n  echo > "${marks}/exited"\n  exit 1\nfi\n`);
  fs.chmodSync(hook, 0o755);
  const tasks = [];
  for (const files of [{ 'a.txt': 'a\n' }, { 'block.txt': 'b\n' }]) {
    const t = await orch.task.create({ spec: Object.keys(files)[0], acceptance: { commands: [exists(Object.keys(files)[0])] } });
    const w = (await op.task.worktreeCreate({ task_id: t.id, repo })).worktree;
    for (const [rel, text] of Object.entries(files)) write(w.path, rel, text);
    commit(w.path, t.id);
    assert.strictEqual((await orch.task.evaluate({ task_id: t.id })).state, 'done');
    tasks.push(t);
  }
  const pending = orch.integration.merge({ task_ids: tasks.map((t) => t.id), into }).then(() => null, (e) => e);
  await until(`${marks}/entered`);
  const ownerPid = owner.child.pid;
  owner.child.kill(); // the crash: this exact child, never a match by name
  await owner.exited;
  const lost = await pending;
  assert.ok(lost, 'the merge call did not return a row: its owner ended');
  fs.writeFileSync(`${marks}/release`, '');
  await until(`${marks}/exited`);
  const left = (await orch.integration.list({})).integrations.find((r) => r.into_branch === into);
  // git still finishes after its hook; wait for its index lock to go before the tree is read.
  const gitDir = git(left.worktree, 'rev-parse', '--absolute-git-dir');
  const end = Date.now() + 30000;
  while (fs.existsSync(path.join(gitDir, 'index.lock')) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return { orch, op, repo, hook, tasks, left, ownerPid };
}

test('a crash mid-merge reads stale; the next merge closes it abandoned and refuses its tree with the way out; then it merges', async () => {
  const { orch, op, hook, tasks: [a, b], left, ownerPid } = await crashMidMerge('int/crash');
  assert.strictEqual(left.state, 'merging');
  assert.strictEqual(left.owner_pid, ownerPid);
  assert.strictEqual(left.stale, true, 'its recorded owner pid is gone');
  const ia = (await orch.task.get({ task_id: a.id })).integration;
  assert.deepStrictEqual([ia.state, ia.stale], ['merging', true]);

  const e = await rejectsCode(orch.integration.merge({ task_ids: [a.id, b.id], into: 'int/crash' }), 'E_PRECONDITION');
  assert.match(e.message, /abandoned mid-merge here: run git merge --abort/);
  assert.deepStrictEqual(e.detail.abandoned, [left.id]);
  assert.strictEqual((await orch.integration.get({ id: left.id })).state, 'abandoned');
  assert.strictEqual((await orch.task.get({ task_id: a.id })).integration.state, 'abandoned');

  await op.integration.remove({ id: left.id, force: true });
  fs.unlinkSync(hook);
  const row = await orch.integration.merge({ task_ids: [a.id, b.id], into: 'int/crash' });
  assert.strictEqual(row.state, 'evaluated', JSON.stringify(row.error));
  assert.strictEqual(row.passed, true);
  assert.deepStrictEqual(row.merged.map((m) => [m.task_id, m.already]), [[a.id, true], [b.id, false]], 'a landed before the crash, unrecorded; now it is checked');
  assert.strictEqual((await orch.task.get({ task_id: a.id })).integration.state, 'merged');
});

test('a removal of a stale merging row closes it abandoned and removes its tree', async () => {
  const { op, left } = await crashMidMerge('int/crash2');
  assert.strictEqual(left.stale, true);
  const out = await op.integration.remove({ id: left.id, force: true });
  assert.ok(out.removed_at > 0);
  assert.strictEqual(out.state, 'abandoned');
  assert.ok(!fs.existsSync(left.worktree));
});
