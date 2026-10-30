'use strict';
// integration-policy.cjs -- what integration.merge accepts and what it merges: the call's argument checks, the tasks it may merge and the commit it
// merges for each (ADR 0053 decision 5, ADR 0060 decisions 4 and 6). Moved out of methods-integration.cjs unchanged; the merge itself stays there.

const fs = require('node:fs');
const { err } = require('./errors.cjs');
const rows = require('./rows.cjs');
const G = require('./git.cjs');
const W = require('./methods-worktree.cjs');
const J = require('./judged.cjs');
const { checkShape } = require('./integration-checks.cjs');
const { pidAlive } = require('./lock.cjs');
const PS = require('./policy-stamp.cjs');

const MAX_TASKS = 50;
const MAX_REASON = 300;

// `take_over` closes a `merging` row whose pid runs but is not proven to be the merge. It is the operator's alone: the
// orchestrator's tool does not list it, and core refuses it from any other role.
function checkTakeOver(caller, args, method) {
  if (args.take_over === undefined) return false;
  if (typeof args.take_over !== 'boolean') throw err('E_ARGS', `${method}: take_over must be a boolean`, { field: 'take_over' });
  if (args.take_over && caller.role !== 'operator') throw err('E_ROLE', `${method}: take_over is the operator's, never the ${caller.role}'s`, { field: 'take_over', role: caller.role });
  return args.take_over;
}

function checkArgs(args) {
  const ids = args.task_ids;
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_TASKS || ids.some((x) => typeof x !== 'string' || !x)) {
    throw err('E_ARGS', `integration.merge needs task_ids: 1 to ${MAX_TASKS} task ids, in merge order`, { task_ids: ids });
  }
  if (new Set(ids).size !== ids.length) throw err('E_ARGS', 'integration.merge: task_ids names a task twice', { task_ids: ids });
  if (args.evaluate !== undefined && typeof args.evaluate !== 'boolean') throw err('E_ARGS', 'integration.merge: evaluate must be a boolean', { field: 'evaluate' });
  checkShape(args.checks);
  if (args.force !== undefined && typeof args.force !== 'boolean') throw err('E_ARGS', 'integration.merge: force must be a boolean', { field: 'force' });
  if (args.force === true && (typeof args.reason !== 'string' || !args.reason.trim() || args.reason.length > MAX_REASON)) {
    throw err('E_ARGS', `integration.merge: force needs a reason, 1 to ${MAX_REASON} characters, saying why merging a task that is not done is expected`, { field: 'reason' });
  }
  for (const k of ['into', 'base']) if (args[k] !== undefined && (typeof args[k] !== 'string' || !args[k])) throw err('E_ARGS', `integration.merge: ${k} must be a non-empty string`, { field: k });
}

// Every task done, with a recorded branch, in one repository, and its tree (if still there) clean.
async function readTasks(E, ids, force) {
  const tasks = ids.map((id) => {
    const t = rows.current(E.store, 'task', id);
    if (!t) throw err('E_NOT_FOUND', `no task row exists for ${id}`, { task_id: id });
    return t;
  });
  // A review task judges work and has none to merge, forced or not.
  const reviews = tasks.filter((t) => t.acceptance && t.acceptance.verdict === true).map((t) => t.id);
  if (reviews.length) throw err('E_PRECONDITION', `these are review tasks, which have no work to merge: ${reviews.join(', ')}; merge the work they judged`, { review_tasks: reviews });
  // `force` (a merge past a task that is not done) takes a task that is not done, but never a cancelled one: that is final.
  const notDone = tasks.filter((t) => (force ? t.state === 'cancelled' : t.state !== 'done')).map((t) => ({ task_id: t.id, state: t.state }));
  if (notDone.length) throw err('E_PRECONDITION', `only done tasks are merged; not done: ${notDone.map((x) => `${x.task_id} (${x.state})`).join(', ')}. Leave them out, or merge once task_evaluate makes them done`, { not_done: notDone });
  const noBranch = tasks.filter((t) => !t.worktree || !t.worktree.branch).map((t) => t.id);
  if (noBranch.length) throw err('E_PRECONDITION', `these tasks have no belay branch to merge: ${noBranch.join(', ')}. integrate merges only tasks worked in their own tree (task_worktree before the coder starts); leave these out, their work is already where it was committed`, { no_branch: noBranch });
  // Even forced, a task still being worked is not merged: its head moves. A worker running a turn or parked in its tree, or a lease not released.
  for (const t of tasks.filter((x) => x.state !== 'done')) {
    const a = W.active(t);
    // An idle worker (its turn handed back) does not block: that is the state after a failed evaluation. Running, starting and parked do.
    const w = a && rows.currentAll(E.store, 'worker').find((x) => x.worktree && W.under(x.worktree, a.path) && (x.state === 'paused' || (['running', 'starting'].includes(x.state) && x.pid != null && pidAlive(x.pid)))) || null;
    if (w) throw err('E_WORKER_LIVE', `worker ${w.id} (${w.state}) works in task ${t.id}'s tree ${a.path}; a task still being worked is not merged, even forced`, { task_id: t.id, worker_id: w.id, state: w.state });
    const l = rows.currentLeaseForTask(E.store, t.id);
    if (l && l.released_at == null) throw err('E_PRECONDITION', `task ${t.id} is leased to ${l.holder} and not released; a task still being worked is not merged, even forced`, { task_id: t.id, lease_id: l.id, holder: l.holder });
  }
  // A fix task works on the branch of the work it fixes: merging the done work would take the open fix's unreviewed commits.
  for (const t of tasks) {
    const open = W.openSharer(E, t);
    if (open) throw err('E_PRECONDITION', `task ${t.id}'s branch ${t.worktree.branch} is shared with task ${open.id} (${open.state}), which is not done; merge once it is done or cancelled`, { task_id: t.id, branch: t.worktree.branch, open_task_id: open.id, open_state: open.state });
  }
  const repo = tasks[0].worktree.repo;
  const other = tasks.find((t) => !G.samePath(t.worktree.repo, repo));
  if (other) throw err('E_PRECONDITION', `task ${other.id}'s branch is in ${other.worktree.repo}, not ${repo}; integrate each repository's tasks in a call of their own`, { task_id: other.id, repo: other.worktree.repo, expected: repo });
  const dirty = [];
  for (const t of tasks) {
    const a = W.active(t);
    if (a && fs.existsSync(a.path)) { const d = await G.dirtyPaths(a.path); if (d.length) dirty.push({ task_id: t.id, path: a.path, dirty: d.slice(0, 20) }); }
  }
  if (dirty.length) throw err('E_PRECONDITION', `a merge would leave uncommitted work behind in ${dirty.map((d) => d.task_id).join(', ')}; commit it first`, { dirty });
  for (const t of tasks) {
    if (J.judgedOf(t) || t.state !== 'done') continue; // a forced task not done may have been judged on nothing: its branch head is merged
    const h = await G.run(repo, ['rev-parse', '--verify', `refs/heads/${t.worktree.branch}^{commit}`]);
    const head = h.ok ? h.stdout.trim() : null;
    throw err('E_PRECONDITION', `task ${t.id} records nothing it was judged on (it was evaluated before belay recorded it), so belay cannot tell its work from what came after on ${t.worktree.branch} (head ${head || 'unresolved'}); judge the branch again as a new task`, { task_id: t.id, branch: t.worktree.branch, branch_head: head });
  }
  return { tasks, repo, targets: await targetsOf(E, tasks, repo) };
}

// ADR 0060 decisions 4 and 6: integrate merges what was judged. Each branch is merged at the commit that is the newest judgement
// among the done tasks on it (judged.cjs commitOf: the newest commit whose tree is the judged content, or an old row's head), never
// at a branch head past it. When no commit on the branch is that content (judged uncommitted and never committed as judged, or
// committed with more changes), the merge is refused before anything is written. A branch that does not resolve is left to the
// merge, which records it failed.
async function targetsOf(E, tasks, repo) {
  const targets = new Map();
  for (const t of tasks) {
    const own = t.state !== 'done' && J.judgedOf(t) ? [t] : []; // a forced task not done is judged on what its own failing evaluation recorded
    const on = [...J.onBranch(E, t), ...own].sort((a, b) => Number(a.results.evaluated_at) - Number(b.results.evaluated_at));
    const by = on[on.length - 1];
    const h = await G.run(repo, ['rev-parse', '--verify', `refs/heads/${t.worktree.branch}^{commit}`]);
    if (!h.ok) continue;
    const tip = h.stdout.trim();
    if (t.state !== 'done' && !own.length) { targets.set(t.id, { by: null, sha: tip, tip, on: [], unjudged: true }); continue; }
    if (!by) continue;
    const sha = await J.commitOf(repo, by, tip);
    if (!sha) {
      const j = J.judgedOf(by);
      throw err('E_PRECONDITION', `no commit on ${t.worktree.branch} (head ${tip}) is what task ${by.id} was judged on (tree ${j.tree || j.head}); commit exactly the judged state, or merge it as a new task`,
        { task_id: t.id, judged_by: by.id, judged_tree: j.tree, judged_head: j.head, branch: t.worktree.branch, branch_head: tip });
    }
    targets.set(t.id, { by, sha, tip, on });
  }
  return targets;
}

// ADR 0072 decision 5: a policy step's merge goes into the run's own integration branch and nowhere else, and carries no authority past it.
// The branch is fixed here, not by the caller: `into` is refused unless it spells that branch, and force, approval, approved_in_chat and
// take_over are refused outright (merging into a user branch stays the orchestrator's under the merge gate). -> the open claim, or null for
// every other caller. Called before anything is read or written.
const POLICY_REFUSED = ['force', 'approval', 'approved_in_chat', 'take_over'];
function policyGuard(E, caller, args) {
  const claim = PS.openClaim(E, caller);
  if (!claim) return null;
  const own = `belay/integrate/${caller.run_id}`;
  for (const k of POLICY_REFUSED) if (args[k] !== undefined) throw err('E_ARGS', `integration.merge: a policy step does not pass ${k}; it merges into ${own} only`, { field: k, policy_step: claim.seq });
  if (args.into !== undefined && args.into !== own) throw err('E_ARGS', `integration.merge: a policy step merges into ${own} only, not ${args.into}`, { field: 'into', policy_step: claim.seq });
  return claim;
}

// One trigger, one step, for a merge (ADR 0072 decision 2): when every task of the call is already on the branch (the merge a step would make
// has been made) and one kind of writer, a policy step or the orchestrator, merged them, there is nothing to write. The orchestrator's call is
// answered with the policy step's integration row, `existing: true`; a policy step after the orchestrator is PS.duplicate's tie-break. Extra
// checks or an evaluation still owed make it a new merge. Called holding the branch's integrate lock, in its tree. -> the answer, or null.
async function standingMerge(E, caller, args, at, view) {
  if ((args.checks || []).length) return null;
  const merged = (id) => rows.currentAll(E.store, 'integration').some((r) => r.into_branch === at.into && G.samePath(r.repo, at.repo) && Array.isArray(r.merged) && r.merged.some((m) => m && m.task_id === id));
  if (!args.task_ids.every(merged)) return null; // no git is asked for a call that merges something new
  const on = (await require('./integration-incremental.cjs').carriedOf(E, at.tree, at.repo, at.into, new Set())).entries; // what the branch holds now, this call's tasks included
  if (!args.task_ids.every((id) => on.some((c) => c.task_id === id))) return null;
  const from = [...new Set(args.task_ids.map((id) => on.find((c) => c.task_id === id).carried_from))].map((id) => rows.current(E.store, 'integration', id));
  const kinds = new Set(from.map((r) => PS.byPolicy(E.store, 'integration', r.id)));
  if (kinds.size !== 1) return null;
  const row = from.reduce((x, y) => (y.seq > x.seq ? y : x));
  if (args.evaluate !== false && row.checks == null) return null;
  if (PS.stepOf(caller) === null && !kinds.has(true)) return null; // the orchestrator's own earlier merge: a repeat is the call as it was
  return PS.duplicate(E, caller, 'integration', row.id, { ...view(row), existing: true });
}

module.exports = { checkTakeOver, checkArgs, readTasks, targetsOf, policyGuard, standingMerge, MAX_TASKS, MAX_REASON };
