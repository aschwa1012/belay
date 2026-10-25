'use strict';
// review-state.cjs — where a piece of work stands with its reviewers, derived from the task rows and never stored (ADR 0060).
// A work task is `done` when its own checks pass; whether its review held is this separate fact. The work is the chain of the
// original task and its fix tasks (`repairs`), and its reviews' decisions, by when each was made, decide. No git and no write:
// task.list and task.get call it on whatever store they read.

const rows = require('./rows.cjs');

const isReview = (t) => !!(t && t.acceptance && t.acceptance.verdict === true);
const verdictCheck = (t) => (t.results && Array.isArray(t.results.checks) ? t.results.checks : []).find((c) => c && c.kind === 'verdict');

// What a review's last evaluation said: `holds` (it is done), `refuted` (an executable verdict that failed), else `pending`.
function verdictOf(r) {
  if (r.state === 'done') return 'holds';
  const v = verdictCheck(r);
  return v && v.executable === true && v.passed === false ? 'refuted' : 'pending';
}

// Built once per read: each task's creation (its first row's seq and time), the reviews by the task they judge, the fixes by the work
// they repair, and each run's fix cap.
function index(store, tasks) {
  // SQLite takes the bare written_at from the row MIN(seq) chose: the first row's.
  const born = new Map(store.p('SELECT id, MIN(seq) AS s, written_at AS at FROM task GROUP BY id').all().map((r) => [r.id, { s: r.s, at: Number(r.at) }]));
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

const decidedAt = (r) => Number(r.results && r.results.evaluated_at) || 0;
const latest = (xs, at) => xs.reduce((a, b) => (at(b) > at(a) ? b : a));

// Which review decides, by when each decision was made (its evaluation), not when the review was created:
// 1. a refuted review decided after the newest fix was made (no fix answers it yet) wins, the latest such one, over any holds;
// 2. else a review created after the latest decision and not decided yet: pending, a newer judgement is under way;
// 3. else the latest decision; else (no review decided) pending.
function deciding(reviews, newestFixAt, ix) {
  const decided = reviews.filter((r) => verdictOf(r) !== 'pending');
  const open = decided.filter((r) => verdictOf(r) === 'refuted' && decidedAt(r) > newestFixAt);
  if (open.length) return latest(open, decidedAt);
  const last = decided.length ? latest(decided, decidedAt) : null;
  const newer = reviews.filter((r) => verdictOf(r) === 'pending' && (!last || ix.born.get(r.id).at > decidedAt(last)));
  if (newer.length) return latest(newer, (r) => ix.born.get(r.id).s);
  return last || latest(reviews, (r) => ix.born.get(r.id).s);
}

// `{ state: holds|refuted|pending, review_id, rounds, rounds_left }` for a work task or one of its fixes, from the review over the
// chain that decides (deciding); null for work no review has named (a review task, unless something reviews it). `rounds` is the
// fix tasks made for the work; `rounds_left` is what its run's max_fix_rounds allows beyond them (null with no cap), so
// `refuted` with 0 left is work whose review failed with no fix round to spend.
function ofTask(task, ix) {
  const root = task.repairs || task.id;
  const fixes = (ix.fixesOf.get(root) || []).slice().sort((a, b) => ix.born.get(a.id).s - ix.born.get(b.id).s);
  const reviews = [root, ...fixes.map((f) => f.id)].flatMap((id) => ix.reviewsOf.get(id) || []);
  if (!reviews.length) return null;
  const last = deciding(reviews, fixes.length ? ix.born.get(fixes[fixes.length - 1].id).at : -1, ix);
  const runId = fixes.length ? fixes[fixes.length - 1].run_id : task.run_id;
  const cap = ix.caps.has(runId) ? ix.caps.get(runId) : null;
  const used = fixes.filter((f) => f.run_id === runId).length;
  return { state: verdictOf(last), review_id: last.id, rounds: fixes.length, rounds_left: cap == null ? null : Math.max(0, cap - used) };
}

module.exports = { index, ofTask, verdictOf };
