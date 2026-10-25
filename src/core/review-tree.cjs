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
  // A baseline taken after the worker had already acted under the lease cannot show what it did before: treated as changed.
  if (grant.baseline_late) { out.baseline_late = true; out.baseline_late_by = grant.baseline_late_by || []; out.changed = true; }
  if (out.changed) {
    out.note = [
      out.baseline_late ? `the grant snapshot was taken after the worker had acted under the lease (${out.baseline_late_by.join(', ')}), so a change before it cannot be seen` : null,
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
function handBack(dataDir, runId, workerId, grant, now) {
  const scratch = SD.facts(dataDir, runId, workerId);
  // A review lease with no grant snapshot (the attach failed or was discarded) says so rather than carrying no tree at all.
  const tree = !grant ? { changed: null, error: 'no grant snapshot was attached' }
    : !grant.worktree ? { changed: null, error: grant.error || 'the reviewed tree is not known' } // never snapshotted: say why
    : now ? compare(grant, now) : { changed: null, error: 'no hand-back snapshot' };
  return { ...(tree ? { tree } : {}), ...(scratch ? { scratch } : {}) };
}

const norm = (p) => (typeof p === 'string' && p ? p.split('\\').join('/').replace(/\/+$/, '').toLowerCase() : null);

// The tree a review judges: the worktree of the task it reviews (its depends_on), not the reviewer's cwd. A task's own belay
// worktree (ADR 0053) when it has one, else the worktree the worker that last held a lease on it had when the lease was
// granted (its worker row as it stood then: an id can be reused later in another tree), else the newest worker row that names
// the task. A task whose own worktree was removed, or whose last holder's row at the grant names none, is an error and not a
// guess. `{ worktree, task_id }`, or `{ worktree: null, error }` when no reviewed task has a tree, or they are in more than one.
function treeOf(store, id) {
  const t = rows.current(store, 'task', id);
  const rec = t && t.worktree && typeof t.worktree === 'object' ? t.worktree : null;
  if (rec && rec.path) {
    if (rec.removed_at != null) return { error: 'the reviewed worktree was removed' };
    return { worktree: rec.path };
  }
  const holder = store.p("SELECT holder, granted_at FROM lease WHERE task_id = ? AND holder_role = 'worker' ORDER BY seq DESC LIMIT 1").get(id);
  if (holder) {
    const at = rows.history(store, 'worker', holder.holder).filter((w) => Number(w.written_at) <= Number(holder.granted_at)).pop();
    return at && typeof at.worktree === 'string' && at.worktree ? { worktree: at.worktree }
      : { error: `the worker ${holder.holder} that held the reviewed task has no worktree on record at its grant` };
  }
  const named = rows.currentAll(store, 'worker').filter((w) => w.task_id === id && typeof w.worktree === 'string' && w.worktree);
  named.sort((x, y) => (Number(y.started_at) || 0) - (Number(x.started_at) || 0));
  return named.length ? { worktree: named[0].worktree } : {};
}

function reviewedTree(store, task) {
  const found = [], errors = [];
  for (const id of Array.isArray(task.depends_on) ? task.depends_on : []) {
    const r = treeOf(store, id);
    if (r.error) errors.push(r.error);
    else if (r.worktree) found.push({ worktree: r.worktree, task_id: id });
  }
  if (errors.length) return { worktree: null, error: errors[0] };
  const trees = [...new Set(found.map((f) => norm(f.worktree)))];
  if (!found.length) return { worktree: null, error: 'no task under review records a worktree, so the reviewed tree is not known' };
  if (trees.length > 1) return { worktree: null, error: `the tasks under review are in ${trees.length} trees, so no one tree is the reviewed one` };
  return found[0];
}

// assign, inside its transaction: what this grant snapshots, or null for a task that is not a review. It reads the reviewed
// tasks' rows inside the same transaction. `cwd` is the reviewer's own directory, so the answer can say when they differ.
function grantTarget(store, task, worker) {
  if (!isReview(task) || !worker) return null;
  return { ...reviewedTree(store, task), cwd: worker.worktree || null };
}

// assign, after its transaction committed and before it answers: the grant snapshot, written onto the lease in a transaction of
// its own that reads the lease again and attaches the snapshot only if that lease is still the task's, unreleased and held by
// the same worker (a take-over, a cancel or a fast release in between discards it). The snapshot is taken here, not before
// the grant, because every read that authorises the grant belongs to its transaction (the contract test), and git cannot run
// inside one; it is still before the grant is known to anyone: assign has not answered, so neither the spawn's first message
// nor task_assign's delivery has reached the reviewer. Returns the answer with the lease shown as `shown` gives it.
// The grant is already committed when this runs, so a failure here never fails the assign: the answer names it, and the
// hand-back of a lease with no snapshot says none was attached. `baseline_late` marks a snapshot taken after the worker had
// already acted under the lease (its row's last event, a checkpoint, a permission request or a memory event newer than the
// grant), read in the attach's own transaction.
async function afterGrant(E, caller, out, target) {
  const lease = out && out.new_lease;
  if (!lease) return out;
  const review = reviewBlock(E, lease.holder, target);
  try {
    const tree = target.worktree ? await module.exports.snapshot(target.worktree) // through the export: the test seam for a change between the grant and here
      : { worktree: null, head: null, at: Date.now(), error: target.error };
    const t = Date.now();
    const kept = E.store.tx(() => {
      const cur = rows.currentLeaseForTask(E.store, lease.task_id);
      if (!cur || cur.id !== lease.id || cur.released_at != null || cur.holder !== lease.holder || cur.holder_role !== 'worker') return null;
      const late = lateBy(E, cur);
      return rows.append(E.store, 'lease', { ...cur, tree: late.length ? { ...tree, baseline_late: true, baseline_late_by: late } : tree }, E.writtenBy(caller), t);
    });
    if (!kept) return { ...out, review };
    E.noteWrite();
    return { ...out, new_lease: shown(kept), review };
  } catch (e) {
    return { ...out, new_lease: { ...lease, tree: { error: `the grant snapshot was not attached: ${(e && e.message) || e}` } }, review };
  }
}

// The assign answer's `review`: the tree the review judges and the task it belongs to, and a note when the reviewer's cwd is
// not that tree, so the orchestrator can name the tree in its prompt. (The scratch folder is the tool answer's, compose.cjs.)
function reviewBlock(E, workerId, target) {
  const differs = target.worktree && target.cwd && norm(target.worktree) !== norm(target.cwd);
  return {
    tree: target.worktree, reviewed_task_id: target.task_id || null, cwd: target.cwd,
    ...(target.error ? { error: target.error } : {}),
    ...(differs ? { note: `the reviewer's cwd is not the reviewed tree; name ${target.worktree} in its prompt` } : {}),
  };
}

// What the worker did under lease `l` before the snapshot: the sources newer than its grant, by name. `core_call` is the
// engine's in-memory time of the worker's last call: a worker learns of a grant before assign answers only by asking the core,
// so one that wrote without calling since the grant was doing pre-review work, which the baseline absorbs. An engine that
// started after the grant does not know, and says `owner_changed`.
function lateBy(E, l) {
  const store = E.store, since = Number(l.granted_at), id = l.holder, out = [];
  if (!(Number(E.startedAt) <= since)) out.push('owner_changed');
  else if (E.workerCalls && Number(E.workerCalls.get(id)) >= since) out.push('core_call'); // the same millisecond counts: the conservative side
  const w = rows.current(store, 'worker', id);
  if (w && Number(w.last_event_at) > since) out.push('last_event_at');
  const newer = (sql) => !!store.p(sql).get(id, since);
  if (newer('SELECT 1 FROM checkpoint WHERE worker_id = ? AND written_at > ? LIMIT 1')) out.push('checkpoint');
  if (newer('SELECT 1 FROM permission WHERE worker_id = ? AND requested_at > ? LIMIT 1')) out.push('permission');
  if (newer('SELECT 1 FROM memory_event WHERE worker_id = ? AND written_at > ? LIMIT 1')) out.push('memory_event');
  return out;
}

// release: the hand-back snapshot, taken in the worktree the grant snapshot was, or null when the lease carries none.
async function releaseSnapshot(E, args) {
  if (args.result === undefined || !args.lease_id) return null;
  const l = rows.current(E.store, 'lease', args.lease_id);
  return l && l.tree && l.tree.worktree ? module.exports.snapshot(l.tree.worktree) : null;
}

module.exports = { snapshot, compare, reviewedTree, grantTarget, afterGrant, lateBy, isReview, releaseSnapshot, shown, handBack, scratchFacts: SD.facts, ENTRIES_MAX, PATHS_MAX };
