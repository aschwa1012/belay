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

// The work as first specified (the original task's spec, never a fix's, which would quote an earlier round) and the findings of
// the refutations this fix answers, all of them current (ADR 0060 decision 5): a fix of a fix carries no earlier round's spec or
// findings, and the spec does not grow with the rounds. The findings share one byte cap.
function defaultSpec(refs, judged, original) {
  const room = Math.floor(SPEC_FINDINGS_MAX / refs.length);
  const said = refs.map((r) => {
    const detail = verdictDetail(r);
    let findings = '';
    if (Array.isArray(detail.findings) && detail.findings.length) {
      findings = JSON.stringify(detail.findings);
      if (Buffer.byteLength(findings, 'utf8') > room) findings = `${Buffer.from(findings, 'utf8').subarray(0, room).toString('utf8')}...`;
    }
    return `${refs.length > 1 ? `Review ${r.id} said` : 'The reviewer said'}: ${detail.summary || '(no summary)'}${findings ? ` Findings: ${findings}` : ''}`;
  });
  const work = original.id === judged.id ? `(${original.spec})` : `(a fix of task ${original.id}: ${original.spec})`;
  return `Fix the blocking findings of review ${refs.map((r) => r.id).join(', ')} on task ${judged.id} ${work}. ${said.join(' ')}`;
}

// ADR 0060 decision 5: the refutations of the judged task that no fix answers yet (a fix not cancelled whose answers name it),
// oldest decision first, with the one asked for always among them; and whether a live fix of this run already answers it.
function unanswered(E, caller, judged, review, repairs) {
  const RS = require('./review-state.cjs');
  const all = rows.currentAll(E.store, 'task');
  const ix = RS.index(E.store, all);
  const fixes = all.filter((t) => !RS.isReview(t) && t.repairs === repairs);
  const live = new Set(['open', 'assigned', 'released']);
  const existing = fixes.find((f) => f.run_id === caller.run_id && live.has(f.state) && RS.answersOf(f, ix).includes(review.id));
  const covered = new Set(fixes.flatMap((f) => RS.answersOf(f, ix)));
  const at = (r) => Number(r.results && r.results.evaluated_at) || 0;
  const refs = (ix.reviewsOf.get(judged.id) || []).filter((r) => RS.verdictOf(r) === 'refuted' && (r.id === review.id || !covered.has(r.id))).sort((a, b) => at(a) - at(b));
  return { refs, existing };
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
  if (!review.acceptance || review.acceptance.verdict !== true) throw err('E_ARGS', `task ${review.id} is not a review task (its acceptance has no verdict: true); pass the id of the review task that judged the work`, { review_id: review.id });
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
  // Called again for a review an open fix of this run already answers (the same review, or another refutation that fix took in),
  // that fix is returned, and no fix round is spent. A refutation decided after the fix was made is not in it: it gets its own.
  const { refs, existing } = unanswered(E, caller, judged, review, repairs);
  if (existing) return { ...existing, from_review: review.id, existing: true };
  const tree = inheritedTree(judged);
  const row = await T.create(E, caller, {
    spec: typeof args.spec === 'string' && args.spec.trim() ? args.spec : defaultSpec(refs, judged, original),
    acceptance: args.acceptance !== undefined ? args.acceptance : judged.acceptance,
    files_owned: ownedSet(args.files_owned, judged, tree),
    depends_on: [judged.id],
    repairs,
    ...(judged.base ? { base: judged.base } : {}), // the same branch is judged from the same base
    ...(args.id ? { id: args.id } : {}),
  }, { worktree: tree, answers: refs.map((r) => r.id) });
  return { ...row, from_review: review.id };
}

module.exports = { fixFromReview };
