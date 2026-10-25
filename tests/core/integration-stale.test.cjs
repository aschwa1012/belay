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

// A `merging` row whose recorded process is alive but is not the owner: an owner stopped without exiting, its git still
// running. The row is written beside the owner as that process would have written it, with the holder's real creation time.
test('a merging row whose process still runs refuses the merge and the removal E_BUSY, naming it; once it ends, the merge proceeds', async () => {
  const { Store } = core('store.cjs');
  const rows = core('rows.cjs');
  const ID = core('proc-identity.cjs');
  const { spawn } = require('node:child_process');
  const dir = sandbox();
  const orch = await openCore({ dataDir: `${dir}/data`, caller: callerFor('orchestrator'), embed: false });
  const op = await openCore({ dataDir: `${dir}/data`, caller: { role: 'operator', run_id: 'cli', pid: process.pid }, embed: false });
  opened.push({ dir, cores: [orch, op] });
  await orch.run.attach({ adapter_pid: process.pid });
  const repo = makeRepo(dir);
  const t = await orch.task.create({ spec: 'a', acceptance: { commands: [exists('a.txt')] } });
  const w = (await op.task.worktreeCreate({ task_id: t.id, repo })).worktree;
  write(w.path, 'a.txt', 'a\n');
  commit(w.path, 'a');
  assert.strictEqual((await orch.task.evaluate({ task_id: t.id })).state, 'done');

  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { windowsHide: true, stdio: 'ignore' });
  const holderExited = new Promise((r) => holder.once('exit', r));
  try {
    const c = await ID.createdOf(holder.pid);
    assert.ok(c && c.created, 'the holder\'s creation time is readable');
    const inject = (boot) => {
      const s = new Store(`${dir}/data/memory.db`);
      try {
        return rows.append(s, 'integration', { id: rows.newId(), run_id: 'test-run', repo, into_branch: 'int/live', worktree: `${repo}.worktrees/integrate-int-live`, created_worktree: true, base_sha: w.base_sha, head_sha: w.base_sha, state: 'merging', task_ids: [t.id], merged: [], junctions: [], owner_pid: holder.pid, owner_boot: boot }, 'owner', Date.now());
      } finally { s.close(); }
    };
    const live = inject(c.created);
    const e = await rejectsCode(orch.integration.merge({ task_ids: [t.id], into: 'int/live' }), 'E_BUSY');
    assert.match(e.message, new RegExp(`merging in pid ${holder.pid}, which is still running`));
    assert.strictEqual(e.detail.id, live.id);
    assert.strictEqual((await orch.integration.get({ id: live.id })).state, 'merging', 'a live holder\'s row is not closed');
    await rejectsCode(op.integration.remove({ id: live.id, force: true }), 'E_BUSY');
    // A proven live merge is never taken over, not even by the operator.
    const kept = await rejectsCode(op.integration.merge({ task_ids: [t.id], into: 'int/live', take_over: true }), 'E_BUSY');
    assert.strictEqual(kept.detail.proven, true);

    holder.kill(); // this exact child
    await holderExited;
    const row = await orch.integration.merge({ task_ids: [t.id], into: 'int/live' });
    assert.strictEqual(row.state, 'evaluated', JSON.stringify(row.error));
    assert.strictEqual((await orch.integration.get({ id: live.id })).state, 'abandoned');
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) { holder.kill(); await holderExited; }
  }
});

test('a merging row whose pid now names a process created at another time is taken as gone', async () => {
  const { Store } = core('store.cjs');
  const rows = core('rows.cjs');
  const ID = core('proc-identity.cjs');
  const { spawn } = require('node:child_process');
  const dir = sandbox();
  const orch = await openCore({ dataDir: `${dir}/data`, caller: callerFor('orchestrator'), embed: false });
  const op = await openCore({ dataDir: `${dir}/data`, caller: { role: 'operator', run_id: 'cli', pid: process.pid }, embed: false });
  opened.push({ dir, cores: [orch, op] });
  await orch.run.attach({ adapter_pid: process.pid });
  const repo = makeRepo(dir);
  const t = await orch.task.create({ spec: 'a', acceptance: { commands: [exists('a.txt')] } });
  const w = (await op.task.worktreeCreate({ task_id: t.id, repo })).worktree;
  write(w.path, 'a.txt', 'a\n');
  commit(w.path, 'a');
  assert.strictEqual((await orch.task.evaluate({ task_id: t.id })).state, 'done');
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { windowsHide: true, stdio: 'ignore' });
  const holderExited = new Promise((r) => holder.once('exit', r));
  try {
    const c = await ID.createdOf(holder.pid);
    assert.ok(c && c.created);
    const s = new Store(`${dir}/data/memory.db`);
    let stale;
    try {
      // The row's process started a minute before the one that holds its pid now: the pid was reused.
      stale = rows.append(s, 'integration', { id: rows.newId(), run_id: 'test-run', repo, into_branch: 'int/reused', worktree: `${repo}.worktrees/integrate-int-reused`, created_worktree: true, base_sha: w.base_sha, head_sha: w.base_sha, state: 'merging', task_ids: [t.id], merged: [], junctions: [], owner_pid: holder.pid, owner_boot: c.created - 60000 }, 'owner', Date.now());
    } finally { s.close(); }
    const row = await orch.integration.merge({ task_ids: [t.id], into: 'int/reused' });
    assert.strictEqual(row.state, 'evaluated', JSON.stringify(row.error));
    assert.strictEqual((await orch.integration.get({ id: stale.id })).state, 'abandoned');
  } finally {
    holder.kill();
    await holderExited;
  }
});

// A row whose pid runs but cannot be proven to be the merge: here it recorded no creation time, which reaches the same branch as
// a creation time the snapshot cannot read. Nothing tells anyone to end that pid; only the operator may take the branch over.
test('a merging row not proven to be its live pid refuses with no kill advice; the orchestrator cannot take over, the operator can', async () => {
  const { Store } = core('store.cjs');
  const rows = core('rows.cjs');
  const { spawn } = require('node:child_process');
  const dir = sandbox();
  const orch = await openCore({ dataDir: `${dir}/data`, caller: callerFor('orchestrator'), embed: false });
  const op = await openCore({ dataDir: `${dir}/data`, caller: { role: 'operator', run_id: 'cli', pid: process.pid }, embed: false });
  opened.push({ dir, cores: [orch, op] });
  await orch.run.attach({ adapter_pid: process.pid });
  const repo = makeRepo(dir);
  const t = await orch.task.create({ spec: 'a', acceptance: { commands: [exists('a.txt')] } });
  const w = (await op.task.worktreeCreate({ task_id: t.id, repo })).worktree;
  write(w.path, 'a.txt', 'a\n');
  commit(w.path, 'a');
  assert.strictEqual((await orch.task.evaluate({ task_id: t.id })).state, 'done');
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { windowsHide: true, stdio: 'ignore' });
  const holderExited = new Promise((r) => holder.once('exit', r));
  try {
    const s = new Store(`${dir}/data/memory.db`);
    let unproven;
    try {
      unproven = rows.append(s, 'integration', { id: rows.newId(), run_id: 'test-run', repo, into_branch: 'int/unproven', worktree: `${repo}.worktrees/integrate-int-unproven`, created_worktree: true, base_sha: w.base_sha, head_sha: w.base_sha, state: 'merging', task_ids: [t.id], merged: [], junctions: [], owner_pid: holder.pid, owner_boot: null }, 'owner', Date.now());
    } finally { s.close(); }
    const e = await rejectsCode(orch.integration.merge({ task_ids: [t.id], into: 'int/unproven' }), 'E_BUSY');
    assert.match(e.message, /is running but is not proven to be the merge/);
    assert.match(e.message, /the operator can pass --take-over/);
    assert.doesNotMatch(e.message, /end that process|kill/i, 'never advice to end a pid that may be any process');
    assert.strictEqual(e.detail.proven, false);
    await rejectsCode(op.integration.remove({ id: unproven.id, force: true }), 'E_BUSY');
    await rejectsCode(orch.integration.merge({ task_ids: [t.id], into: 'int/unproven', take_over: true }), 'E_ROLE');
    assert.strictEqual((await orch.integration.get({ id: unproven.id })).state, 'merging');

    // The operator's hand: the built CLI's --take-over closes the row abandoned, marked taken over, and merges.
    // Spawned, never spawnSync: the owner that serves the CLI's call lives in this process and must keep running.
    const cli = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.resolve(__dirname, '..', '..', 'src', 'cli', 'belay.cjs'), 'worktree', 'merge', t.id, '--into', 'int/unproven', '--take-over', '--data', `${dir}/data`, '--json'], { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('exit', (status) => resolve({ status, stdout, stderr }));
    });
    assert.strictEqual(cli.status, 0, cli.stderr);
    assert.strictEqual(JSON.parse(cli.stdout).state, 'evaluated');
    const closed = await orch.integration.get({ id: unproven.id });
    assert.strictEqual(closed.state, 'abandoned');
    assert.strictEqual(closed.error.taken_over, true);
    assert.ok(holder.exitCode === null && holder.signalCode === null, 'the holder was left running');
  } finally {
    holder.kill();
    await holderExited;
  }
});

test('a merge records its owner start time from the process snapshot, the source the check compares it with', async () => {
  const ID = core('proc-identity.cjs');
  const dir = sandbox();
  const orch = await openCore({ dataDir: `${dir}/data`, caller: callerFor('orchestrator'), embed: false });
  const op = await openCore({ dataDir: `${dir}/data`, caller: { role: 'operator', run_id: 'cli', pid: process.pid }, embed: false });
  opened.push({ dir, cores: [orch, op] });
  await orch.run.attach({ adapter_pid: process.pid });
  const repo = makeRepo(dir);
  const t = await orch.task.create({ spec: 'a', acceptance: { commands: [exists('a.txt')] } });
  const w = (await op.task.worktreeCreate({ task_id: t.id, repo })).worktree;
  write(w.path, 'a.txt', 'a\n');
  commit(w.path, 'a');
  assert.strictEqual((await orch.task.evaluate({ task_id: t.id })).state, 'done');
  const row = await orch.integration.merge({ task_ids: [t.id], into: 'int/boot' });
  const own = await ID.createdOf(process.pid);
  assert.ok(own && own.created);
  assert.strictEqual(row.owner_pid, process.pid);
  assert.strictEqual(row.owner_boot, own.created);
});
