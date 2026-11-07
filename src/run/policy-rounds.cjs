'use strict';
// policy-rounds.cjs — ADR 0074 amendment 5. A failure belay can see in the rows is a round of work for the builder, not a wake: the plan's
// `fix` step reaches the failures the review loop did not. Pure: rows in, the one thing to do out; policy-exec.cjs `due()` and
// policy-wakes.cjs `derive` both ask here, so a failure the plan carries is not also an exception. A step here is named for its reason, and
// the digest and the receipts print the name:
//   fix_eval     a hand-back whose own evaluation failed goes back to its builder (a round)
//   fix_run      a hand-back whose evaluation could not run, twice, goes back to its builder (a round)
//   rerun_eval   the evaluation that could not run is run again, once per hand-back (no round)
//   rerun_alone  a failure that ran beside other evaluations is run again with none beside it, once per hand-back (no round)
//   reask        a reviewer that released with no verdict is asked again, once per review (no round, a bound of its own)
//   fix_conflict an integrate conflict goes to the builder of the conflicting task as a fix task (a round: a `repairs` row)
//   fix_checks   integration checks that failed go to the builder as a fix task (a round)
//   fix_commit   a done hand-back with no commit past its base (or work left uncommitted) goes to the builder as a fix task (a round)
//   note_flaky   a pass on a retry is recorded as a fact (no round, no wake)
// A round is counted on the work the chain began from, against the run's max_fix_rounds (and fix_hard_cap): the fix tasks (`repairs`) and
// the round steps above, so every kind spends the one cap. At the cap nothing is due and E2 wakes (policy-wakes.cjs).

const ROUND_STEPS = new Set(['fix_eval', 'fix_run']); // steps that spend a round without making a fix task
const MERGE_FIX_STEPS = new Set(['fix_conflict', 'fix_checks', 'fix_commit']); // steps that make a fix task (a `repairs` row spends the round)
const RERUN_STEPS = new Set(['rerun_alone', 'rerun_eval']);
const SENDING = new Set(['fix_eval', 'fix_run', 'reask', 'fix_conflict', 'fix_checks', 'fix_commit']); // the steps that send a worker work (the budget rule)
const STEP_NAMES = new Set([...ROUND_STEPS, ...MERGE_FIX_STEPS, ...RERUN_STEPS, 'reask', 'note_flaky']);
const REASK_MAX = 1; // a reviewer is asked again once; past it the evaluation that could not judge wakes (E5)
const COUNTED = new Set(['done', 'started', 'superseded']);

const failing = (r) => ((r && r.checks) || []).filter((c) => c && c.passed === false);
const beside = (c) => (Array.isArray(c.concurrent) ? c.concurrent.length : 0);
const checkName = (c) => (c.kind === 'command' ? `command ${Array.isArray(c.argv) ? c.argv.slice(0, 3).join(' ') : '?'}${c.exit_code != null ? ` exit ${c.exit_code}` : ''}` : c.kind || '?');
const cleanRefutation = (r) => r.executable === true && failing(r).length > 0 && failing(r).every((c) => c.kind === 'verdict' && c.executable === true);
const isReviewTask = (t) => !!(t && t.acceptance && t.acceptance.verdict === true);
const handBy = (t) => (t && t.handoff && typeof t.handoff.by === 'string' ? t.handoff.by : null);
const rootOf = (t, byId) => { for (let n = 0; t && t.repairs && byId.get(t.repairs) && n < 100; n++) t = byId.get(t.repairs); return t; };
const reopened = (s) => s.outcome === 'skipped' && /^E_(PAUSED|NOT_NOW)/.test(s.error || ''); // a skip the claim reopens took nothing
const clean = (s, n) => String(s == null ? '' : s).replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, n);

// A run that states neither lever gets the documented max_fix_rounds default (2): the rounds are never unbounded.
const DEFAULT_MAX = 2;
const capsOf = (run) => {
  const hard = run && run.fix_hard_cap != null ? Number(run.fix_hard_cap) : null;
  return { max: run && run.max_fix_rounds != null ? Number(run.max_fix_rounds) : (hard == null ? DEFAULT_MAX : null), hard };
};
const WAIT_MAX_MS = 120000; // how long a failure waits for the run's other evaluations before it is run (or sent back) anyway

// `snap`: { runId, tasks (task.list rows, every run), steps, failures (release_failed events), caps, integrations }.
function ctxOf(snap) {
  const { runId } = snap;
  return {
    runId, now: snap.now != null ? Number(snap.now) : Date.now(), byId: new Map((snap.tasks || []).map((t) => [t.id, t])),
    tasks: (snap.tasks || []).filter((t) => t.run_id === runId),
    steps: (snap.steps || []).filter((s) => s.run_id === runId),
    failures: snap.failures || [], caps: snap.caps || { max: null, hard: null },
    integrations: (snap.integrations || []).filter((i) => i.run_id === runId),
  };
}

const rootIdOf = (rf, id) => { const t = rf.byId.get(id); return t ? rootOf(t, rf.byId).id : id; };
// The round steps taken for the work a chain began from (started ones count: the round is spent when it is claimed).
const stepRounds = (rf, rootId) => rf.steps.filter((s) => ROUND_STEPS.has(s.step) && COUNTED.has(s.outcome) && s.task_id && rootIdOf(rf, s.task_id) === rootId).length;
const fixTasks = (rf, rootId) => rf.tasks.filter((t) => t.repairs && !(t.follows_up && t.follows_up.root) && rootOf(t, rf.byId).id === rootId).length;
const used = (rf, rootId) => fixTasks(rf, rootId) + stepRounds(rf, rootId);
const left = (rf, rootId) => { const u = used(rf, rootId); const { max, hard } = rf.caps; return (max == null || u < max) && (hard == null || u < hard); };
// `cause` is the kind of the round that was wanted and `last` a short cut of why (the last error text), both for the E2 wake: the orchestrator reads why before it retries.
const capFact = (rf, rootId, cause, last) => ({ cap: true, used: used(rf, rootId), max: rf.caps.max != null ? rf.caps.max : rf.caps.hard, cause, last: clean(last, 80) });
const lastLine = (r) => { const c = failing(r).find((k) => k.detail && (k.detail.stderr_tail || k.detail.stdout_tail)); const t = c ? String(c.detail.stderr_tail || c.detail.stdout_tail).split('\n').map((l) => l.trim()).filter(Boolean).pop() : ''; return t || names(r); };

// Whether another evaluation of the run is running or queued: a hand-back not yet evaluated (not a stand-down, which is never evaluated, and not known lost),
// or a re-run in flight. Bounded: `since` is when the failure was evaluated, and past WAIT_MAX_MS it no longer waits (an evaluation lost with its adapter
// would otherwise hold it for ever).
function othersEvaluating(x, rf, since) {
  if (rf.steps.some((s) => RERUN_STEPS.has(s.step) && s.outcome === 'started')) return true; // never two re-runs at once, whatever the bound
  if (rf.now - Number(since || 0) > WAIT_MAX_MS) return false;
  const ev = (t) => t.results && Number(t.results.evaluated_at) >= Number(t.handoff.at);
  const lost = (t) => rf.failures.some((f) => f.task_id === t.id && Number(f.written_at) >= Number(t.handoff.at));
  return rf.tasks.some((t) => t.id !== x.id && t.state === 'released' && t.handoff && !t.handoff.stood_down && !ev(t) && !lost(t));
}

function names(r) {
  const f = failing(r).map(checkName);
  return f.length ? f.join(', ') : 'no executable check ran';
}

// -> what the plan does for a hand-back that did not pass, or null when the plan does not carry it (the exception stands):
//   { step, worker, prompt }   the step due now        { wait: true }   a step is in flight or the run's other evaluations finish first
//   { cap: true, used, max, cause }   a round is wanted and the cap is spent (E2)
// `x`: a task in `released` state; `P`: its plan.
function action(x, P, rf) {
  if (!x || x.state !== 'released' || !x.handoff) return null;
  const hand = Number(x.handoff.at);
  const r = x.results || {};
  const own = r.trigger === 'release' && Number(r.evaluated_at) >= hand; // belay's own evaluation of this hand-back
  const mine = (name) => rf.steps.filter((s) => s.task_id === x.id && s.step === name && !reopened(s));
  const since = (name) => mine(name).filter((s) => Number(s.at) >= hand);
  if (rf.steps.some((s) => s.task_id === x.id && (ROUND_STEPS.has(s.step) || RERUN_STEPS.has(s.step) || s.step === 'reask') && s.outcome === 'started')) return { wait: true };
  const root = rootOf(x, rf.byId);
  const round = (step, cause, prompt, last) => (left(rf, root.id)
    ? { step, worker: handBy(x), prompt: `${prompt} Fix round ${used(rf, root.id) + 1}${rf.caps.max != null ? ` of ${rf.caps.max}` : ''}.` }
    : capFact(rf, root.id, cause, last));
  if (own && !r.passed) {
    if (cleanRefutation(r)) return null; // the review's refutation: the fix step answers it
    if (isReviewTask(x)) {
      if (P.fix !== 'builder' || r.executable !== false || mine('reask').length >= REASK_MAX) return null;
      return { step: 'reask', worker: handBy(x), prompt: `belay: your hand-back of review ${x.id} carried no verdict. Judge the work and release the review with your verdict.` };
    }
    if (P.fix !== 'builder') return null;
    if (failing(r).some((c) => beside(c) > 0) && !since('rerun_alone').length) return othersEvaluating(x, rf, r.evaluated_at) ? { wait: true } : { step: 'rerun_alone', worker: handBy(x) };
    return round('fix_eval', 'tests red', `belay: your hand-back of task ${x.id} failed belay's own evaluation (${clean(`${names(r)}: ${lastLine(r)}`, 220)}). Fix it in your worktree, commit, and release the task again.`, lastLine(r));
  }
  if (!own && !isReviewTask(x) && P.fix === 'builder') {
    const f = rf.failures.filter((e) => e.task_id === x.id && e.code !== 'E_CANCELLED' && Number(e.written_at) >= hand).sort((a, b) => Number(a.seq) - Number(b.seq)).pop();
    if (!f) return null;
    if (!since('rerun_eval').length) return othersEvaluating(x, rf, f.written_at) ? { wait: true } : { step: 'rerun_eval', worker: handBy(x) };
    return round('fix_run', 'eval could not run', `belay: belay could not evaluate your hand-back of task ${x.id} (${clean(f.code, 40)}), here or on a second try. Make sure your work is committed, and release the task again.`, f.code);
  }
  return null;
}

// A pass on a retry (the core marks it `flaky`): a fact for the digest, once per evaluation. -> true when its note is due.
const flakyDue = (x, rf) => !!(x.state === 'done' && x.results && x.results.trigger === 'release' && x.results.flaky && x.handoff && Number(x.results.evaluated_at) >= Number(x.handoff.at)
  && !rf.steps.some((s) => s.step === 'note_flaky' && s.task_id === x.id && !reopened(s) && Number(s.at) >= Number(x.results.evaluated_at)));

const failedTask = (i, ids) => {
  const c = (Array.isArray(i.checks) ? i.checks : []).find((k) => k && k.passed === false && Array.isArray(k.task_ids) && k.task_ids.length && ids.includes(k.task_ids[0]));
  return c ? c.task_ids[0] : ids[ids.length - 1];
};
// An integration the plan made that stopped on a conflict, or whose checks failed, and no newer integration names its tasks.
// -> { kind, integration, task (the one to fix), root, rev, step, worker, ... } | the same with { cap: true, used, max } | null.
// `planFor(task)`: { plan, rev } or null (policy-exec.cjs planOf).
function mergeAction(i, rf, planFor) {
  if (i.acted_by !== 'policy') return null;
  const conflict = i.state === 'conflict';
  if (!conflict && !(i.state === 'evaluated' && i.passed === false)) return null;
  const ids = Array.isArray(i.task_ids) ? i.task_ids : [];
  // Superseded means a later merge of THAT task (task_ids are cumulative: a later row names the earlier tasks it carries). A later red merge that names it does not lift a failure.
  const tid = conflict ? ((i.conflict && i.conflict.task_id) || ids[0]) : failedTask(i, ids);
  if (rf.integrations.some((o) => o.id !== i.id && Number(o.seq) > Number(i.seq) && (Array.isArray(o.task_ids) ? o.task_ids : []).includes(tid) && (conflict || o.passed !== false))) return null;
  const w = rf.byId.get(tid);
  const P = w && w.state === 'done' ? planFor(w) : null;
  if (!P || P.plan.fix !== 'builder') return null;
  const root = rootOf(w, rf.byId);
  const base = { kind: conflict ? 'conflict' : 'checks', integration: i, task: w, root, rev: P.rev, cause: conflict ? 'integrate conflict' : 'integration checks failed' };
  if (!left(rf, root.id)) return { ...base, ...capFact(rf, root.id, base.cause, conflict ? ((i.conflict && i.conflict.files) || []).slice(0, 3).join(', ') : (Array.isArray(i.checks) ? i.checks.filter((c) => c && c.passed === false).map((c) => `${(Array.isArray(c.argv) ? c.argv.slice(0, 3).join(' ') : '?')}${c.exit_code != null ? ` exit ${c.exit_code}` : ''}`).join('; ') : '')) };
  return { ...base, step: conflict ? 'fix_conflict' : 'fix_checks', worker: handBy(w) };
}

// The branch is red when the newest integration into the run's own branch ran its checks and they failed. Nothing else is merged onto it only while the PLAN carries
// the red: a policy integration the plan sends back to its builder (a fix_checks step is due or its fix is open) or that is at the cap (E2 is raised). A merge the
// orchestrator made, a plan with no fix step, and a fix that was cancelled hold nothing: the E8 wakes as it always did and the other merges go on.
// -> { integration, root } (`root`: the work whose retry is to be merged) | null. `planFor(task)`: { plan, rev } or null.
function redOf(rf, planFor) {
  const own = `belay/integrate/${rf.runId}`;
  const newest = rf.integrations.filter((i) => !i.into_branch || i.into_branch === own).reduce((a, b) => (!a || Number(b.seq) > Number(a.seq) ? b : a), null);
  if (!newest || newest.state !== 'evaluated' || newest.passed !== false) return null;
  const m = planFor ? mergeAction(newest, rf, planFor) : null;
  if (!m) return null;
  const claim = rf.steps.find((s) => MERGE_FIX_STEPS.has(s.step) && s.trigger_id === newest.id && !reopened(s));
  const fix = claim && /^task:/.test(claim.row_ref || '') ? rf.byId.get(claim.row_ref.slice(5)) : null;
  if (claim && claim.outcome === 'done' && (!fix || fix.state === 'cancelled')) return null;
  return { integration: newest, root: m.root.id };
}

// The ids of the released hand-backs a failure is waiting on the run's other evaluations for (the idle close holds for them: the wait is bounded).
function waitingIds(rf, policyFor) {
  return rf.tasks.filter((x) => x.state === 'released' && x.handoff).filter((x) => { const P = policyFor(x); const a = P ? action(x, P, rf) : null; return !!(a && a.wait); }).map((x) => x.id);
}

// The newest fix task a merge-side step (fix_conflict, fix_checks) made for the work, once it is done: the work is merged again after it. null while it is
// still being worked, or when no such step finished.
function mergeFixOf(rf, rootId) {
  const s = rf.steps.filter((k) => MERGE_FIX_STEPS.has(k.step) && k.outcome === 'done' && /^task:/.test(k.row_ref || '') && k.task_id && rootIdOf(rf, k.task_id) === rootId).pop();
  const f = s ? rf.byId.get(s.row_ref.slice(5)) : null;
  return f && f.state === 'done' ? f : null;
}
// A done work whose judged head is its base (it committed nothing), or whose judged content is not all committed: integrate merges only a commit.
function noCommit(x) {
  const r = x && x.results; const base = x && x.worktree && x.worktree.base_sha;
  if (!x || x.state !== 'done' || x.repairs || isReviewTask(x) || !r || r.trigger !== 'release' || !x.handoff || !(Number(r.evaluated_at) >= Number(x.handoff.at))) return null;
  if (base && r.head_sha === base) return `nothing new on your branch since ${String(base).slice(0, 8)}`;
  if (r.uncommitted === true) return `uncommitted changes (${(r.uncommitted_paths || []).slice(0, 3).join(', ')})`;
  return null;
}
const commitFixOf = (rf, x) => { const s = rf.steps.filter((k) => k.step === 'fix_commit' && k.task_id === x.id && k.outcome === 'done' && /^task:/.test(k.row_ref || '')).pop(); return s ? rf.byId.get(s.row_ref.slice(5)) : null; };
// Review and merge of such a work wait until its commit fix is done.
const commitHeld = (x, rf) => !!noCommit(x) && !(commitFixOf(rf, x) && commitFixOf(rf, x).state === 'done');
// -> { step: 'fix_commit', worker, spec } | { cap: true, ... } | null; taken once per work (the fix task is the round, a `repairs` row).
function commitAction(x, P, rf) {
  const why = noCommit(x);
  if (!why || P.fix !== 'builder' || rf.steps.some((s) => s.step === 'fix_commit' && s.task_id === x.id && !reopened(s))) return null;
  if (!left(rf, x.id)) return capFact(rf, x.id, 'no commit since base', why);
  return { step: 'fix_commit', worker: handBy(x), spec: `Task ${x.id} was handed back done, but ${why}: commit your work in your worktree (git add, git commit), run your checks, and release the task again.` };
}
const isMergeFix = (rf, t) => rf.steps.some((s) => MERGE_FIX_STEPS.has(s.step) && s.row_ref === `task:${t.id}`);

// The text of a merge-side fix task (the spec): belay's facts only.
function mergeSpec(m, runId) {
  const i = m.integration; const branch = `belay/integrate/${runId}`;
  if (m.kind === 'conflict') {
    const files = i.conflict && Array.isArray(i.conflict.files) ? i.conflict.files.slice(0, 10).join(', ') : '';
    return `Integrate conflict: task ${m.task.id} conflicts with ${branch}${files ? ` in ${files}` : ''}. In your worktree, merge or rebase ${branch} into your branch and resolve the conflicts, run your checks, commit, and release.`;
  }
  const bad = (Array.isArray(i.checks) ? i.checks : []).filter((c) => c && c.passed === false).map((c) => `${(Array.isArray(c.argv) ? c.argv.slice(0, 3).join(' ') : '?')}${c.exit_code != null ? ` exit ${c.exit_code}` : ''}`);
  return `Integration checks failed after merging task ${m.task.id} into ${branch}: ${clean(bad.join('; ') || 'no check ran', 300)}. In your worktree, merge ${branch} into your branch, make those checks pass, commit, and release.`;
}

// The run's release_failed events (an evaluation that ended with no result), each with the task it was for; [] when there is no ledger read or it fails.
async function readFailures(core, runId) {
  if (!core || !core.memory || typeof core.memory.events !== 'function') return [];
  try { return (((await core.memory.events({ run_id: runId, kinds: ['release_failed'] })) || {}).events || []).map((e) => ({ ...e, task_id: e.task_id || (Array.isArray(e.row_ids) ? e.row_ids[0] : null) })); } catch { return []; }
}

module.exports = { waitingIds, redOf, RERUN_STEPS, commitAction, commitHeld, noCommit, readFailures, ctxOf, capsOf, action, flakyDue, mergeAction, mergeFixOf, isMergeFix, mergeSpec, stepRounds, used, left, failing, checkName, ROUND_STEPS, MERGE_FIX_STEPS, SENDING, STEP_NAMES, REASK_MAX };
