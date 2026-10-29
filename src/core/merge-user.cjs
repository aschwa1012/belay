'use strict';
// merge-user.cjs — the merge into a branch the user owns (ADR 0067 decisions 4 to 6). The merge is built on a detached HEAD in a
// temporary tree at the branch's head, the checks run there, and only then does the branch move: a compare-and-swap `git
// update-ref` that moves it forward from the head the merge was built on, or, when the branch is checked out somewhere, no move at
// all (the commit is kept under refs/belay/prepared and the user takes it with `git merge --ff-only`). Never a force, a reset, a
// rewrite or a push. A conflict aborts, a failed check leaves the branch untouched. The caller (methods-integration.cjs) has
// already held the branch's lock and passed the helpers this module shares with the merge into belay's own branches.

const fs = require('node:fs');
const path = require('node:path');
const { err } = require('./errors.cjs');
const rows = require('./rows.cjs');
const G = require('./git.cjs');
const W = require('./methods-worktree.cjs');
const H = require('./git-hooks.cjs');
const INC = require('./integration-incremental.cjs');
const EC = require('./evaluate-cancel.cjs');

// The temporary tree: detached, at `at`, with the repository's usual junctions so the checks can run.
async function addTree(repo, id, at) {
  const wtPath = G.fwd(path.join(path.dirname(repo), `${path.basename(repo)}.worktrees`, W.pathName(`merge-${id.slice(0, 8)}`, 'into')));
  if (fs.existsSync(wtPath) && fs.readdirSync(wtPath).length) throw err('E_EXISTS', `${wtPath} exists and is not empty`, { path: wtPath });
  await H.mustAdd(repo, ['worktree', 'add', '--detach', '--', wtPath, at], 'a temporary worktree for the merge could not be added', () => W.rollback(repo, { path: wtPath, branch: null, junctions: [] }, { keepBranch: true }));
  const made = [];
  try { await W.makeJunctions(repo, wtPath, W.junctionList(undefined), made); } catch (e) {
    e.detail = { ...(e.detail || {}), rollback: await W.rollback(repo, { path: wtPath, branch: null, junctions: made }, { keepBranch: true }) };
    throw e;
  }
  return { path: wtPath, junctions: made };
}

// An earlier prepared merge into the same branch is dropped only once the new head contains it (the user took it, or this merge
// carries it): a prepared merge the new head does not contain may still be wanted, and its ref is the only thing keeping it.
async function dropPrepared(repo, E, into, keepId, newHead, by, fold = (x) => x) {
  for (const r of rows.currentAll(E.store, 'integration')) {
    if (r.id === keepId || r.target !== 'user' || !r.into_branch || fold(r.into_branch) !== fold(into) || !r.prepared || !r.prepared.ref || r.prepared.deleted_at || !G.samePath(r.repo, repo)) continue;
    if (!(await G.run(repo, ['merge-base', '--is-ancestor', r.prepared.sha, newHead])).ok) continue;
    const d = await G.run(repo, ['update-ref', '-d', r.prepared.ref]);
    if (d.ok) E.store.tx(() => rows.append(E.store, 'integration', { ...r, prepared: { ...r.prepared, deleted_at: Date.now(), deleted_why: 'contained in a later head' } }, by, Date.now()));
  }
}

// -> { row, ... } the row written, as the caller returns it. `c` carries what the caller has already settled.
async function mergeIntoUser(E, caller, args, c) {
  const { repo, into, tasks, targets, place, approver, takeOver, view, mergeOne, rerun, abandonStale } = c;
  const extra = c.extra || [], until = c.until === undefined ? Infinity : c.until;
  const fold = c.fold || ((x) => x);
  const by = E.writtenBy(caller);
  await abandonStale(E, caller, repo, into, takeOver);
  const start = place.head || place.base;
  const id = rows.newId();
  const tree = await addTree(repo, id, start);
  let treeGone = false, wrote = null, mergedSha = null;
  try {
  const base = {
    id, run_id: caller.run_id, repo, into_branch: into, worktree: tree.path, created_worktree: true, base_sha: start, head_sha: start,
    task_ids: [...args.task_ids], merged: [], conflict: null, error: null, checks: null, passed: null, junctions: tree.junctions, removed_at: null,
    owner_pid: process.pid, owner_boot: await W.ownBoot(E), target: 'user', head_before: place.head, head_after: place.head, applied: 'none', approver, prepared: null,
  };
  E.store.tx(() => { E.assertRunOpen(caller, 'integration.merge'); wrote = rows.append(E.store, 'integration', { ...base, state: 'merging' }, by, Date.now()); });
  E.noteWrite();
  const out = { ...base, state: 'evaluated' };
  const entries = [];
  let trying = null;
  try {
    for (const t of tasks) {
      trying = t;
      const m = await mergeOne(tree.path, t, targets.get(t.id));
      if (!m.ok) {
        const { ok, conflict, stderr, ...rest } = m;
        if (conflict) { out.state = 'conflict'; out.conflict = rest; } else {
          const h = m.hook_rejected;
          out.state = 'failed'; out.error = { ...rest, message: h ? `${H.phrase(h, `the merge of task ${t.id}`)}${h.stderr_tail ? `: ${h.stderr_tail}` : ''}` : `the merge of ${t.id} failed without a conflict: ${String(stderr).split('\n')[0]}`, stderr };
        }
        break;
      }
      entries.push({ task_id: m.task_id, branch: m.branch, sha: m.sha, already: m.already, by_this_call: !m.already, empty: !!m.empty, judged_by: m.judged_by, covers: m.covers, head_sha: m.head_sha || null, ...(m.left_out ? { left_out: m.left_out } : {}), ...(m.hook_changed_tree ? { hook_changed_tree: m.hook_changed_tree } : {}) });
      trying = null;
      const left = m.hook_changed_tree && m.hook_changed_tree.uncommitted_files;
      if (left) {
        out.state = 'failed';
        out.error = { task_id: t.id, hook_left_uncommitted: left, message: `your ${m.hook_changed_tree.hooks.join(', ')} hook left uncommitted edits in the temporary tree after merging task ${t.id} (${left.slice(0, 10).join(', ')}); ${into} was not moved`, tree_clean: false };
        break;
      }
    }
  } catch (e) {
    out.state = 'failed';
    out.error = { code: e.code || 'E_INTERNAL', message: e.message, detail: e.detail || null, task_id: trying ? trying.id : null };
  }
  const head = await G.run(tree.path, ['rev-parse', 'HEAD']);
  const merged = head.ok ? head.stdout.trim() : start;
  mergedSha = merged;
  out.head_sha = merged;
  const stop = out.conflict || out.error;
  const unapplied = () => entries.map(({ task_id, sha, head_sha }) => ({ task_id, sha, head_sha }));
  let ran = false;
  if (!stop && (args.evaluate !== false || extra.length) && entries.length) {
    try {
      const reuse = INC.reuseFor(E, repo, into, merged, (await G.dirtyPaths(tree.path)).length === 0);
      const endSpan = EC.beginSpan(`integration ${id}`);
      try { out.checks = await rerun(args.evaluate === false ? [] : tasks.filter((t) => entries.some((m) => m.task_id === t.id)), tree.path, reuse, merged, (a, b) => EC.during(`integration ${id}`, a, b), extra, until); } finally { endSpan(); }
      out.passed = out.checks.length > 0 ? out.checks.every((x) => x.passed) : null;
      ran = out.checks.length > 0;
    } catch (e) {
      out.checks = null; out.passed = null;
      out.state = 'failed'; out.error = { code: e.code || 'E_INTERNAL', message: `the checks could not be run: ${e.message}; ${into} was not moved`, detail: e.detail || null };
    }
  }
  let landed = false;
  if (out.state === 'evaluated' && (place.head === null || merged !== place.head) && entries.length) {
    if (ran && out.passed !== true) {
      out.error = { message: `a check failed on the merged head ${merged}; ${into} was not moved`, merge_head: merged, unapplied: unapplied() };
    } else {
      if (!ran) out.error = { message: `applied unchecked: ${args.evaluate === false ? 'evaluate was false and the call named no checks' : 'the merged tasks declare no acceptance commands'}, so nothing is proven` };
      // The last look before the move: the branch may have been checked out since the placement was read. What happens between this look and the update-ref is not closed by a lock (git has none for it); the compare-and-swap is what catches a branch that moved.
      const checkedOut = (await G.worktrees(repo)).find((w) => w.branch && fold(w.branch) === fold(into));
      if (checkedOut) {
        // Not merged in the user's checkout: kept under a ref of belay's own, for the user to take.
        const ref = `refs/belay/prepared/${id}`;
        const r = await G.run(repo, ['update-ref', '-m', `belay: merge prepared for ${into}`, ref, merged, '']);
        if (!r.ok) { out.state = 'failed'; out.error = { code: 'E_GIT', message: `the prepared merge could not be kept under ${ref}: ${r.stderr}`, unapplied: unapplied() }; } else {
          out.applied = 'prepared';
          out.prepared = { sha: merged, ref, checkout: checkedOut.path, ff_command: `git merge --ff-only ${merged}`, task_ids: entries.map((m) => m.task_id), merge_commits: entries.map((m) => m.head_sha).filter(Boolean), into_head: place.head };
        }
      } else {
        const r = await G.run(repo, ['update-ref', '-m', `belay: merge ${args.task_ids.join(', ')}`, `refs/heads/${into}`, merged, place.head || '']);
        if (!r.ok) { out.state = 'failed'; out.error = { code: 'E_PRECONDITION', message: `${into} moved while the merge was built (${r.stderr.split('\n')[0]}); it was left as it is`, unapplied: unapplied() }; } else { out.applied = 'ref'; landed = true; out.head_after = merged; }
      }
    }
  }
  if (landed || (out.state === 'evaluated' && out.applied === 'none' && !out.error)) out.merged = entries; // nothing the branch lacks: what it already holds
  else if (out.applied === 'prepared') out.merged = [];
  if (out.conflict) out.conflict = { ...out.conflict, unapplied: unapplied() };
  if (out.applied !== 'none') await dropPrepared(repo, E, into, id, merged, by, fold); // earlier prepared merges this head contains
  let removal = null, removedAt = null;
  treeGone = true; // removeTree below owns the tree from here
  try {
    removal = await W.removeTree(E, { repo, path: tree.path, junctions: tree.junctions, branch: null }, { force: true }, `integration ${id}`);
    removedAt = removal.leftover ? null : Date.now();
  } catch (e) {
    out.error = { ...(out.error || {}), tree_not_removed: `${tree.path} could not be removed (${e.message}); belay worktree remove --integration ${id} will` };
  }
  if (out.state === 'conflict' || out.state === 'failed') out.passed = false; // a step that stopped is never passed, whether or not a check ran
  // The outcome row first, then the row that records the tree's removal over it (as integration.remove does), so the outcome is what the task facts read.
  const row = E.store.tx(() => { const o = rows.append(E.store, 'integration', out, by, Date.now()); return removedAt ? rows.append(E.store, 'integration', { ...o, removed_at: removedAt }, by, Date.now()) : o; });
  E.noteWrite();
  return { ...view(row), checked: ran, ...(ran ? {} : { note: 'no checks ran' }), merge_commits: entries.map((m) => m.head_sha).filter(Boolean), ...(removal ? { removal } : {}) };
  } catch (e) { // a throw outside the guarded steps: the temporary tree and the open `merging` row do not outlive the call
    if (!treeGone) { try { await W.removeTree(E, { repo, path: tree.path, junctions: tree.junctions, branch: null }, { force: true }, `integration ${id}`); } catch (_) { /* the error below is the one reported */ } }
    if (wrote) { // what is true now, read back: the branch and the prepared ref may have moved before the throw
      try {
        const cur = await G.run(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${into}^{commit}`]);
        const now = cur.ok ? cur.stdout.trim() : null;
        const pr = await G.run(repo, ['rev-parse', '--verify', '--quiet', `refs/belay/prepared/${id}^{commit}`]);
        const kept = pr.ok ? pr.stdout.trim() : null;
        const moved = now !== (place.head || null);
        const facts = {
          head_after: now, applied: kept ? 'prepared' : moved && now === mergedSha ? 'ref' : 'none',
          ...(kept ? { prepared: { sha: kept, ref: `refs/belay/prepared/${id}`, checkout: null, ff_command: `git merge --ff-only ${kept}`, task_ids: [...args.task_ids], merge_commits: [], into_head: place.head } } : {}),
        };
        E.store.tx(() => rows.append(E.store, 'integration', { ...wrote, ...facts, state: 'failed', passed: false, error: { code: e.code || 'E_INTERNAL', message: `${e.message}${kept ? ' (after the merge was kept under its prepared ref)' : moved ? (now === mergedSha ? ` (after ${into} was moved to the merge)` : ` (${into} had moved to ${now} by other means)`) : ''}` } }, by, Date.now()));
      } catch (_) { /* the store may be closing */ }
    }
    throw e;
  }
}

module.exports = { mergeIntoUser, dropPrepared };
