'use strict';
// git-hooks.test.cjs — belay's merge and worktree add run the repository's git hooks. A rejection names the hook and its output
// tail, a real conflict stays a conflict, and a hook that changed the merged files is reported, never blocked or reverted.
// Real git in throwaway repositories, with real hook scripts (git runs them through its bundled sh).

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { makeRepo, git, write, commit, rejectsCode } = require('./worktree-helpers.cjs');

const { openCore } = core('index.cjs');
const H = core('git-hooks.cjs');
const J = core('judged.cjs');

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

// A real hook script in the repository's hooks directory; git runs it through its own sh.
function hook(repo, name, lines) {
  const p = path.join(repo, '.git', 'hooks', name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, ['#!/bin/sh', ...lines, ''].join('\n'), { mode: 0o755 });
}

async function doneTask(repo, files) {
  const t = await orch.task.create({ spec: `write ${Object.keys(files).join(', ')}`, acceptance: { commands: [exists(Object.keys(files)[0])] } });
  const w = (await op.task.worktreeCreate({ task_id: t.id, repo })).worktree;
  for (const [rel, text] of Object.entries(files)) write(w.path, rel, text);
  commit(w.path, `task ${t.id}`);
  const row = await orch.task.evaluate({ task_id: t.id });
  assert.strictEqual(row.state, 'done', JSON.stringify(row.results));
  return row;
}

test('a pre-merge-commit hook that exits 1 is named, with its output tail, and the tree is left clean', async () => {
  const repo = makeRepo(dir);
  const a = await doneTask(repo, { 'a.txt': 'a\n' });
  hook(repo, 'pre-merge-commit', ['echo "lint: a.txt is not allowed" >&2', 'exit 1']);
  const row = await orch.integration.merge({ task_ids: [a.id], into: 'int/pre' });
  assert.strictEqual(row.state, 'failed');
  assert.strictEqual(row.conflict, null);
  assert.match(row.error.message, /your pre-merge-commit hook rejected the merge of task /);
  assert.ok(row.error.message.includes(a.id));
  assert.match(row.error.message, /lint: a\.txt is not allowed/);
  assert.strictEqual(row.error.hook_rejected.hook, 'pre-merge-commit');
  assert.strictEqual(row.error.tree_clean, true);
  assert.strictEqual(row.error.aborted, true);
});

test('a commit-msg hook that exits 1 is named as commit-msg, not as the merge hook', async () => {
  const repo = makeRepo(dir);
  const a = await doneTask(repo, { 'a.txt': 'a\n' });
  hook(repo, 'pre-merge-commit', ['exit 0']);
  hook(repo, 'commit-msg', ['echo "subject must not name belay" >&2', 'exit 1']);
  const row = await orch.integration.merge({ task_ids: [a.id], into: 'int/msg' });
  assert.strictEqual(row.state, 'failed');
  assert.match(row.error.message, /your commit-msg hook rejected the merge of task /);
  assert.match(row.error.message, /subject must not name belay/);
});

test('a post-checkout hook that fails on worktree add is named, and the half-made tree and branch are removed', async () => {
  const repo = makeRepo(dir);
  hook(repo, 'post-checkout', ['echo "no new trees today" >&2', 'exit 1']);
  const t = await orch.task.create({ spec: 'x', acceptance: { commands: [exists('a.txt')] } });
  const e = await rejectsCode(op.task.worktreeCreate({ task_id: t.id, repo }), 'E_GIT');
  assert.match(e.message, /your post-checkout hook rejected the worktree for task /);
  assert.match(e.message, /no new trees today/);
  assert.strictEqual(e.detail.hook, 'post-checkout');
  assert.ok(e.detail.rollback.worktree_removed);
  assert.strictEqual(git(repo, 'branch', '--list', `belay/${t.id}`), '');
});

test('a post-merge hook that amends the merge commit is reported with the files, and the amended merge stands', async () => {
  const repo = makeRepo(dir);
  const a = await doneTask(repo, { 'a.txt': 'a\n' });
  hook(repo, 'post-merge', [
    'unset GIT_INDEX_FILE', 'export GIT_INDEX_FILE="$(git rev-parse --git-dir)/hook-index"', 'git read-tree HEAD',
    'blob=$(echo stamped | git hash-object -w --stdin)', 'git update-index --add --cacheinfo 100644,$blob,a.txt',
    'c=$(git commit-tree $(git write-tree) -p HEAD^1 -p HEAD^2 -m amended)', 'git update-ref HEAD $c', 'rm -f "$GIT_INDEX_FILE"',
  ]);
  const row = await orch.integration.merge({ task_ids: [a.id], into: 'int/rewrite' });
  assert.notStrictEqual(row.state, 'failed', JSON.stringify(row.error));
  const h = row.hook_changed_tree;
  assert.ok(h, 'hook_changed_tree is on the result');
  assert.strictEqual(h.task_id, a.id);
  assert.deepStrictEqual(h.files, ['a.txt']);
  assert.deepStrictEqual(h.uncommitted_files, ['a.txt'], 'the work tree still holds the unamended file');
  assert.strictEqual(h.merged_tree, git(row.worktree, 'rev-parse', 'HEAD^{tree}'));
  assert.notStrictEqual(h.judged_tree, h.merged_tree);
  assert.strictEqual(git(row.worktree, 'rev-parse', 'HEAD'), row.head_sha, 'the amended merge stands');
  assert.deepStrictEqual(row.merged[0].hook_changed_tree, h);
  // judged.cjs reads a tree without running hooks: the rewriting hook leaves its hash alone.
  const t = await orch.task.get({ task_id: a.id });
  const j = await J.stateOf(t, t.worktree.path);
  assert.strictEqual(j.tree_sha, git(t.worktree.path, 'rev-parse', 'HEAD^{tree}'));
});

test('a pre-merge-commit hook that edits a file leaves it uncommitted, and the report names it', async () => {
  const repo = makeRepo(dir);
  const a = await doneTask(repo, { 'a.txt': 'a\n' });
  hook(repo, 'pre-merge-commit', ['echo "stamped" >> a.txt']);
  const row = await orch.integration.merge({ task_ids: [a.id], into: 'int/edit' });
  assert.notStrictEqual(row.state, 'failed', JSON.stringify(row.error));
  const h = row.hook_changed_tree;
  assert.ok(h);
  assert.deepStrictEqual(h.files, []);
  assert.deepStrictEqual(h.uncommitted_files, ['a.txt']);
  assert.strictEqual(h.judged_tree, h.merged_tree);
});

test('a real merge conflict is still a conflict when hooks exist', async () => {
  const repo = makeRepo(dir);
  const a = await doneTask(repo, { 'base/keep.txt': 'from a\n' });
  const b = await doneTask(repo, { 'base/keep.txt': 'from b\n' });
  hook(repo, 'pre-merge-commit', ['grep -q "from b" base/keep.txt && exit 1', 'exit 0']);
  const row = await orch.integration.merge({ task_ids: [a.id, b.id], into: 'int/conflict' });
  assert.strictEqual(row.state, 'conflict');
  assert.strictEqual(row.conflict.task_id, b.id);
  assert.deepStrictEqual(row.conflict.files, ['base/keep.txt']);
  assert.strictEqual(row.error, null);
});

test('with no hooks nothing changes: a clean merge carries no hook field', async () => {
  const repo = makeRepo(dir);
  const a = await doneTask(repo, { 'a.txt': 'a\n' });
  const b = await doneTask(repo, { 'b.txt': 'b\n' });
  const row = await orch.integration.merge({ task_ids: [a.id, b.id], into: 'int/plain' });
  assert.strictEqual(row.state, 'evaluated');
  assert.strictEqual(row.hook_changed_tree, undefined);
  assert.ok(row.merged.every((m) => m.hook_changed_tree === undefined));
});

test('when the trace names no hook, the answer is hedged and lists the hooks that exist', async () => {
  const repo = makeRepo(dir);
  hook(repo, 'commit-msg', ['exit 0']);
  const rej = await H.rejection(repo, { hooks: null });
  assert.deepStrictEqual(rej, { may_be: ['commit-msg'] });
  assert.match(H.phrase(rej, 'the merge'), /a hook may have rejected the merge; hooks present: commit-msg/);
  assert.strictEqual(await H.rejection(makeRepo(dir), { hooks: null }), null);
  assert.deepStrictEqual(H.hooksIn('{"event":"child_start","child_id":1,"child_class":"hook","hook_name":"x"}\n{"event":"child_exit","child_id":1,"code":3}\n'), [{ name: 'x', exit_code: 3 }]);
});
