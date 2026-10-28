'use strict';
// integration-state.test.cjs — ADR 0053 amendment 2. An integration that stops (a conflict, or a merge that fails) still checks
// what landed before it, so no merged work is left on `into` unchecked, and the row names each task that did not land and why.
// A task's work state stays `done`; whether it landed is `integration` on task.list and task.get, derived from the rows.
// Throwaway repositories under the sandbox only.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { makeRepo, git, write, commit, rejectsCode } = require('./worktree-helpers.cjs');

const { openCore } = core('index.cjs');

let dir, orch, op;

before(async () => {
  dir = sandbox();
  orch = await openCore({ dataDir: `${dir}/data`, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
  op = await openCore({ dataDir: `${dir}/data`, caller: { role: 'operator', run_id: 'cli', pid: process.pid }, embed: false });
});

after(async () => {
  await op.close();
  await orch.shutdownOwner();
  await orch.close();
  cleanup(dir);
});

const exists = (rel) => ({ argv: [process.execPath, '-e', `require('fs').accessSync(${JSON.stringify(rel)})`] });
// Passes in either task's own tree, fails once both a.txt and b.txt are on one tree.
const notBoth = { argv: [process.execPath, '-e', "const f=require('fs');process.exit(f.existsSync('a.txt')&&f.existsSync('b.txt')?1:0)"] };

async function doneTask(repo, files, commands) {
  const t = await orch.task.create({ spec: `write ${Object.keys(files).join(', ')}`, acceptance: { commands } });
  const w = (await op.task.worktreeCreate({ task_id: t.id, repo })).worktree;
  for (const [rel, text] of Object.entries(files)) write(w.path, rel, text);
  commit(w.path, `task ${t.id}`);
  const row = await orch.task.evaluate({ task_id: t.id });
  assert.strictEqual(row.state, 'done', JSON.stringify(row.results));
  return row;
}

const integ = async (id) => (await orch.task.get({ task_id: id })).integration;

test('a conflict checks what landed before it: a failing check on that tree is recorded, and each task shows whether it landed', async () => {
  const repo = makeRepo(dir);
  const a = await doneTask(repo, { 'a.txt': 'a\n', 'base/keep.txt': 'from a\n' }, [notBoth]);
  const a2 = await doneTask(repo, { 'b.txt': 'b\n' }, [notBoth]);
  const b = await doneTask(repo, { 'base/keep.txt': 'from b\n' }, [exists('base/keep.txt')]);
  const c = await doneTask(repo, { 'c.txt': 'c\n' }, [exists('c.txt')]);
  assert.deepStrictEqual(await integ(a.id), { state: 'not_merged', into: null }, 'done and never integrated');

  const row = await orch.integration.merge({ task_ids: [a.id, a2.id, b.id, c.id], into: 'int/stop' });
  assert.strictEqual(row.state, 'conflict');
  assert.strictEqual(row.conflict.task_id, b.id);
  assert.deepStrictEqual(row.merged.map((m) => m.task_id), [a.id, a2.id]);
  assert.deepStrictEqual(row.not_merged, [{ task_id: b.id, reason: 'conflict' }, { task_id: c.id, reason: 'not_tried' }]);
  assert.strictEqual(row.passed, false, 'a and a2 merged together fail their shared check, and the row says so');
  assert.deepStrictEqual(row.checks.map((ch) => [ch.task_ids, ch.exit_code]), [[[a.id, a2.id], 1]]);
  assert.strictEqual(git(row.worktree, 'status', '--porcelain'), '', 'the checks ran on the tree the abort left clean');

  const ia = await integ(a.id);
  assert.deepStrictEqual(ia, { state: 'merged', id: row.id, into: 'int/stop', at: ia.at, head: row.head_sha, passed: false });
  assert.ok(ia.at > 0);
  assert.strictEqual((await integ(b.id)).state, 'conflict');
  assert.strictEqual((await integ(c.id)).state, 'not_merged');
  assert.strictEqual((await integ(c.id)).into, null, 'named but not tried: the integration says nothing about c');
  const listed = (await orch.task.list({})).tasks.find((t) => t.id === b.id);
  assert.strictEqual(listed.state, 'done', 'the work state stays done');
  assert.strictEqual(listed.integration.state, 'conflict', 'task.list carries the same fact as task.get');
});

test('evaluate: false leaves the landed work unchecked, and says so with checks null', async () => {
  const repo = makeRepo(dir);
  const a = await doneTask(repo, { 'base/keep.txt': 'from a\n' }, [exists('base/keep.txt')]);
  const b = await doneTask(repo, { 'base/keep.txt': 'from b\n' }, [exists('base/keep.txt')]);
  const row = await orch.integration.merge({ task_ids: [a.id, b.id], into: 'int/noeval', evaluate: false });
  assert.strictEqual(row.state, 'conflict');
  assert.strictEqual(row.checks, null);
  assert.strictEqual(row.passed, null);
  assert.strictEqual((await integ(a.id)).passed, null);
  // The latest integration that names a task decides: b merged alone later reads merged, no longer conflict.
  const later = await orch.integration.merge({ task_ids: [b.id], into: 'int/b-alone' });
  assert.strictEqual(later.state, 'evaluated');
  const ib = await integ(b.id);
  assert.deepStrictEqual([ib.state, ib.into, ib.passed], ['merged', 'int/b-alone', true]);
});

test('a stopped merge that leaves the tree unclean runs no checks on it: the merged work is left with checks null', async () => {
  const repo = makeRepo(dir);
  // The hook leaves an untracked file behind and refuses, so the abort cannot leave the tree clean.
  const hook = path.join(repo, '.git', 'hooks', 'pre-merge-commit');
  fs.writeFileSync(hook, '#!/bin/sh\nif [ -f junk-trigger.txt ]; then echo x > junk.txt; exit 1; fi\n');
  fs.chmodSync(hook, 0o755);
  const a = await doneTask(repo, { 'a.txt': 'a\n' }, [exists('a.txt')]);
  const b = await doneTask(repo, { 'junk-trigger.txt': 'x\n' }, [exists('junk-trigger.txt')]);
  const row = await orch.integration.merge({ task_ids: [a.id, b.id], into: 'int/unclean' });
  assert.strictEqual(row.state, 'failed', JSON.stringify(row.error));
  assert.strictEqual(row.error.tree_clean, false);
  assert.strictEqual(row.checks, null);
  assert.strictEqual((await integ(a.id)).passed, null);
});

test('a merge that fails without a conflict checks what landed and names the task as failed', async () => {
  const repo = makeRepo(dir);
  // A pre-merge-commit hook that refuses any merge bringing in fail.txt: git's own refusal, not a conflict.
  const hook = path.join(repo, '.git', 'hooks', 'pre-merge-commit');
  fs.writeFileSync(hook, '#!/bin/sh\ntest ! -f fail.txt\n');
  fs.chmodSync(hook, 0o755);
  const a = await doneTask(repo, { 'a.txt': 'a\n' }, [exists('a.txt')]);
  const b = await doneTask(repo, { 'fail.txt': 'x\n' }, [exists('fail.txt')]);
  const row = await orch.integration.merge({ task_ids: [a.id, b.id], into: 'int/hook' });
  assert.strictEqual(row.state, 'failed', JSON.stringify(row.error));
  assert.strictEqual(row.error.task_id, b.id);
  assert.strictEqual(row.error.tree_clean, true);
  assert.deepStrictEqual(row.not_merged, [{ task_id: b.id, reason: 'failed' }]);
  assert.strictEqual(row.passed, true);
  assert.deepStrictEqual(row.checks.map((ch) => ch.task_ids), [[a.id]]);
  assert.strictEqual((await integ(b.id)).state, 'failed');
});

test('a clean integration marks every task merged with the head and the passing checks; tasks with no branch have none', async () => {
  const repo = makeRepo(dir);
  const a = await doneTask(repo, { 'a.txt': 'a\n' }, [exists('a.txt')]);
  const b = await doneTask(repo, { 'b.txt': 'b\n' }, [exists('b.txt')]);
  const open = await orch.task.create({ spec: 'open', acceptance: { commands: [exists('x')] } });
  await op.task.worktreeCreate({ task_id: open.id, repo });
  const bare = await orch.task.create({ spec: 'bare', acceptance: { commands: [exists('x')] } });
  const row = await orch.integration.merge({ task_ids: [a.id, b.id], into: 'int/ok' });
  assert.strictEqual(row.state, 'evaluated');
  assert.deepStrictEqual(row.not_merged, []);
  for (const id of [a.id, b.id]) {
    const i = await integ(id);
    assert.deepStrictEqual([i.state, i.into, i.head, i.passed], ['merged', 'int/ok', row.head_sha, true]);
  }
  assert.strictEqual(await integ(open.id), null, 'not done and never named');
  assert.strictEqual(await integ(bare.id), null, 'no belay branch');
});

test('a removal does not make an older integration decide again: the order is when each integration began', async () => {
  const repo = makeRepo(dir);
  const a = await doneTask(repo, { 'a.txt': 'a\n' }, [exists('a.txt')]);
  const first = await orch.integration.merge({ task_ids: [a.id], into: 'int/p1', evaluate: false });
  assert.strictEqual((await integ(a.id)).passed, null);
  const second = await orch.integration.merge({ task_ids: [a.id], into: 'int/p1' });
  assert.strictEqual(second.passed, true);
  await op.integration.remove({ id: first.id, force: true });
  const ia = await integ(a.id);
  assert.deepStrictEqual([ia.state, ia.id, ia.passed], ['merged', second.id, true], 'the removed first integration does not decide again');
  assert.strictEqual(ia.at, second.written_at);
});

test('a task named but not tried keeps its earlier merge: a later stop on another task does not unmerge it', async () => {
  const repo = makeRepo(dir);
  const a = await doneTask(repo, { 'base/keep.txt': 'from a\n' }, [exists('base/keep.txt')]);
  const b = await doneTask(repo, { 'base/keep.txt': 'from b\n' }, [exists('base/keep.txt')]);
  const first = await orch.integration.merge({ task_ids: [a.id], into: 'int/p2' });
  const row = await orch.integration.merge({ task_ids: [b.id, a.id], into: 'int/p2' });
  assert.strictEqual(row.state, 'conflict');
  assert.deepStrictEqual(row.not_merged, [{ task_id: b.id, reason: 'conflict' }, { task_id: a.id, reason: 'not_tried' }]);
  const ia = await integ(a.id);
  assert.deepStrictEqual([ia.state, ia.into, ia.id], ['merged', 'int/p2', first.id]);
  assert.strictEqual(git(repo, 'merge-base', '--is-ancestor', a.worktree.branch, 'int/p2'), '', 'its commit is on int/p2');
  // Another branch: a's merge there is reported beside it, and a conflict there does not hide the merge into int/p2.
  const elsewhere = await orch.integration.merge({ task_ids: [a.id], into: 'int/p2b' });
  assert.strictEqual(elsewhere.state, 'evaluated');
  const ib = await integ(b.id);
  assert.strictEqual(ib.state, 'conflict');
  const both = await integ(a.id);
  assert.strictEqual(both.state, 'merged');
  assert.strictEqual(both.into, 'int/p2b', 'the newest merge leads');
  assert.deepStrictEqual(both.elsewhere, [{ into: 'int/p2', state: 'merged' }]);
});

test('a merge that throws (a branch deleted) still checks what landed and names the task failed', async () => {
  const repo = makeRepo(dir);
  const a = await doneTask(repo, { 'a.txt': 'a\n' }, [exists('a.txt')]);
  const b = await doneTask(repo, { 'b.txt': 'b\n' }, [exists('b.txt')]);
  await op.task.worktreeRemove({ task_id: b.id });
  git(repo, 'branch', '-D', b.worktree.branch);
  const row = await orch.integration.merge({ task_ids: [a.id, b.id], into: 'int/gone' });
  assert.strictEqual(row.state, 'failed');
  assert.strictEqual(row.error.code, 'E_GIT');
  assert.strictEqual(row.error.task_id, b.id);
  assert.strictEqual(row.error.tree_clean, true);
  assert.deepStrictEqual(row.not_merged, [{ task_id: b.id, reason: 'failed' }]);
  assert.strictEqual(row.passed, true);
  assert.deepStrictEqual(row.checks.map((ch) => ch.task_ids), [[a.id]]);
  assert.strictEqual(row.head_sha, git(row.worktree, 'rev-parse', 'HEAD'));
  assert.strictEqual((await integ(b.id)).state, 'failed');
});

// integrate merges what a task was judged on (ADR 0060 decisions 4 and 6), so a's own later stop is a merge that fails: its
// branch is deleted after the first merge.
test('a merge into a branch stays true against a newer stop on that branch or another, and a removal keeps its time', async () => {
  const repo = makeRepo(dir);
  const a = await doneTask(repo, { 'a.txt': 'a\n' }, [exists('a.txt')]);
  const c = await doneTask(repo, { 'base/keep.txt': 'from c\n' }, [exists('base/keep.txt')]);
  await orch.integration.merge({ task_ids: [a.id], into: 'int/s' });
  const second = await orch.integration.merge({ task_ids: [c.id], into: 'int/s' }); // keeps a on the branch, so it names a too
  git(a.worktree.path, 'checkout', '-q', '--detach');
  git(repo, 'branch', '-q', '-D', a.worktree.branch);
  const stop = await orch.integration.merge({ task_ids: [a.id], into: 'int/s' });
  assert.deepStrictEqual([stop.state, stop.error.task_id], ['failed', a.id]);
  let ia = await integ(a.id);
  assert.deepStrictEqual([ia.state, ia.into, ia.id], ['merged', 'int/s', second.id], 'its merge into int/s stays true, at the newest row that names it on the branch');
  const other = await orch.integration.merge({ task_ids: [c.id, a.id], into: 'int/s2' });
  assert.deepStrictEqual([other.state, other.error.task_id], ['failed', a.id]);
  ia = await integ(a.id);
  assert.deepStrictEqual([ia.state, ia.into], ['merged', 'int/s'], 'a merge leads over a newer failure elsewhere');
  assert.deepStrictEqual(ia.elsewhere, [{ into: 'int/s2', state: 'failed' }]);
  // Removing the tree of int/s2's integration appends a row, which neither moves nor re-times what it says.
  await op.integration.remove({ id: other.id, force: true });
  const ic = await integ(c.id);
  assert.deepStrictEqual([ic.into, ic.id, ic.at], ['int/s2', other.id, other.written_at]);
});

test('two integrations that overlap are ordered by when each began, not when each ended', async () => {
  const repo = makeRepo(dir);
  const marks = `${dir}/marks-overlap`;
  fs.mkdirSync(marks);
  // Holds any merge that brings in block.txt until released, then lets it through.
  const hook = path.join(repo, '.git', 'hooks', 'pre-merge-commit');
  fs.writeFileSync(hook, `#!/bin/sh\nif [ -f block.txt ]; then\n  echo > "${marks}/entered"\n  while [ ! -f "${marks}/release" ]; do sleep 0.1; done\nfi\n`);
  fs.chmodSync(hook, 0o755);
  const t = await doneTask(repo, { 't.txt': 't\n' }, [exists('t.txt')]);
  const blk = await doneTask(repo, { 'block.txt': 'b\n' }, [exists('block.txt')]);
  const early = orch.integration.merge({ task_ids: [t.id, blk.id], into: 'int/o1' });
  const end = Date.now() + 60000;
  while (!fs.existsSync(`${marks}/entered`)) {
    if (Date.now() > end) throw new Error('the hook never held the merge');
    await new Promise((r) => setTimeout(r, 50));
  }
  const late = await orch.integration.merge({ task_ids: [t.id], into: 'int/o2' }); // begins second, ends first
  fs.writeFileSync(`${marks}/release`, '');
  const first = await early;
  assert.strictEqual(first.state, 'evaluated');
  const it = await integ(t.id);
  assert.deepStrictEqual([it.into, it.id], ['int/o2', late.id], 'the integration that began last leads');
  assert.deepStrictEqual(it.elsewhere, [{ into: 'int/o1', state: 'merged' }]);
});

test('integrate refusals say what to do next: a task not done, a task with no belay branch, tasks cut from different bases', async () => {
  const repo = makeRepo(dir);
  const open = await orch.task.create({ spec: 'open', acceptance: { commands: [exists('x')] } });
  await op.task.worktreeCreate({ task_id: open.id, repo });
  const notDone = await rejectsCode(orch.integration.merge({ task_ids: [open.id] }), 'E_PRECONDITION');
  assert.match(notDone.message, /Leave them out, or merge once task_evaluate makes them done/);
  const bare = await orch.task.create({ spec: 'bare', acceptance: { commands: [{ argv: [process.execPath, '-e', ''] }] } });
  await orch.task.evaluate({ task_id: bare.id, worktree: repo });
  const noBranch = await rejectsCode(orch.integration.merge({ task_ids: [bare.id] }), 'E_PRECONDITION');
  assert.deepStrictEqual(noBranch.detail.no_branch, [bare.id]);
  assert.match(noBranch.message, /task_worktree before the coder starts/);
  const a = await doneTask(repo, { 'a.txt': 'a\n' }, [exists('a.txt')]);
  write(repo, 'moved.txt', 'main moves\n');
  commit(repo, 'main moves');
  const b = await doneTask(repo, { 'b.txt': 'b\n' }, [exists('b.txt')]);
  const bases = await rejectsCode(orch.integration.merge({ task_ids: [a.id, b.id], into: 'int/bases' }), 'E_ARGS');
  assert.match(bases.message, /pass base/);
});
