'use strict';
// done-wake.cjs — "implementation done", the plan-first run's one routine wake (ADR 0074 amendment 4). Under a plan the orchestrator is woken on
// exceptions only; when every planned task has gone the whole way, belay says so once, and the digest of its steps follows the wake. Derived
// from the policy watcher's snapshot of the poll (no read of its own), from store rows only, never from a worker's words.
//
// Done, exactly: the run has at least one planned work task (a task under a plan that is neither a fix, a follow-up nor a review), and
//   1. every task of the run that is not cancelled is `done`, except a review a fix round has settled: one that judged a work whose current
//      decision is a later review (a refuted review stays `released` when the re-review is a new task);
//   2. every planned work task whose plan has `review` has a review that holds, and every one whose plan has `integrate` is merged;
//   3. when any plan integrates: the newest integration into the run's own branch (`belay/integrate/<run>`) is merged and its checks did not
//      fail; `passed: null` (a merge with `evaluate: false`) is done with the wake saying the checks were not run. A plan that integrates
//      nothing needs no integration, and the wake says nothing was merged;
//   4. no exception halts a task, no policy step is due on these rows, and no claim is still `started`.
// The key is the newest integration's id and seq (or the tasks' highest seq when nothing integrates): the same state sends it once, a later
// fix and merge send a new one.

const { due } = require('./policy-exec.cjs');
const PW = require('./policy-wakes.cjs');

const WAKE_TEXT_MAX = PW.WAKE_TEXT_MAX;
const isReview = (t) => !!(t.acceptance && t.acceptance.verdict === true);
const short = (s) => (s ? String(s).slice(0, 12) : '?');
const answeredBy = (all, R) => all.some((u) => u.follows_up && (u.follows_up.review_id === R.id || (Array.isArray(u.follows_up.review_ids) && u.follows_up.review_ids.includes(R.id))));

// A review task that is not `done` but settled: it carries an evaluated verdict, and the work it judged (through its fixes) is now decided by
// another review. A review with no verdict yet, or the one that decides, is not settled.
function settled(r, byId) {
  if (r.state === 'done') return true;
  if (!(r.results && r.results.trigger === 'release' && r.results.evaluated_at != null)) return false;
  const judged = byId.get((Array.isArray(r.depends_on) ? r.depends_on : [])[0]);
  if (!judged) return false;
  const root = PW.rootOf(judged, byId);
  return !!(root.review && root.review.review_id && root.review.review_id !== r.id);
}

// -> { key, text, n, should_fix_left, checks } when the run is done, else null. `snap`: { runId, tasks, integrations, steps }; `exceptions`: derive() of the same rows.
function doneOf(snap, exceptions = []) {
  if (!snap || !Array.isArray(snap.tasks)) return null;
  const { runId } = snap;
  const all = snap.tasks;
  const byId = new Map(all.map((t) => [t.id, t]));
  const tasks = all.filter((t) => t.run_id === runId && t.state !== 'cancelled');
  const work = tasks.filter((t) => !isReview(t) && !t.repairs && !t.follows_up && PW.policyOf(t, byId));
  if (!work.length) return null;
  if (!tasks.every((t) => t.state === 'done' || (isReview(t) && settled(t, byId)))) return null;
  let integrates = false;
  for (const t of work) {
    const plan = PW.policyOf(t, byId);
    if (plan.review && !(t.review && t.review.state === 'holds')) return null;
    if (plan.integrate) { integrates = true; if (!(t.integration && t.integration.state === 'merged')) return null; }
  }
  const own = `belay/integrate/${runId}`;
  const newest = (snap.integrations || []).filter((i) => i.run_id === runId && i.into_branch === own).reduce((a, b) => (!a || Number(b.seq) > Number(a.seq) ? b : a), null);
  if (integrates && (!newest || !['merged', 'evaluated'].includes(newest.state) || newest.passed === false)) return null; // evaluated: merged, then its checks ran on the head
  // A halt on a finished task (done or cancelled) holds nothing back when it is an E1 for a step the finished work does not need (a missing re_review, fix or build:
  // the work was judged and merged by its own steps, checked above). The other halts name a failure, or an absent review or integrate (work the plan never did): they hold it.
  const finishedE1 = (e) => { const t = byId.get(e.task_id); return e.exception === 'E1' && !['review', 'integrate'].includes(e.field) && !!t && (t.state === 'done' || t.state === 'cancelled'); };
  const skipped = exceptions.filter((e) => finishedE1(e) && PW.haltedIds([e], all).size);
  if (PW.haltedIds(exceptions.filter((e) => !finishedE1(e)), all).size) return null;
  const finished = { size: skipped.length };
  if (due({ runId, tasks: all, integrations: snap.integrations || [], steps: snap.steps || [], rounds: snap.rounds, failures: snap.failures }).length) return null;
  if ((snap.steps || []).some((s) => s.run_id === runId && s.outcome === 'started')) return null;
  const n = work.length;
  // Should-fix findings a held review left with no follow-up (the run's max_follow_ups was reached, or the plan has no follow_up): named, not waking.
  const left = tasks.filter((t) => !isReview(t) && !t.repairs && PW.policyOf(t, byId)).filter((t) => { /* the work and its follow-ups */ const R = byId.get(t.review && t.review.review_id); const f = R ? require('./review-wake.cjs').reviewOf(R) : null; return f && f.should_fix.n > 0 && !answeredBy(all, R); }).map((t) => t.id);
  const note = (left.length ? ` Should-fix findings left on ${left.length} task${left.length === 1 ? ' (see its review)' : 's (see their reviews)'}.` : '') + (finished.size ? ` ${finished.size} finished task${finished.size === 1 ? '' : 's'} still halted by an unlifted exception.` : '');
  const where = !integrates ? 'done and reviewed; the plan merges nothing' : `done, reviewed and merged into ${own} at ${short(newest.head_sha)}, ${newest.passed === true ? 'checks passed' : 'checks not run on the merged head'}`;
  const text = `belay: implementation done: ${n} planned task${n === 1 ? '' : 's'} ${where}.${note} Decide whether you are done.`;
  const key = integrates ? `${newest.id}@${newest.seq}` : `tasks@${Math.max(...tasks.map((t) => Number(t.seq) || 0))}`;
  const fallback = `belay: implementation done: ${n} planned tasks${integrates ? ` merged at ${short(newest.head_sha)}, checks ${newest.passed === true ? 'passed' : 'not run'}` : ''}.${left.length ? ` Should-fix left on ${left.length}.` : ''}${finished.size ? ` ${finished.size} halt${finished.size === 1 ? '' : 's'} unlifted.` : ''}`;
  return { key, text: Buffer.byteLength(text) <= WAKE_TEXT_MAX ? text : fallback, n, should_fix_left: left, checks: integrates ? (newest.passed === true ? 'passed' : 'not_run') : 'none' };
}

// The wake event, as the exception wakes are: an `evaluated`-shaped event whose text wake.cjs passes through.
const wakeOf = (runId, d) => ({ event: 'policy_done', worker_id: `done:${runId}`, turn: 0, seq: null, key: d.key, text: d.text });

module.exports = { doneOf, wakeOf };
