'use strict';
// integration-case.test.cjs — integration.remove takes the same lock key as the merge it must exclude. A merge into a branch
// spelled with a capital (a run id such as `Up`) holds its lock under the folded name on a case-insensitive host, so a removal
// of the merging row is refused E_BUSY, its row stays `merging`, and its tree stays. A git hook holds the merge in flight.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor, stopOwnerProcesses } = require('./helpers.cjs');
const { makeRepo, write, commit, rejectsCode, stageRuns } = require('./worktree-helpers.cjs');

const { openCore } = core('index.cjs');
const opened = [];
after(async () => {
  for (const { dir, cores } of opened) {
    for (const c of cores.slice(1)) await c.close().catch(() => {});
    if (cores[0]) { await cores[0].shutdownOwner().catch(() => {}); await cores[0].close().catch(() => {}); }
    await stopOwnerProcesses(`${dir}/data`);
    cleanup(dir);
  }
});

const exists = (rel) => ({ argv: [process.execPath, '-e', `require('fs').accessSync(${JSON.stringify(rel)})`] });

async function until(file, ms = 60000) {
  const end = Date.now() + ms;
  while (!fs.existsSync(file)) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${file}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function removeDuringMerge(runId, force) {
  const dir = sandbox();
  const orch = await openCore({ dataDir: `${dir}/data`, caller: callerFor('orchestrator'), embed: false });
  const op = await openCore({ dataDir: `${dir}/data`, caller: { role: 'operator', run_id: 'cli', pid: process.pid }, embed: false });
  opened.push({ dir, cores: [orch, op] });
  await orch.run.attach({ adapter_pid: process.pid });
  await stageRuns(`${dir}/data`, [runId]);
  const repo = makeRepo(dir);
  const marks = `${dir}/marks`;
  fs.mkdirSync(marks);
  const hook = path.join(repo, '.git', 'hooks', 'pre-merge-commit');
  fs.writeFileSync(hook, `#!/bin/sh\nif [ -f block.txt ]; then\n  echo > "${marks}/entered"\n  while [ ! -f "${marks}/release" ]; do sleep 0.1; done\nfi\nexit 0\n`);
  fs.chmodSync(hook, 0o755);
  const tasks = [];
  for (const f of ['a.txt', 'block.txt']) {
    const t = await orch.task.create({ spec: f, acceptance: { commands: [exists(f)] } });
    const w = (await op.task.worktreeCreate({ task_id: t.id, repo })).worktree;
    write(w.path, f, 'x\n');
    commit(w.path, t.id);
    assert.strictEqual((await orch.task.evaluate({ task_id: t.id })).state, 'done');
    tasks.push(t);
  }
  const into = `belay/integrate/${runId}`;
  const pending = orch.integration.merge({ task_ids: tasks.map((t) => t.id), into });
  await until(`${marks}/entered`);
  try {
    const row = (await op.integration.list({})).integrations.find((r) => r.into_branch === into);
    assert.strictEqual(row.state, 'merging');
    await rejectsCode(op.integration.remove({ id: row.id, ...(force ? { force: true } : {}) }), 'E_BUSY');
    assert.strictEqual((await op.integration.get({ id: row.id })).state, 'merging', 'the live merge\'s row is not closed');
    assert.ok(fs.existsSync(row.worktree), 'the live merge\'s tree stays');
  } finally {
    fs.writeFileSync(`${marks}/release`, '');
  }
  const done = await pending;
  assert.strictEqual(done.state, 'evaluated', JSON.stringify(done.error));
}

test('a removal during a merge into a lower-case branch is refused E_BUSY (the control)', async () => {
  await removeDuringMerge('up', false);
});

test('a removal during a merge into a branch with a capital is refused E_BUSY, forced or not, and the merge finishes', async () => {
  await removeDuringMerge('Up', false);
  await removeDuringMerge('Upf', true);
});
