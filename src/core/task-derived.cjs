'use strict';
// task-derived.cjs — the facts a task view carries beside `state`, derived on every read and never stored: whether the task's
// branch landed (`integration`, ADR 0053 amendment 2) and whether the work's review held (`review`, ADR 0060). `context` reads the
// rows once, so task.list derives every task from one read; task.get builds it for one task.

const rows = require('./rows.cjs');
const integrationState = require('./integration-state.cjs');
const reviewState = require('./review-state.cjs');

const branchKey = (t) => (t.worktree && t.worktree.branch ? `${String(t.worktree.repo || '').replace(/\\/g, '/').toLowerCase()}\0${t.worktree.branch}` : null);

function context(E) {
  const all = rows.currentAll(E.store, 'task');
  const byBranch = new Map();
  for (const t of all) { const k = branchKey(t); if (k) (byBranch.get(k) || byBranch.set(k, []).get(k)).push(t); }
  return { integrations: integrationState.newestFirst(E.store), reviews: reviewState.index(E.store, all), byBranch, all };
}

// The other tasks on the task's branch in its repository (a fix and the work it fixes share one, task.fixFromReview).
const peersOf = (ctx, task) => { const k = branchKey(task); return k ? (ctx.byBranch.get(k) || []).filter((t) => t.id !== task.id) : []; };

function of(task, ctx) {
  return { integration: integrationState.ofTask(task, ctx.integrations, peersOf(ctx, task)), review: reviewState.ofTask(task, ctx.reviews) };
}

// ADR 0061 section 3: the hand-back names a `head` that is not the head the last results were judged at (a follow-up the
// orchestrator evaluated itself, with no second hand-back). Either may be abbreviated, so one is compared as a prefix of the other.
function handoffStale(task) {
  const said = task.handoff && task.handoff.result && typeof task.handoff.result.head === 'string' ? task.handoff.result.head.trim().toLowerCase() : '';
  const j = said ? require('./judged.cjs').judgedOf(task) : null; // the results' head, or the files check's on an older row
  const judged = j && typeof j.head === 'string' ? j.head.toLowerCase() : '';
  if (!/^[0-9a-f]{4,64}$/.test(said) || !judged) return false;
  return !(judged.startsWith(said) || said.startsWith(judged));
}

module.exports = { context, of, peersOf, handoffStale };
