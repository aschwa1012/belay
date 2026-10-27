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

const GIT_MS = 120000; // a hash of a large tree (thousands of untracked files) takes seconds; past this it is not read
const PATHS_MAX = 20; // uncommitted paths named in the warning
const ok = (r) => r.executable && r.exit_code === 0 && !r.timed_out;

// `{ head_sha, tree_sha, uncommitted, uncommitted_paths, unread }` for a task judged in its own recorded tree, read before its
// checks run; null when it is judged elsewhere, has no tree or no commit. Every read and the add run through git-safe (no hook,
// no fsmonitor, no repository filter program; ADR 0054 decision 2), with the system line-ending keys passed back so content
// hashes as a commit would. A clean tree (git status lists nothing) is HEAD's tree, with no add. A dirty one is hashed through a
// temporary index seeded from a copy of the tree's own index (its stat cache spares unchanged files). When the content cannot be
// read (a failed add, a timeout, an embedded repository with no commit), the head is kept and `unread` says why: integrate then
// falls back to the head (decision 4's rule).
async function stateOf(task, dir) {
  const tree = recorded(task);
  if (!tree || !dir || !G.samePath(path.resolve(dir), path.resolve(tree.path))) return null;
  const head = await G.run(tree.path, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (!head.ok) return null;
  const out = { head_sha: head.stdout.trim() };
  const S = require('./git-safe.cjs');
  const p = await S.prepare(tree.path, GIT_MS, process.env, { lineEndings: true });
  if (p.error) return { ...out, unread: p.error };
  const git = (args, env) => S.safeGit(args, tree.path, GIT_MS, { prepared: env ? { ...p, env: { ...p.env, ...env } } : p, tail: 4 * 1024 * 1024 });
  const status = await git(['status', '--porcelain', '-z', '--untracked-files=all']);
  if (!ok(status)) return { ...out, unread: `git status failed: ${String(status.stderr || status.spawn_error || '').trim().split('\n')[0]}` };
  const headTree = (await G.run(tree.path, ['rev-parse', '--verify', 'HEAD^{tree}'])).stdout.trim();
  const paths = [...new Set(require('./evaluate.cjs').parsePorcelainZ(status.stdout))];
  if (!paths.length) return { ...out, tree_sha: headTree, uncommitted: false };
  const index = path.join(os.tmpdir(), `belay-judged-${process.pid}-${rows.newId()}.index`);
  try {
    const own = await G.run(tree.path, ['rev-parse', '--git-path', 'index']);
    const real = own.ok ? path.resolve(tree.path, own.stdout.trim()) : null;
    if (real && fs.existsSync(real)) fs.copyFileSync(real, index);
    const env = { GIT_INDEX_FILE: index };
    if (!fs.existsSync(index) && !ok(await git(['read-tree', 'HEAD'], env))) return { ...out, unread: 'git read-tree HEAD failed' };
    const add = await git(['add', '-A', '--', '.'], env);
    if (!ok(add)) return { ...out, unread: `git add failed${add.timed_out ? ' (timed out)' : ''}: ${String(add.stderr || add.spawn_error || '').trim().split('\n')[0]}` };
    const w = await git(['write-tree'], env);
    if (!ok(w)) return { ...out, unread: 'git write-tree failed' };
    const treeSha = w.stdout.trim();
    return { ...out, tree_sha: treeSha, uncommitted: treeSha !== headTree, uncommitted_paths: paths };
  } finally {
    for (const f of [index, `${index}.lock`]) fs.rmSync(f, { force: true });
  }
}

// The judged content on the results. Uncommitted content is said, naming the paths judged but not committed (capped), since
// integrate merges only a commit of it; content that could not be read keeps the head and says so.
function fields(j) {
  if (!j) return {};
  const out = { head_sha: j.head_sha, ...(j.tree_sha ? { tree_sha: j.tree_sha } : {}) };
  if (j.unread) return { ...out, warning: `the judged content could not be read (${j.unread}); integrate goes by the head` };
  if (!j.uncommitted) return out;
  const shown = j.uncommitted_paths.slice(0, PATHS_MAX);
  const more = j.uncommitted_paths.length - shown.length;
  return { ...out, uncommitted: true, uncommitted_paths: shown, warning: `uncommitted changes (${shown.join(', ')}${more ? `, and ${more} more` : ''}): commit before integrate` };
}

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
