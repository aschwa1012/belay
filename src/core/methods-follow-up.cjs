'use strict';
// methods-follow-up.cjs — ADR 0064: a follow-up is a task made for a held review's should-fix findings. It is not a fix round: it
// carries no `repairs` and no `answers`, so max_fix_rounds never counts it and it never answers a refutation. Its own record is
// `follows_up: { review_id, review_ids, task_id, root }`, written only here, and its own cap is the run's max_follow_ups, counted
// per root work. It depends on the judged task and works in a tree of its own, cut from the judged head, so nothing shares a branch
// with the work it follows: the judged task stays done and integrable, and a fix of the follow-up gates only the follow-up.

const { err } = require('./errors.cjs');
const rows = require('./rows.cjs');

const FINDINGS_MAX = 2000; // bytes of findings quoted into the default spec

// A finding's severity, lower-cased with spaces, underscores and hyphens removed (the rule the review wake uses); only an object
// that says should-fix counts. A bare string, or a finding with no severity, is not one.
const shouldFix = (f) => !!f && typeof f === 'object' && !Array.isArray(f) && typeof f.severity === 'string' && f.severity.toLowerCase().replace(/[\s_-]/g, '') === 'shouldfix';

function defaultSpec(F, quoted, judged) {
  const room = Math.floor(FINDINGS_MAX / quoted.length);
  const said = quoted.map(({ review, findings }) => {
    let lines = findings.map(F.findingLine).filter(Boolean).map((l) => `- ${l}`).join('\n');
    if (Buffer.byteLength(lines, 'utf8') > room) lines = `${Buffer.from(lines, 'utf8').subarray(0, room).toString('utf8')}...`;
    const detail = F.verdictDetail(review);
    return `Review ${review.id}${detail.summary ? ` said: ${detail.summary}` : ''}\nFindings:\n${lines}`;
  });
  const ids = quoted.map((q) => q.review.id).join(', ');
  return `Follow up on ${quoted.length > 1 ? 'reviews' : 'review'} ${ids} of task ${judged.id}. Task ${judged.id} is done and can be integrated without this task; this one covers the should-fix findings (original ask, task ${judged.id}: ${F.brief(judged.spec)}).\n${said.join('\n')}`;
}

// The work a follow-up counts against, resolved through the whole chain: a follow-up's recorded root, else the work a fix repairs
// (a fix of a follow-up resolves to that follow-up's root), else the task itself. So every descendant counts against one work.
function rootOf(E, judged) {
  let t = judged;
  for (let i = 0; i < 100; i++) {
    if (t.follows_up && t.follows_up.root) return t.follows_up.root;
    if (!t.repairs) return t.id;
    const next = rows.current(E.store, 'task', t.repairs);
    if (!next) throw err('E_NOT_FOUND', `task ${t.id} repairs ${t.repairs}, which has no row in this store`, { task_id: t.id, missing_repairs: t.repairs });
    t = next;
  }
  throw err('E_PRECONDITION', `the repairs chain of task ${judged.id} does not end in 100 steps; it may loop, so no root work can be named`, { task_id: judged.id });
}

const reviewIdsOf = (t) => (Array.isArray(t.follows_up.review_ids) ? t.follows_up.review_ids : [t.follows_up.review_id]);
// A follow-up of this run, in any state but cancelled, for this judged task that already covers the review (the idempotency key).
const openFor = (E, runId, taskId, reviewId) => rows.currentAll(E.store, 'task').find((t) => t.follows_up && t.follows_up.task_id === taskId && t.run_id === runId && t.state !== 'cancelled' && reviewIdsOf(t).includes(reviewId)) || null;

// The tasks of this run that follow up `root`, cancelled ones included.
const usedFor = (E, runId, root) => rows.currentAll(E.store, 'task').filter((t) => t.follows_up && t.follows_up.root === root && t.run_id === runId).length;
const capOf = (E, runId) => { const run = rows.current(E.store, 'run', runId); return run && run.max_follow_ups != null ? Number(run.max_follow_ups) : null; };

// Called by task.create for a task that follows up, in the turn that writes it: a follow-up already open for the review is
// reported (E_EXISTS naming it, so the caller returns it), then the cap (decision 5), writing nothing. A run row with no value
// (an operator's own session, an older store) is not enforced.
function checkCap(E, caller, id, fu) {
  const open = openFor(E, caller.run_id, fu.task_id, fu.review_id);
  if (open) throw err('E_EXISTS', `a follow-up for review ${fu.review_id} is already open: ${open.id}`, { follow_up_existing: open.id });
  const cap = capOf(E, caller.run_id);
  if (cap == null) return;
  const used = usedFor(E, caller.run_id, fu.root);
  if (used >= cap) {
    throw err('E_FOLLOW_UPS', `work ${fu.root} already has ${used} follow-up${used === 1 ? '' : 's'} and this run's max_follow_ups is ${cap}; nothing was written. Use task_create for work that should not be counted, or leave the findings open`, { task_id: id, root: fu.root, used, max_follow_ups: cap });
  }
}

// The commit the work was judged at, where integrate merges it (judged.commitOf from the branch tip), never the head an evaluation
// stood on: a work judged with uncommitted changes has no such commit until it is committed as judged.
async function judgedCommit(judged, rec) {
  const G = require('./git.cjs'), J = require('./judged.cjs');
  const tip = await G.run(rec.repo, ['rev-parse', '--verify', `refs/heads/${rec.branch}^{commit}`]);
  const sha = tip.ok && J.judgedOf(judged) ? await J.commitOf(rec.repo, judged, tip.stdout.trim()) : null;
  if (!sha) {
    throw err('E_PRECONDITION', `no commit on ${rec.branch} is what task ${judged.id} was judged on; commit exactly the judged state in its tree, then call again`, { task_id: judged.id, branch: rec.branch, branch_head: tip.ok ? tip.stdout.trim() : null });
  }
  return sha;
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
  const ix = RS.index(E.store, all);
  const stands = RS.ofTask(judged, ix);
  if (stands && stands.state !== 'holds') {
    throw err('E_PRECONDITION', `the work's review is ${stands.state}, decided by review ${stands.review_id}; that review decides before this one. Fix or re-judge first`, { review_id: review.id, task_id: judged.id, deciding_review: stands.review_id, state: stands.state });
  }
  const root = rootOf(E, judged), cap = capOf(E, caller.run_id);
  const left = () => (cap == null ? null : Math.max(0, cap - usedFor(E, caller.run_id, root)));
  const reply = (row, extra) => ({ ...row, from_review: review.id, ...extra, follow_ups_left: left() });
  const open = openFor(E, caller.run_id, judged.id, review.id);
  if (open) return reply(open, { existing: true });
  // Every held review of this work that no follow-up covers yet is quoted, so another reviewer's findings are not dropped.
  const covered = new Set(all.filter((t) => t.follows_up && t.state !== 'cancelled' && t.follows_up.task_id === judged.id).flatMap(reviewIdsOf));
  const others = (ix.reviewsOf.get(judged.id) || []).filter((r) => r.id !== review.id && RS.verdictOf(r) === 'holds' && !covered.has(r.id));
  const findingsOf = (r) => (Array.isArray(F.verdictDetail(r).findings) ? F.verdictDetail(r).findings : []).filter(shouldFix);
  const quoted = [review, ...others].map((r) => ({ review: r, findings: findingsOf(r) })).filter((q) => q.findings.length);
  let spec = typeof args.spec === 'string' && args.spec.trim() ? args.spec : null;
  if (!spec) {
    if (!quoted.length) throw err('E_ARGS', `review ${review.id} lists no should-fix finding; pass spec to say what the follow-up is for`, { review_id: review.id });
    spec = defaultSpec(F, quoted, judged);
  }
  const reviewIds = [review.id, ...quoted.map((q) => q.review.id).filter((id) => id !== review.id)];
  // Its own tree and branch, cut from the head the work was judged at (the tree-making of task.create, removed again if the write is refused).
  const rec = F.inheritedTree(judged);
  const cut = rec ? await judgedCommit(judged, rec) : null;
  let row;
  try {
    row = await T.create(E, caller, {
      spec,
      acceptance: args.acceptance !== undefined ? args.acceptance : judged.acceptance,
      files_owned: F.ownedSet(args.files_owned, judged, rec),
      depends_on: [judged.id],
      ...(cut ? { worktree: cut } : {}),
      ...(args.id ? { id: args.id } : {}),
    }, { follows_up: { review_id: review.id, review_ids: reviewIds, task_id: judged.id, root } });
  } catch (e) {
    const id = e && e.code === 'E_EXISTS' && e.detail && e.detail.follow_up_existing;
    const again = id && rows.current(E.store, 'task', id);
    const d = (e && e.detail) || {};
    if (again) return reply(again, { existing: true, ...(d.rollback_incomplete ? { rollback_incomplete: true, left: d.left } : {}), ...(d.rollback ? { rollback: d.rollback } : {}) });
    throw e;
  }
  return reply(row, {});
}

module.exports = { followUp, checkCap, shouldFix, rootOf };
