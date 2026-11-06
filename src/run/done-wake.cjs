'use strict';
// done-wake.cjs — "implementation done", the plan-first run's one routine wake (ADR 0074 amendment 4). Under a plan the orchestrator is woken on
// exceptions only; when every planned task has gone the whole way, belay says so once, and the digest of its steps follows the wake. Derived
// from the policy watcher's snapshot of the poll (no read of its own), from store rows only, never from a worker's words.
//
// Done, exactly: the run has at least one planned work task (a task under a plan that is neither a fix, a follow-up nor a review), and
//   1. every task of the run that is not cancelled is `done`;
//   2. every planned work task whose plan has `review` has a review that holds, and every one whose plan has `integrate` is merged;
//   3. the run's newest integration is merged and its checks passed (`passed: true`: the tasks' acceptance on the merged head);
//   4. no exception halts a task, no policy step is due on these rows, and no claim is still `started`.
// The key is the newest integration's id and seq: a later fix and merge make a new done wake; the same state makes none.

const { due } = require('./policy-exec.cjs');
const PW = require('./policy-wakes.cjs');

const WAKE_TEXT_MAX = PW.WAKE_TEXT_MAX;
const isReview = (t) => !!(t.acceptance && t.acceptance.verdict === true);
const short = (s) => (s ? String(s).slice(0, 12) : '?');

// -> { key, text, n } when the run is done, else null. `snap`: { runId, tasks, integrations, steps }; `exceptions`: derive() of the same rows.
function doneOf(snap, exceptions = []) {
  if (!snap || !Array.isArray(snap.tasks)) return null;
  const { runId } = snap;
  const all = snap.tasks;
  const byId = new Map(all.map((t) => [t.id, t]));
  const tasks = all.filter((t) => t.run_id === runId && t.state !== 'cancelled');
  const work = tasks.filter((t) => !isReview(t) && !t.repairs && !t.follows_up && PW.policyOf(t, byId));
  if (!work.length) return null;
  if (!tasks.every((t) => t.state === 'done')) return null;
  for (const t of work) {
    const plan = PW.policyOf(t, byId);
    if (plan.review && !(t.review && t.review.state === 'holds')) return null;
    if (plan.integrate && !(t.integration && t.integration.state === 'merged')) return null;
  }
  const ints = (snap.integrations || []).filter((i) => i.run_id === runId);
  const newest = ints.reduce((a, b) => (!a || Number(b.seq) > Number(a.seq) ? b : a), null);
  if (!newest || newest.state !== 'merged' || newest.passed !== true) return null;
  if (PW.haltedIds(exceptions, all).size) return null;
  if (due({ runId, tasks: all, integrations: snap.integrations || [] }).length) return null;
  if ((snap.steps || []).some((s) => s.run_id === runId && s.outcome === 'started')) return null;
  const n = work.length;
  const text = `belay: implementation done: ${n} planned task${n === 1 ? '' : 's'} done, reviewed and merged into ${newest.into_branch} at ${short(newest.head_sha)}, checks passed. Decide whether to end the run.`;
  return { key: `${newest.id}@${newest.seq}`, text: Buffer.byteLength(text) <= WAKE_TEXT_MAX ? text : `belay: implementation done: ${n} planned tasks merged at ${short(newest.head_sha)}, checks passed.`, n };
}

// The wake event, as the exception wakes are: an `evaluated`-shaped event whose text wake.cjs passes through.
const wakeOf = (runId, d) => ({ event: 'policy_done', worker_id: `done:${runId}`, turn: 0, seq: null, key: d.key, text: d.text });

module.exports = { doneOf, wakeOf };
