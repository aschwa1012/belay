'use strict';
// review-tree.cjs — ADR 0054 amendment 1: did the tree a reviewer judged change during the review? A reviewer has no Edit or
// Write, but its Bash can still write, so task.evaluate reads the reviewer's worktree beside the verdict check and records what
// it finds: HEAD now against the worker row's base_sha (HEAD when the reviewer was spawned), and any uncommitted or untracked
// path. It flags; it never fails the verdict. belay records no status at spawn, so an uncommitted path may predate the review
// (the coder's leftovers), and a commit may be another worker's in a shared tree: the detail says so rather than guess.
// Never throws. Loaded lazily by task.evaluate, a write path.

const { runCommand, readOnlyGitEnv, parsePorcelainZ } = require('./evaluate.cjs');

const GIT_BOUND_MS = 15000;
const PATHS_MAX = 20;

// `worker` is the reviewer's current worker row (or null). Returns the `tree` detail, or null when there is no row to read.
async function reviewTree(worker) {
  if (!worker) return null;
  const out = { worker_id: worker.id, worktree: worker.worktree || null, base_sha: worker.base_sha || null, head_sha: null, head_moved: null, uncommitted: [], uncommitted_count: 0, changed: false, error: null };
  if (!out.worktree) return { ...out, error: 'the reviewer\'s worker row names no worktree' };
  const env = readOnlyGitEnv();
  const h = await runCommand(['git', 'rev-parse', 'HEAD'], String(out.worktree), GIT_BOUND_MS, { env });
  const sha = String(h.stdout || '').trim();
  if (h.executable && h.exit_code === 0 && /^[0-9a-f]{40,64}$/.test(sha)) out.head_sha = sha;
  else out.error = `git rev-parse HEAD exited ${h.exit_code}: ${String(h.stderr || h.spawn_error || '').trim().slice(0, 160)}`;
  if (out.head_sha && out.base_sha) out.head_moved = out.head_sha !== out.base_sha;
  else if (!out.base_sha && !out.error) out.error = 'the reviewer\'s worker row has no base_sha, so a commit during the review cannot be seen';
  const s = await runCommand(['git', '--no-optional-locks', 'status', '--porcelain', '-z', '--untracked-files=all'], String(out.worktree), GIT_BOUND_MS, { env });
  if (s.executable && s.exit_code === 0) {
    const paths = parsePorcelainZ(s.stdout);
    out.uncommitted_count = paths.length;
    out.uncommitted = paths.slice(0, PATHS_MAX);
  } else out.error = `${out.error ? `${out.error}; ` : ''}git status exited ${s.exit_code}: ${String(s.stderr || s.spawn_error || '').trim().slice(0, 160)}`;
  out.changed = out.head_moved === true || out.uncommitted_count > 0;
  if (out.changed) {
    out.note = [
      out.head_moved ? `HEAD moved from ${out.base_sha.slice(0, 12)} to ${out.head_sha.slice(0, 12)} after the reviewer was spawned` : null,
      out.uncommitted_count ? `${out.uncommitted_count} uncommitted or untracked path(s) now (they may predate the review)` : null,
    ].filter(Boolean).join('; ');
  }
  return out;
}

module.exports = { reviewTree, PATHS_MAX };
