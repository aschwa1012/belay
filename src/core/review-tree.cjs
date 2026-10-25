'use strict';
// review-tree.cjs — ADR 0054 amendment 1: did the reviewer change the tree it judged? A reviewer has Edit, Write and Bash,
// and its probes belong in its scratch folder outside the tree. So belay snapshots the reviewer's worktree when the review lease is granted (task.assign), keeps
// the snapshot on the lease row (`tree`), snapshots it again when the reviewer hands back (lease.release with a result), and
// stores the comparison in the hand-back (`handoff.tree`). Only what changed between the two is flagged: the coder's
// uncommitted leftovers, a commit made before the grant, and anything after the hand-back (a fixer starting) are not the
// reviewer's. A snapshot is HEAD and, for each path git status lists, its status code, size and modification time, so a
// further edit to a file that was already dirty is seen. It flags; it never fails the verdict. Never throws.
// Every git call goes through git-safe.cjs (no program from the repository's config runs). Loaded lazily by the two
// write paths, assign and release.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { safeGit, prepare } = require('./git-safe.cjs');
const rows = require('./rows.cjs');

const GIT_BOUND_MS = 15000;
const ENTRIES_MAX = 100; // kept by name on the lease row; past it only the count and the hash are kept
const PATHS_MAX = 20; // changed paths named in the hand-back
const LIST_TAIL = 1024 * 1024;

const isReview = (task) => !!(task && task.acceptance && task.acceptance.verdict === true);

function signature(worktree, xy, rel) {
  try { const s = fs.statSync(path.join(String(worktree), rel)); return `${xy} ${s.size} ${Math.floor(s.mtimeMs)}`; } catch { return `${xy} gone`; }
}

// `{ worktree, head, count, hash, entries | null, at, error }`.
async function snapshot(worktree) {
  const out = { worktree, head: null, count: 0, hash: null, entries: null, at: Date.now(), error: null };
  if (!worktree || !fs.existsSync(String(worktree))) return { ...out, error: `worktree ${worktree} does not exist` };
  const prepared = await prepare(String(worktree), GIT_BOUND_MS); // the filter overrides, read once for both reads
  const h = await safeGit(['rev-parse', 'HEAD'], String(worktree), GIT_BOUND_MS, { prepared });
  const sha = String(h.stdout || '').trim();
  if (h.executable && h.exit_code === 0 && /^[0-9a-f]{40,64}$/.test(sha)) out.head = sha;
  else out.error = `git rev-parse HEAD exited ${h.exit_code}: ${String(h.stderr || h.spawn_error || '').trim().slice(0, 160)}`;
  const s = await safeGit(['status', '--porcelain', '-z', '--untracked-files=all', '--ignore-submodules=all'], String(worktree), GIT_BOUND_MS, { tail: LIST_TAIL, prepared });
  if (!s.executable || s.exit_code !== 0 || s.truncated) {
    out.error = `${out.error ? `${out.error}; ` : ''}git status ${s.truncated ? 'listed more than belay reads' : `exited ${s.exit_code}: ${String(s.stderr || s.spawn_error || '').trim().slice(0, 160)}`}`;
    return out;
  }
  const sigs = [];
  const parts = String(s.stdout).split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e) continue;
    const xy = e.slice(0, 2), rel = e.slice(3);
    sigs.push([rel, signature(worktree, xy, rel)]);
    if (xy[0] === 'R' || xy[0] === 'C') i++; // the original path of a rename or copy
  }
  sigs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  out.count = sigs.length;
  out.hash = crypto.createHash('sha256').update(JSON.stringify(sigs)).digest('hex');
  out.entries = sigs.length <= ENTRIES_MAX ? Object.fromEntries(sigs) : null;
  return out;
}

// The hand-back's `tree`: `{ worktree, head_at_grant, head_at_release, head_moved, changed, changed_paths, changed_count,
// note, error }`. `changed` is null when either snapshot could not be read whole.
function compare(grant, now) {
  const out = { worktree: grant.worktree, head_at_grant: grant.head, head_at_release: now.head, head_moved: null, changed: null, changed_paths: [], changed_count: null, note: null, error: grant.error || now.error || null };
  if (grant.head && now.head) out.head_moved = grant.head !== now.head;
  if (grant.hash && now.hash && out.head_moved !== null) {
    const statusChanged = grant.hash !== now.hash;
    out.changed = out.head_moved || statusChanged;
    if (statusChanged && grant.entries && now.entries) {
      const keys = new Set([...Object.keys(grant.entries), ...Object.keys(now.entries)]);
      const diff = [...keys].filter((k) => grant.entries[k] !== now.entries[k]).sort();
      out.changed_count = diff.length;
      out.changed_paths = diff.slice(0, PATHS_MAX);
    } else out.changed_count = statusChanged ? null : 0;
  }
  if (out.changed) {
    out.note = [
      out.head_moved ? `HEAD moved from ${grant.head.slice(0, 12)} to ${now.head.slice(0, 12)} while the review lease was held` : null,
      out.changed_count !== 0 ? `${out.changed_count === null ? 'some' : out.changed_count} uncommitted or untracked path(s) changed while the review lease was held` : null,
    ].filter(Boolean).join('; ');
  }
  return out;
}

// The reviewer's scratch folder at the hand-back: scratch-dir.cjs, which reads nothing through a link.
const SD = require('./scratch-dir.cjs');

// The assign answer's lease: the grant snapshot stays on the row; the answer carries only its head and count, not every path.
const shown = (lease) => (lease.tree ? { ...lease, tree: { head: lease.tree.head, count: lease.tree.count, error: lease.tree.error } } : lease);

// release: what the hand-back gains for a review lease, `{ tree?, scratch? }`: the comparison with the grant snapshot, and the
// reviewer's scratch folder's size (flagged past 50 MB, never cut).
function handBack(dataDir, workerId, grant, now) {
  const scratch = SD.facts(dataDir, workerId);
  return { ...(grant && now ? { tree: compare(grant, now) } : {}), ...(scratch ? { scratch } : {}) };
}

// assign: the grant snapshot of a review task's assignee, or null (not a review, check_only, or no worker row).
async function grantSnapshot(E, args) {
  if (args.check_only === true || !args.task_id || !args.worker_id) return null;
  if (!isReview(rows.current(E.store, 'task', args.task_id))) return null;
  const w = rows.current(E.store, 'worker', args.worker_id);
  return w && w.worktree ? snapshot(w.worktree) : null;
}

// release: the hand-back snapshot, taken in the worktree the grant snapshot was, or null when the lease carries none.
async function releaseSnapshot(E, args) {
  if (args.result === undefined || !args.lease_id) return null;
  const l = rows.current(E.store, 'lease', args.lease_id);
  return l && l.tree && l.tree.worktree ? snapshot(l.tree.worktree) : null;
}

module.exports = { snapshot, compare, grantSnapshot, releaseSnapshot, shown, handBack, scratchFacts: SD.facts, ENTRIES_MAX, PATHS_MAX };
