'use strict';
// methods-follow-up.cjs — ADR 0064: a follow-up is a task made for a held review's should-fix findings. It is not a fix round: it
// carries no `repairs` and no `answers`, so max_fix_rounds never counts it and it never answers a refutation. Its own record is
// `follows_up: { review_id, task_id, root }`, written only here, and its own cap is the run's max_follow_ups, counted per root work.
// It depends on the judged task and inherits its tree, but nothing waits on it: the judged task stays done and integrable.

const { err } = require('./errors.cjs');
const rows = require('./rows.cjs');

const FINDINGS_MAX = 2000; // bytes of findings quoted into the default spec
const LIVE = new Set(['open', 'assigned', 'released']);

// A finding's severity, lower-cased with spaces, underscores and hyphens removed (the rule the review wake uses); only an object
// that says should-fix counts. A bare string, or a finding with no severity, is not one.
const shouldFix = (f) => !!f && typeof f === 'object' && !Array.isArray(f) && typeof f.severity === 'string' && f.severity.toLowerCase().replace(/[\s_-]/g, '') === 'shouldfix';

function defaultSpec(F, review, judged, findings) {
  let lines = findings.map(F.findingLine).filter(Boolean).map((l) => `- ${l}`).join('\n');
  if (Buffer.byteLength(lines, 'utf8') > FINDINGS_MAX) lines = `${Buffer.from(lines, 'utf8').subarray(0, FINDINGS_MAX).toString('utf8')}...`;
  const detail = F.verdictDetail(review);
  return `Follow up on review ${review.id} of task ${judged.id}. Task ${judged.id} is done and can be integrated without this task; this one covers the review's should-fix findings (original ask, task ${judged.id}: ${F.brief(judged.spec)}).\n${detail.summary ? `The reviewer said: ${detail.summary}\n` : ''}Findings:\n${lines}`;
}

const rootOf = (judged) => (judged.follows_up && judged.follows_up.root) || judged.repairs || judged.id;

// The tasks of this run that follow up `root`, cancelled ones included.
const usedFor = (E, runId, root) => rows.currentAll(E.store, 'task').filter((t) => t.follows_up && t.follows_up.root === root && t.run_id === runId).length;
const capOf = (E, runId) => { const run = rows.current(E.store, 'run', runId); return run && run.max_follow_ups != null ? Number(run.max_follow_ups) : null; };

// Decision 5: called by task.create for a task that follows up; refuses past the run's cap, writing nothing. A run row with no
// value (an operator's own session, an older store) is not enforced.
function checkCap(E, caller, id, fu) {
  const cap = capOf(E, caller.run_id);
  if (cap == null) return;
  const used = usedFor(E, caller.run_id, fu.root);
  if (used >= cap) {
    throw err('E_FOLLOW_UPS', `work ${fu.root} already has ${used} follow-up${used === 1 ? '' : 's'} and this run's max_follow_ups is ${cap}; nothing was written. Use task_create for work that should not be counted, or leave the findings open`, { task_id: id, root: fu.root, used, max_follow_ups: cap });
  }
}

async function followUp(E, caller, args) {
  const T = require('./methods-task.cjs'), F = require('./methods-task-fix.cjs'), RS = require('./review-state.cjs');
  if (!args.review_id || typeof args.review_id !== 'string') throw err('E_ARGS', 'task.fixFromReview with follow_up needs the review_id of a review that held');
  const review = rows.current(E.store, 'task', args.review_id);
  if (!review) throw err('E_NOT_FOUND', `no task row exists for ${args.review_id}`, { review_id: args.review_id });
  if (!RS.isReview(review)) throw err('E_ARGS', `task ${review.id} is not a review task (its acceptance has no verdict: true); pass the id of the review task that judged the work`, { review_id: review.id });
  const verdict = RS.verdictOf(review);
  if (verdict !== 'holds') {
    throw err('E_PRECONDITION', `review ${review.id} is ${verdict}, not holds; a follow-up is for a review that held${verdict === 'refuted' ? ' (call without follow_up for a refuted review)' : ''}`, { review_id: review.id, state: review.state, review: verdict });
  }
  const under = Array.isArray(review.depends_on) ? review.depends_on : [];
  const judgedId = under.length === 1 ? under[0] : args.repairs;
  if (!judgedId || !under.includes(judgedId)) {
    throw err('E_ARGS', `review ${review.id} judged ${under.length} tasks (${under.join(', ')}); name the one to follow up as repairs`, { review_id: review.id, depends_on: under });
  }
  const judged = rows.current(E.store, 'task', judgedId);
  if (!judged) throw err('E_NOT_FOUND', `review ${review.id} depends on ${judgedId}, which has no row in this store`, { review_id: review.id, missing: judgedId });
  if (judged.state !== 'done') throw err('E_PRECONDITION', `task ${judged.id} is ${judged.state}, not done; a follow-up follows work that is done`, { review_id: review.id, task_id: judged.id, state: judged.state });
  const all = rows.currentAll(E.store, 'task');
  const stands = RS.ofTask(judged, RS.index(E.store, all));
  if (stands && stands.state !== 'holds') {
    throw err('E_PRECONDITION', `the work's review is ${stands.state}, decided by review ${stands.review_id}; that review decides before this one. Fix or re-judge first`, { review_id: review.id, task_id: judged.id, deciding_review: stands.review_id, state: stands.state });
  }
  const root = rootOf(judged), cap = capOf(E, caller.run_id);
  const left = (extra) => (cap == null ? null : Math.max(0, cap - usedFor(E, caller.run_id, root) - extra));
  const existing = all.find((t) => t.follows_up && t.follows_up.review_id === review.id && t.follows_up.task_id === judged.id && t.run_id === caller.run_id && LIVE.has(t.state));
  if (existing) return { ...existing, from_review: review.id, existing: true, follow_ups_left: left(0) };
  let spec = typeof args.spec === 'string' && args.spec.trim() ? args.spec : null;
  if (!spec) {
    const findings = (Array.isArray(F.verdictDetail(review).findings) ? F.verdictDetail(review).findings : []).filter(shouldFix);
    if (!findings.length) throw err('E_ARGS', `review ${review.id} lists no should-fix finding; pass spec to say what the follow-up is for`, { review_id: review.id });
    spec = defaultSpec(F, review, judged, findings);
  }
  const tree = F.inheritedTree(judged);
  const row = await T.create(E, caller, {
    spec,
    acceptance: args.acceptance !== undefined ? args.acceptance : judged.acceptance,
    files_owned: F.ownedSet(args.files_owned, judged, tree),
    depends_on: [judged.id],
    ...(judged.base ? { base: judged.base } : {}),
    ...(args.id ? { id: args.id } : {}),
  }, { worktree: tree, follows_up: { review_id: review.id, task_id: judged.id, root } });
  return { ...row, from_review: review.id, follow_ups_left: left(0) };
}

module.exports = { followUp, checkCap, shouldFix, rootOf };
