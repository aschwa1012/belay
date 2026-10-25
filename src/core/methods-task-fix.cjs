'use strict';
// methods-task-fix.cjs — task.fixFromReview (ADR 0058 decision 3): the fix task a refuted review calls for, with the fields
// the orchestrator prompt used to spell out inferred from the store. The fix depends on the task the review judged (ADR 0030:
// the work it fixes, never the review), repairs the original work task (a fix of a fix repairs the same work, so the rounds
// count against one cap, ADR 0031 decision 6), and is written by task.create, which enforces max_fix_rounds (E_FIX_ROUNDS).

const { err } = require('./errors.cjs');
const rows = require('./rows.cjs');

const SPEC_FINDINGS_MAX = 2000; // bytes of findings quoted into the default spec

function verdictDetail(review) {
  const checks = review.results && Array.isArray(review.results.checks) ? review.results.checks : [];
  const v = checks.find((c) => c && c.kind === 'verdict');
  return v && v.detail ? v.detail : {};
}

// The work as first specified (the original task's spec, never a fix's, which would quote an earlier round) and only this
// review's findings: a fix of a fix does not carry stale findings forward, and the spec does not grow with the rounds.
function defaultSpec(review, judged, original, detail) {
  let findings = '';
  if (Array.isArray(detail.findings) && detail.findings.length) {
    findings = JSON.stringify(detail.findings);
    if (Buffer.byteLength(findings, 'utf8') > SPEC_FINDINGS_MAX) findings = `${Buffer.from(findings, 'utf8').subarray(0, SPEC_FINDINGS_MAX).toString('utf8')}...`;
  }
  const work = original.id === judged.id ? `(${original.spec})` : `(a fix of task ${original.id}: ${original.spec})`;
  return `Fix the blocking findings of review ${review.id} on task ${judged.id} ${work}. The reviewer said: ${detail.summary || '(no summary)'}${findings ? ` Findings: ${findings}` : ''}`;
}

// The fix is worked in the judged task's tree, on its branch, from its base: the coder that did the work, idle in that tree,
// can take the fix by task.assign, and the fix's files check judges the whole branch against the work's base. A removed tree
// is not inherited. task.worktreeRemove records the removal on every task that shares the tree.
function inheritedTree(judged) {
  const rec = require('./methods-worktree.cjs').active(judged);
  return rec ? { ...rec, inherited_from: rec.inherited_from || judged.id } : null;
}

// The fix's files_owned: the judged task's by default. In a shared tree the files check judges the whole branch from the work's
// base, so the work's files are changed files of the fix too: a set the caller names is joined to the judged task's, never
// narrower (a narrower set would always fail files_within_owned). A malformed set is left for task.create to refuse.
function ownedSet(given, judged, tree) {
  if (given === undefined) return judged.files_owned;
  if (!tree || !Array.isArray(given) || !Array.isArray(judged.files_owned)) return given;
  return [...new Set([...judged.files_owned, ...given])];
}

async function fixFromReview(E, caller, args) {
  const T = require('./methods-task.cjs');
  if (!args.review_id || typeof args.review_id !== 'string') throw err('E_ARGS', 'task.fixFromReview needs the review_id of a refuted review task');
  const review = rows.current(E.store, 'task', args.review_id);
  if (!review) throw err('E_NOT_FOUND', `no task row exists for ${args.review_id}`, { review_id: args.review_id });
  if (!review.acceptance || review.acceptance.verdict !== true) throw err('E_ARGS', `task ${review.id} is not a review task (its acceptance has no verdict: true)`, { review_id: review.id });
  if (!T.refutedReview(review)) {
    throw err('E_PRECONDITION', `review ${review.id} was not last evaluated refuted (an executable verdict check that failed); evaluate it first, and fix only after a refuted review`, { review_id: review.id, state: review.state });
  }
  const under = Array.isArray(review.depends_on) ? review.depends_on : [];
  const judgedId = under.length === 1 ? under[0] : args.repairs;
  if (!judgedId || !under.includes(judgedId)) {
    throw err('E_ARGS', `review ${review.id} judged ${under.length} tasks (${under.join(', ')}); name the one to fix as repairs`, { review_id: review.id, depends_on: under });
  }
  const judged = rows.current(E.store, 'task', judgedId);
  if (!judged) throw err('E_NOT_FOUND', `review ${review.id} depends on ${judgedId}, which has no row in this store`, { review_id: review.id, missing: judgedId });
  const repairs = judged.repairs || judged.id;
  const original = (judged.repairs && rows.current(E.store, 'task', judged.repairs)) || judged;
  // Called again for the same review, the fix it already made is returned, and no fix round is spent: an open fix task of this
  // run that repairs the same work and depends on exactly the judged task.
  const live = new Set(['open', 'assigned', 'released']);
  const same = rows.currentAll(E.store, 'task').find((t) => t.run_id === caller.run_id && t.repairs === repairs && live.has(t.state)
    && Array.isArray(t.depends_on) && t.depends_on.length === 1 && t.depends_on[0] === judged.id);
  if (same) return { ...same, from_review: review.id, existing: true };
  const tree = inheritedTree(judged);
  const row = await T.create(E, caller, {
    spec: typeof args.spec === 'string' && args.spec.trim() ? args.spec : defaultSpec(review, judged, original, verdictDetail(review)),
    acceptance: args.acceptance !== undefined ? args.acceptance : judged.acceptance,
    files_owned: ownedSet(args.files_owned, judged, tree),
    depends_on: [judged.id],
    repairs,
    ...(args.id ? { id: args.id } : {}),
  }, { worktree: tree });
  return { ...row, from_review: review.id };
}

module.exports = { fixFromReview };
