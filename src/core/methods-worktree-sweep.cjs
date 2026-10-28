'use strict';
// methods-worktree-sweep.cjs — task.worktreeSweep (ADR 0065): at the close of a run, remove the task trees it can prove are
// finished and keep the rest, each with its reason. The operator's only, with no MCP tool. It reads every fact at the call
// (rows, pid checks, git), removes through the one removeTree (no force, never a branch, one attempt, no retry), and kills,
// signals and stops nothing: a process the close did not end keeps its tree.

const fs = require('node:fs');
const { err } = require('./errors.cjs');
const rows = require('./rows.cjs');
const G = require('./git.cjs');
const W = require('./methods-worktree.cjs');
const holds = require('./task-holds.cjs');

const SWEEP_BUDGET_MS = 120000;
const NAMED = 20;
const ENDED = new Set(['done', 'cancelled']);
const key = (p) => G.fwd(p).toLowerCase();

// Runs whose sweep was told to stop (task.worktreeSweepCancel). Checked before each tree's git, so a cut leaves no tree half
// done: the close that cut it waits for the call to settle before the store closes.
const cancelRequested = new Set();
const running = new Map(); // run id -> { path }: a sweep in this process, and the tree whose git is in flight
const EXPECT_TREE_MS = 2000; // what one tree's removal is expected to take until a slower one has been seen
// A cancel with no sweep running sets nothing, so a stale flag cannot stop a later sweep. in_flight is the tree whose git is running.
async function cancel(E, caller, args) {
  const runId = args.run_id === undefined ? caller.run_id : args.run_id;
  if (typeof runId !== 'string' || !runId) throw err('E_ARGS', 'task.worktreeSweepCancel needs a run_id');
  const r = running.get(runId);
  if (r) cancelRequested.add(runId);
  return { run_id: runId, cancel_requested: !!r, in_flight: r ? r.path : null };
}

// Ignored paths in a tree other than the recorded junctions: what goes with the tree (build output, a local .env).
async function ignoredPaths(rec) {
  const r = await G.run(rec.path, ['status', '--porcelain', '-z', '--ignored=matching', '--untracked-files=normal']);
  if (!r.ok) return null;
  const links = new Set((rec.junctions || []).map((j) => key(j.path)));
  return r.stdout.split('\0').filter((l) => l.startsWith('!! ')).map((l) => l.slice(3))
    .filter((p) => !links.has(key(`${rec.path}/${p.replace(/\/$/, '')}`)));
}

// Why this tree stays, or null when every condition of ADR 0065 decision 3 holds.
async function keepReason(E, group, ctx) {
  const rec = group.rec;
  const open = group.tasks.find((t) => !ENDED.has(t.state)) || W.openSharer(E, group.tasks[0]);
  if (open) return { reason: 'task_open', detail: `task ${open.id} is ${open.state}` };
  const w = W.liveWorkerIn(E, rec.path);
  // A dry run for a close that is pending judges the rest as if the close had ended the worker that is alive but not parked.
  if (w && !(ctx.closePending && w.state !== 'paused')) return { reason: w.state === 'paused' ? 'parked_worker' : 'live_worker', detail: `worker ${w.id} (${w.state})` };
  const unproven = ctx.workers.find((x) => ctx.unproven.has(x.id) && x.worktree && W.under(x.worktree, rec.path));
  if (unproven) return { reason: 'kill_unproven', detail: `worker ${unproven.id} was not proven ended by the close` };
  if (!fs.existsSync(rec.path)) return { reason: 'already_gone', detail: 'the path is not on disk; belay worktree remove <task-id> records it' };
  if (!(await G.worktrees(rec.repo)).some((x) => G.samePath(x.path, rec.path))) return { reason: 'not_listed', detail: 'the path is on disk but git no longer lists it as a worktree; belay deletes nothing and writes no row' };
  {
    const dirty = await G.dirtyPaths(rec.path);
    if (dirty.length) return { reason: 'dirty', detail: `${dirty.length} uncommitted path(s)`, paths: dirty.slice(0, NAMED) };
    const head = await W.symbolicHead(rec.path);
    if (head !== `refs/heads/${rec.branch}` || !(await G.branchExists(rec.repo, rec.branch))) {
      return { reason: 'head_off_branch', detail: head ? `HEAD is ${head}` : 'HEAD is detached' };
    }
  }
  const integ = ctx.integrations.find((i) => (i.worktree && G.samePath(i.worktree, rec.path))
    || (i.state === 'merging' && i.into_branch === rec.branch && G.samePath(i.repo || '', rec.repo)));
  if (integ) return { reason: 'integration_target', detail: `integration ${integ.id}` };
  const other = ctx.allTasks.find((t) => t.run_id !== ctx.runId && W.active(t) && G.samePath(W.active(t).path, rec.path) && ctx.liveness(t.run_id).live);
  if (other) return { reason: 'shared_with_live_run', detail: `task ${other.id} of run ${other.run_id}` };
  return null;
}

// Trees git lists under <repo>.worktrees/ on a belay/ branch that no task or integration row records.
async function findOrphans(repos, recorded) {
  const out = [];
  for (const repo of repos) {
    let list;
    try { list = await G.worktrees(repo); } catch { continue; }
    const prefix = `${key(repo)}.worktrees/`;
    for (const x of list) {
      if (!x.branch || !x.branch.startsWith('belay/') || !key(x.path).startsWith(prefix) || recorded.has(key(x.path))) continue;
      const contains = await G.run(repo, ['branch', '--contains', x.head, '--format=%(refname:short)']);
      const atBase = contains.ok && contains.stdout.split('\n').some((b) => b.trim() && !b.trim().startsWith('belay/'));
      out.push({ path: x.path, branch: x.branch, head: x.head, at_base: atBase });
    }
  }
  return out;
}

async function removeOne(E, caller, g, base) {
  const t1 = Date.now();
  let head = null, ignored = null;
  if (fs.existsSync(g.rec.path)) { head = await G.commitOf(g.rec.path, 'HEAD'); ignored = await ignoredPaths(g.rec); }
  const row = await W.removeForSweep(E, caller, g.tasks[0]);
  if (row && row.removal.leftover) return { failed: { ...base, code: 'LEFTOVER', error: row.removal.leftover_note, git_still_lists: false, leftover: true, row_recorded: false, remedy: 'belay worktree remove <task-id> records the removal; delete the directory by hand' } };
  if (!row) return { kept: { ...base, reason: 'task_open', detail: 'the tree was removed by another call' } };
  const r = row.removal;
  const after = await G.run(g.rec.repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${g.rec.branch}`]);
  const branchAfter = after.ok ? after.stdout.trim() : null;
  const pathGone = !fs.existsSync(g.rec.path);
  if (!pathGone || (head && branchAfter !== head)) {
    return { failed: { ...base, code: 'E_PROOF', error: (pathGone ? 'the branch head is not the tree\'s head' : 'the path is still on disk'), git_still_lists: false, leftover: false, branch_head_after: branchAfter } };
  }
  return { removed: { ...base, head, branch_head_after: branchAfter, path_gone: pathGone, junctions_unlinked: r.junctions_unlinked, links_unlinked: r.links_unlinked,
    ignored_removed: ignored ? { paths: ignored.length, first: ignored.slice(0, NAMED) } : null, ms: Date.now() - t1 } };
}

// task.worktreeSweep { dry_run: true }: what the sweep would keep and remove now, judged by the same keepReason. Removes nothing,
// writes nothing, sets no cancel state; `would_remove` lists the trees that pass every condition.
async function dryRun(E, groups, ctx, out, t0) {
  out.dry_run = true;
  out.would_remove = [];
  for (const g of groups.values()) {
    const base = { task_ids: g.tasks.map((t) => t.id), path: g.rec.path, branch: g.rec.branch };
    try {
      const why = await keepReason(E, g, ctx);
      if (why) out.kept.push({ ...base, ...why }); else out.would_remove.push(base);
    } catch (e) { out.failed.push({ ...base, code: e.code || 'E_INTERNAL', error: e.message }); }
  }
  out.ms = Date.now() - t0;
  return out;
}

async function sweep(E, caller, args) {
  const runId = args.run_id === undefined ? caller.run_id : args.run_id;
  if (typeof runId !== 'string' || !runId) throw err('E_ARGS', 'task.worktreeSweep needs a run_id');
  if (args.unproven_workers !== undefined && !(Array.isArray(args.unproven_workers) && args.unproven_workers.every((s) => typeof s === 'string'))) throw err('E_ARGS', 'task.worktreeSweep: unproven_workers must be an array of worker ids', { field: 'unproven_workers' });
  if (args.deadline_ms !== undefined && !(Number.isFinite(args.deadline_ms) && args.deadline_ms >= 0)) throw err('E_ARGS', 'task.worktreeSweep: deadline_ms must be a non-negative number', { field: 'deadline_ms' });
  if (args.close_pending !== undefined && !(args.close_pending === true && args.dry_run === true)) throw err('E_ARGS', 'task.worktreeSweep: close_pending is true and only with dry_run', { field: 'close_pending' });
  const t0 = Date.now();
  let slowest = EXPECT_TREE_MS;
  const budget = Number.isFinite(args.budget_ms) ? args.budget_ms : SWEEP_BUDGET_MS;
  const allTasks = rows.currentAll(E.store, 'task');
  const allIntegrations = rows.currentAll(E.store, 'integration');
  const ctx = { runId, allTasks, integrations: allIntegrations.filter((i) => !i.removed_at), workers: rows.currentAll(E.store, 'worker'), unproven: new Set(args.unproven_workers || []), closePending: args.close_pending === true, liveness: holds.runLiveness(E.store) };
  const groups = new Map();
  for (const t of allTasks) {
    const rec = t.run_id === runId ? W.active(t) : null;
    if (!rec) continue;
    if (!groups.has(key(rec.path))) groups.set(key(rec.path), { rec, tasks: [] });
    groups.get(key(rec.path)).tasks.push(t);
  }
  const out = { removed: [], kept: [], failed: [], orphans: [], integration_kept: [], skipped: null, ms: 0 };
  if (args.dry_run === true) return dryRun(E, groups, ctx, out, t0);
  const mine = { path: null };
  running.set(runId, mine);
  try {
  for (const g of groups.values()) {
    const base = { task_ids: g.tasks.map((t) => t.id), path: g.rec.path, branch: g.rec.branch };
    if (cancelRequested.has(runId)) { out.skipped = 'interrupted'; out.kept.push({ ...base, reason: 'interrupted', detail: 'the close was cut before this tree' }); continue; }
    if (args.deadline_ms !== undefined && Date.now() - t0 + slowest > args.deadline_ms) { out.skipped = 'deadline'; out.kept.push({ ...base, reason: 'deadline', detail: `the close has ${args.deadline_ms} ms left, which does not fit another removal` }); continue; }
    if (Date.now() - t0 >= budget) { out.skipped = 'budget'; out.kept.push({ ...base, reason: 'budget', detail: `the sweep's ${budget} ms ran out before this tree` }); continue; }
    try {
      const why = await keepReason(E, g, ctx);
      if (why) { out.kept.push({ ...base, ...why }); continue; }
      if (cancelRequested.has(runId)) { out.skipped = 'interrupted'; out.kept.push({ ...base, reason: 'interrupted', detail: 'the close was cut before this tree' }); continue; }
      mine.path = g.rec.path;
      const t1 = Date.now();
      let r;
      try { r = await removeOne(E, caller, g, base); } finally { mine.path = null; slowest = Math.max(slowest, Date.now() - t1); }
      for (const k of ['removed', 'kept', 'failed']) if (r[k]) out[k].push(r[k]);
    } catch (e) {
      // A tree dirtied between the check and the removal is refused by the removal itself: it is kept dirty, not failed.
      if (e.code === 'E_PRECONDITION' && e.detail && Array.isArray(e.detail.dirty)) {
        out.kept.push({ ...base, reason: 'dirty', detail: `${e.detail.dirty.length} uncommitted path(s)`, paths: e.detail.dirty.slice(0, NAMED) });
        continue;
      }
      const listed = await G.worktrees(g.rec.repo).then((l) => l.some((x) => G.samePath(x.path, g.rec.path))).catch(() => null);
      out.failed.push({ ...base, code: e.code || 'E_INTERNAL', error: e.message, git_still_lists: listed, leftover: false });
    }
  }
  } finally { cancelRequested.delete(runId); running.delete(runId); }
  for (const i of ctx.integrations) if (i.run_id === runId && i.worktree) out.integration_kept.push({ id: i.id, path: i.worktree, branch: i.into_branch });
  try {
    const repos = new Set([...groups.values()].map((g) => g.rec.repo));
    const run = rows.current(E.store, 'run', runId);
    if (run && run.project_dir) { try { repos.add(await G.toplevel(run.project_dir)); } catch { /* not a repository */ } }
    const recorded = new Set([...allTasks.map((t) => t.worktree && t.worktree.path), ...allIntegrations.map((i) => i.worktree)].filter(Boolean).map(key));
    out.orphans = await findOrphans(repos, recorded);
  } catch { /* an orphan scan that fails reports none */ }
  out.ms = Date.now() - t0;
  return out;
}

module.exports = { sweep, cancel, SWEEP_BUDGET_MS };
