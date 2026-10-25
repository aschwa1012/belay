'use strict';
// judged.cjs — what a task was judged on, and which commit on its branch is that (ADR 0060 decisions 4 and 6). An evaluation
// judges a working tree, uncommitted changes included, so it records the tree's content as a git tree id, written through a
// temporary index (the worktree's own index, and any stash, are never touched), beside the HEAD it stood on. integration.merge
// then merges the newest commit on the branch whose tree is that content: what was judged, never a branch head past it.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const G = require('./git.cjs');
const rows = require('./rows.cjs');

const recorded = (task) => (task && task.worktree && task.worktree.path && !task.worktree.removed_at ? task.worktree : null);

// `{ head_sha, tree_sha, uncommitted }` for a task judged in its own recorded tree, read before its checks run; null when it is
// judged elsewhere, has no tree, or git cannot say. `uncommitted` is whether the content differs from HEAD's tree.
async function stateOf(task, dir) {
  const tree = recorded(task);
  if (!tree || !dir || !G.samePath(path.resolve(dir), path.resolve(tree.path))) return null;
  const head = await G.run(tree.path, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (!head.ok) return null;
  const index = path.join(os.tmpdir(), `belay-judged-${process.pid}-${rows.newId()}.index`);
  const env = { GIT_INDEX_FILE: index };
  try {
    if (!(await G.run(tree.path, ['read-tree', 'HEAD'], { env })).ok) return null;
    if (!(await G.run(tree.path, ['add', '-A', '--', '.'], { env })).ok) return null;
    const w = await G.run(tree.path, ['write-tree'], { env });
    const h = await G.run(tree.path, ['rev-parse', '--verify', 'HEAD^{tree}']);
    if (!w.ok || !h.ok) return { head_sha: head.stdout.trim(), tree_sha: null, uncommitted: null };
    const treeSha = w.stdout.trim();
    return { head_sha: head.stdout.trim(), tree_sha: treeSha, uncommitted: treeSha !== h.stdout.trim() };
  } finally {
    for (const f of [index, `${index}.lock`]) fs.rmSync(f, { force: true });
  }
}

// The judged content on the results; uncommitted content is said, since integrate merges only a commit of it.
const fields = (j) => (!j ? {} : { head_sha: j.head_sha, ...(j.tree_sha ? { tree_sha: j.tree_sha } : {}),
  ...(j.uncommitted ? { uncommitted: true, warning: 'uncommitted changes: commit before integrate' } : {}) });

// What a done task's results say it was judged on: the tree id (decision 6), and the head (decision 4, or the files check's
// head for a row from before both).
function judgedOf(t) {
  const r = t && t.results;
  if (!r) return null;
  const c = (Array.isArray(r.checks) ? r.checks : []).find((x) => x && x.kind === 'files_within_owned' && x.executable && x.detail && x.detail.head_sha);
  const head = r.head_sha || (c ? c.detail.head_sha : null);
  return r.tree_sha || head ? { tree: r.tree_sha || null, head } : null;
}

// The done tasks on the task's branch in its repository that record what they were judged on, oldest judgement first.
function onBranch(E, task) {
  return rows.currentAll(E.store, 'task').filter((t) => t.state === 'done' && t.worktree && t.worktree.branch === task.worktree.branch
    && G.samePath(t.worktree.repo, task.worktree.repo) && judgedOf(t))
    .sort((a, b) => Number(a.results.evaluated_at) - Number(b.results.evaluated_at));
}

// The commit on the branch (from `tip` back to the task's base) that is what `t` was judged on: the newest whose tree is the
// judged tree, or for a row with only a head, that head when the tip contains it. Null when no commit on the branch is it.
async function commitOf(cwd, t, tip) {
  const j = judgedOf(t);
  if (!j) return null;
  if (!j.tree) return (await G.run(cwd, ['merge-base', '--is-ancestor', j.head, tip])).ok ? j.head : null;
  const base = t.worktree && t.worktree.base_sha;
  const log = await G.run(cwd, ['log', '--format=%H %T', tip, ...(base ? [`^${base}`] : []), '--']);
  if (!log.ok) return null;
  for (const line of log.stdout.split('\n')) {
    const [sha, treeSha] = line.trim().split(' ');
    if (treeSha === j.tree) return sha;
  }
  if (base) {
    const b = await G.run(cwd, ['rev-parse', '--verify', `${base}^{tree}`]);
    if (b.ok && b.stdout.trim() === j.tree && (await G.run(cwd, ['merge-base', '--is-ancestor', base, tip])).ok) return base;
  }
  return null;
}

module.exports = { stateOf, fields, judgedOf, onBranch, commitOf };
