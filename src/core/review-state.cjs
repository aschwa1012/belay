'use strict';
// review-state.cjs — where a piece of work stands with its reviewers, derived from the task rows and never stored (ADR 0060).
// A work task is `done` when its own checks pass; whether its review held is this separate fact. The work is the chain of the
// original task and its fix tasks (`repairs`), and the latest review over any of them decides. No git and no write: task.list
// and task.get call it on whatever store they read.

const rows = require('./rows.cjs');

const isReview = (t) => !!(t && t.acceptance && t.acceptance.verdict === true);
const verdictCheck = (t) => (t.results && Array.isArray(t.results.checks) ? t.results.checks : []).find((c) => c && c.kind === 'verdict');

// What a review's last evaluation said: `holds` (it is done), `refuted` (an executable verdict that failed), else `pending`.
function verdictOf(r) {
  if (r.state === 'done') return 'holds';
  const v = verdictCheck(r);
  return v && v.executable === true && v.passed === false ? 'refuted' : 'pending';
}

// Built once per read: each task's creation order (its first row), the reviews by the task they judge, the fixes by the work
// they repair, and each run's fix cap.
function index(store, tasks) {
  const born = new Map(store.p('SELECT id, MIN(seq) AS s FROM task GROUP BY id').all().map((r) => [r.id, r.s]));
  const reviewsOf = new Map(), fixesOf = new Map();
  // A cancelled review judged nothing; a cancelled fix still spent its round, as task.create counts it.
  for (const t of tasks) {
    if (isReview(t)) {
      if (t.state === 'cancelled') continue;
      for (const d of t.depends_on || []) (reviewsOf.get(d) || reviewsOf.set(d, []).get(d)).push(t);
    } else if (t.repairs) (fixesOf.get(t.repairs) || fixesOf.set(t.repairs, []).get(t.repairs)).push(t);
  }
  const caps = new Map(rows.currentAll(store, 'run').map((r) => [r.id, r.max_fix_rounds == null ? null : Number(r.max_fix_rounds)]));
  return { born, reviewsOf, fixesOf, caps };
}

// `{ state: holds|refuted|pending, review_id, rounds, rounds_left }` for a work task or one of its fixes, from the latest review
// over the chain; null for work no review has named (a review task, unless something reviews it). `rounds` is the fix tasks made for the work;
// `rounds_left` is what its run's max_fix_rounds allows beyond them (null with no cap), so `refuted` with 0 left is work whose
// review failed with no fix round to spend.
function ofTask(task, ix) {
  const root = task.repairs || task.id;
  const fixes = (ix.fixesOf.get(root) || []).slice().sort((a, b) => ix.born.get(a.id) - ix.born.get(b.id));
  const reviews = [root, ...fixes.map((f) => f.id)].flatMap((id) => ix.reviewsOf.get(id) || []);
  if (!reviews.length) return null;
  const last = reviews.reduce((a, b) => (ix.born.get(b.id) > ix.born.get(a.id) ? b : a));
  const runId = fixes.length ? fixes[fixes.length - 1].run_id : task.run_id;
  const cap = ix.caps.has(runId) ? ix.caps.get(runId) : null;
  const used = fixes.filter((f) => f.run_id === runId).length;
  return { state: verdictOf(last), review_id: last.id, rounds: fixes.length, rounds_left: cap == null ? null : Math.max(0, cap - used) };
}

module.exports = { index, ofTask, verdictOf };
