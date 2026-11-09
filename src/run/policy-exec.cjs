'use strict';
// policy-exec.cjs — the policy executor (ADR 0072 decisions 1, 6 and 8). It runs in the orchestrator adapter, beside the run manager, and
// is level-triggered: each pass reads the store's facts (task rows, integration rows, the run's step log) and derives which steps are due
// now; a step is taken only after its claim row is written (policy.claim, unique per trigger), acts only through core calls made for that
// claim (core.policyAs(seq): the core stamps what it writes), and ends with the claim finished (policy.finish) naming the row it wrote or
// why it did not. Nothing is remembered but the claim rows, so a pause, a resume or an adapter restart needs no event replay:
//   - a paused or ended run takes no claim; the first pass after the resume finds the triggers that arrived meanwhile and takes them in
//     row order (the trigger's seq);
//   - a task halted by an exception (policy-wakes.cjs haltedIds) takes no step until a later row of the orchestrator lifts it;
//   - a claim found `started` at the start of a pass belongs to a life that ended mid-step. Its effect may or may not have landed, so it is
//     finished `exception` (E8) and never resumed or retried;
//   - a step that fails is finished `exception` and is not tried again: the claim's unique key keeps the trigger taken, and the task is
//     halted until the orchestrator acts. The orchestrator is woken by policy-wakes.cjs, never by this file.
// A step reads no message and no worker's words (invariant 8). `assignFor(stepCore)` is the adapter's own task_assign (compose.assign)
// made over the stamped core, so a policy assignment sends the worker the same text an orchestrator's does.

const PW = require('./policy-wakes.cjs');
const PROC = require('./process.cjs');
const { gatedCore } = require('./gated-core.cjs');
const STEPS = require('./policy-steps-run.cjs');
const BUD = require('./policy-budget.cjs');
const KM = require('../core/kill-mark.cjs');
const RF = require('./policy-rounds.cjs');
const crypto = require('node:crypto');

const parse = (v) => { if (v && typeof v === 'object') return v; try { const p = typeof v === 'string' ? JSON.parse(v) : null; return p && typeof p === 'object' ? p : null; } catch { return null; } };
const errText = (e) => `${(e && e.code) || 'E_INTERNAL'}: ${String((e && e.message) || e).replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, 800)}`;
const keyOf = (step, t) => `${step}|${t.table}|${t.id}|${t.seq}`;
const isRelease = (t) => !!(t && t.results && t.results.trigger === 'release');
const RESTART_GRACE_MS = 150000; // a restart claim younger than this may still be coming up: no other worker is started for its step
const MAX_PARALLEL_BUILDS = 4; // the default cap on builds in flight when the run states none (the standing four-writers rule)
const SENDS = new Set(['build', 'review', 'fix', 're_review', 'relaunch', ...RF.SENDING]); // the steps that send a worker work (the budget rule); integrate and follow_up send none
const leftOver0 = STEPS.leftOver; // a review a paused step made and did not hand over (never leased, never evaluated: policy-steps-run.cjs)
const isReviewTask = (t) => !!(t.acceptance && t.acceptance.verdict === true);

// The plan a task acts under and its revision. The plan is policy-wakes.cjs policyOf (one definition of who inherits); the revision is that of
// the task holding it: the task's own, else the root work's.
function planOf(task, byId) {
  const plan = PW.policyOf(task, byId);
  if (!plan) return null;
  const holder = parse(task.policy) ? task : PW.rootOf(task, byId);
  return { plan, rev: Number.isInteger(holder.policy_rev) ? holder.policy_rev : null };
}
const handBy = (t) => (t && t.handoff && typeof t.handoff.by === 'string' ? t.handoff.by : null);
const merged = (t) => !!(t.integration && t.integration.state === 'merged');
const mergedOk = PW.mergedOk; // landed, and its integration's checks did not fail (the build gate's test, shared with policy-wakes.cjs)

// -> the steps due on these rows, in row order (the trigger's seq, then the step's name). `snap`: { runId, tasks (task.list rows),
// integrations, steps, maxBuilds, rounds ({ caps }: the failures policy-rounds.cjs carries as rounds are read only when it is given), failures }. Pure: no store, no clock. A candidate: { step, task_id, trigger, policy_rev, worker (the named builder or refuter), ... }.
function due(snap) {
  // A review a done review or re_review step handed to a reviewer was leased once: if that reviewer died, the relaunch owns it, not the review step's retake.
  const handed = new Set((snap.steps || []).filter((s) => (s.step === 'review' || s.step === 're_review') && s.outcome === 'done' && s.row_ref).map((s) => String(s.row_ref).replace(/^task:/, '')));
  const leftOver = (r) => leftOver0(r) && !handed.has(r.id);
  const { runId } = snap;
  const all = snap.tasks || [];
  const byId = new Map(all.map((t) => [t.id, t]));
  const tasks = all.filter((t) => t.run_id === runId && t.state !== 'cancelled');
  // The build gate, read once. A dependency is ready when it is done and, if its plan merges it, merged: a dependent task's tree is then cut
  // from the run's branch with the dependency in it. A task a build step already took is not built again (its builder died or let go: the
  // orchestrator is woken for the death and decides). `snap.maxBuilds` caps the builds in flight: leased work tasks of the run; past it a
  // build is still listed, `capped: true`, so a reader sees the task is carried by the plan and the executor takes it once a slot frees.
  const built = new Set((snap.steps || []).filter((s) => s.run_id === runId && s.step === 'build' && (s.outcome === 'done' || s.outcome === 'started' || s.outcome === 'superseded')).map((s) => s.task_id));
  const depReady = (d) => !!d && d.state === 'done' && (!(PW.policyOf(d, byId) || {}).integrate || mergedOk(d));
  const rf = snap.rounds ? RF.ctxOf({ runId, now: snap.now, tasks: all, steps: snap.roundSteps || snap.steps, failures: snap.failures, caps: snap.rounds.caps, integrations: snap.integrations }) : null; // failures the plan carries as rounds (policy-rounds.cjs)
  let slots = Number.isInteger(snap.maxBuilds) ? snap.maxBuilds - tasks.filter((t) => !isReviewTask(t) && t.lease && !t.lease.expired && t.state !== 'done').length : Infinity;
  const reviewsOf = new Map(); // task id -> the reviews (not cancelled) that depend on it
  for (const t of tasks) if (isReviewTask(t)) for (const d of Array.isArray(t.depends_on) ? t.depends_on : []) reviewsOf.set(d, (reviewsOf.get(d) || []).concat(t));
  const red = rf ? RF.redOf(rf, (t) => planOf(t, byId)) : null; // a red branch takes no other merge until the failing work's fix lands (policy-rounds.cjs)
  const merging = (snap.integrations || []).some((i) => i.run_id === runId && i.state === 'merging');
  const out = [];
  const tref = (t) => ({ table: 'task', id: t.id, seq: Number(t.seq) || 0 });

  for (const x of tasks) {
    if (isReviewTask(x)) { // a reviewer that released with no verdict is asked again (once)
      const pr = rf && x.state === 'released' ? planOf(x, byId) : null;
      const a = pr ? RF.action(x, pr.plan, rf) : null;
      if (a && a.step) out.push({ step: a.step, task_id: x.id, trigger: tref(x), policy_rev: pr.rev, worker: a.worker, prompt: a.prompt, root_id: PW.rootOf(byId.get((Array.isArray(x.depends_on) ? x.depends_on : [])[0]) || x, byId).id, ...(pr.plan.review ? { review: pr.plan.review } : {}) });
      const wk = byId.get((Array.isArray(x.depends_on) ? x.depends_on : [])[0]); // a reviewer the plan gave this review died: relaunched once, like a builder (policy-relaunch.cjs)
      const wp = wk && planOf(wk, byId);
      const rr = wp ? require('./policy-relaunch.cjs').due(x, wp.plan, wp.rev, snap, PW.rootOf(wk, byId).id) : null;
      if (rr) out.push(rr);
      continue;
    }
    const p = planOf(x, byId);
    if (!p) continue;
    const { plan, rev } = p;
    const root = PW.rootOf(x, byId);
    // A hand-back that failed its own evaluation, or could not be evaluated, goes back to its builder as a round (fix_eval, fix_run), after the re-run that comes first (rerun_*); a pass on a retry is noted.
    if (rf) {
      const a = RF.action(x, plan, rf);
      if (a && a.step) out.push({ step: a.step, task_id: x.id, trigger: tref(x), policy_rev: rev, worker: a.worker, root_id: root.id, ...(plan.build ? { build: plan.build } : {}), ...(a.prompt ? { prompt: a.prompt } : {}) });
      else if (RF.flakyDue(x, rf)) out.push({ step: 'note_flaky', task_id: x.id, trigger: tref(x), policy_rev: rev });
      const ca = RF.commitAction(x, plan, rf); // a done hand-back with no commit past its base goes back to its builder as a fix task
      if (ca && ca.step) out.push({ step: 'fix_commit', task_id: x.id, trigger: tref(x), policy_rev: rev, worker: ca.worker, ...(plan.build ? { build: plan.build } : {}), conflict_task: x.id, spec: ca.spec });
    }
    // build: an open work task nobody holds, whose dependencies are all done, and the plan names who builds it (a worker, or a spawn).
    // A task the orchestrator assigned has a lease and is skipped; a fix is made and assigned by its own step. A follow-up the follow_up step
    // made is open in its own tree, and is built here like any other planned task.
    if (!x.repairs && plan.build && x.state === 'open' && !x.lease && !built.has(x.id) && (Array.isArray(x.depends_on) ? x.depends_on : []).every((d) => depReady(byId.get(d)))) {
      const capped = slots <= 0; if (!capped) slots -= 1;
      out.push({ step: 'build', task_id: x.id, trigger: tref(x), policy_rev: rev, build: plan.build, worker: plan.build.worker || (plan.build.spawn && plan.build.spawn.worker_id) || null, from_run: (Array.isArray(x.depends_on) ? x.depends_on : []).some((d) => merged(byId.get(d) || {})), ...(capped ? { capped: true } : {}) });
    }
    // relaunch (E4): a builder the plan gave this task died and its row is dead; the plan restarts it once (policy-relaunch.cjs), under the build cap.
    const rl = require('./policy-relaunch.cjs').due(x, plan, rev, snap, root.id);
    if (rl) { const capped = slots <= 0; if (!capped) slots -= 1; out.push(capped ? { ...rl, capped: true } : rl); }
    // review: the work is done on a release evaluation, nothing reviews it, and the plan names who does (a worker, or a spawn).
    if (!x.repairs && plan.review && x.state === 'done' && isRelease(x) && !(rf && RF.commitHeld(x, rf)) && !(reviewsOf.get(x.id) || []).filter((r) => !leftOver(r)).length && !(x.review && x.review.review_id && !leftOver(byId.get(x.review.review_id)))) { // a review a paused step made and did not hand over does not count: the retake hands it over
      out.push({ step: 'review', task_id: x.id, trigger: tref(x), policy_rev: rev, review: plan.review, worker: plan.review.worker || (plan.review.spawn && plan.review.spawn.worker_id) || null });
    }
    // fix: the work's review is refuted (belay's own evaluation) and a round is left; the fix goes to the one who built what was judged.
    if (!x.repairs && plan.fix === 'builder' && x.review && x.review.state === 'refuted' && PW.fixRoundsLeft(x.review, rf ? RF.stepRounds(rf, root.id) : 0)) {
      const R = byId.get(x.review.review_id);
      if (R && R.run_id === runId && isRelease(R)) {
        const judged = byId.get((Array.isArray(R.depends_on) ? R.depends_on : [])[0]);
        out.push({ step: 'fix', task_id: x.id, trigger: tref(R), policy_rev: rev, worker: handBy(judged) || handBy(x), ...(plan.build ? { build: plan.build } : {}), review_id: R.id });
      }
    }
    // re_review: a fix task is done on belay's own evaluation and nothing reviews it yet; the review goes to the one who refuted.
    if (x.repairs && x.state === 'done' && plan.re_review === 'refuter' && isRelease(x) && !(reviewsOf.get(x.id) || []).length && !(rf && RF.isMergeFix(rf, x))) { // a fix that resolved a merge is checked by the retried merge, not re-reviewed
      const answered = (Array.isArray(x.answers) ? x.answers : []).slice().reverse().map((id) => byId.get(id)).find((r) => r && handBy(r));
      const R = answered || (root.review && byId.get(root.review.review_id)) || null;
      out.push({ step: 're_review', task_id: root.id, trigger: tref(x), policy_rev: rev, worker: handBy(R), ...(plan.review ? { review: plan.review } : {}), fix_id: x.id, review_id: R ? R.id : null });
    }
    // follow_up (B1, ADR 0064): the work's review holds with should-fix findings, no follow-up answers that review yet and the run's
    // max_follow_ups leaves one; the step makes the follow-up and the build step dispatches it. Past the cap nothing is due: the work
    // integrates on its hold, and the findings are named in the done wake. The judged task stays done and integrable either way.
    if (!x.repairs && !x.follows_up && plan.follow_up === 'plan' && x.review && x.review.state === 'holds' && x.review.follow_ups_left !== 0) {
      const R = byId.get(x.review.review_id);
      const facts = R && R.run_id === runId && isRelease(R) ? require('./review-wake.cjs').reviewOf(R) : null;
      const answered = all.some((t) => t.follows_up && (t.follows_up.review_id === (R && R.id) || (Array.isArray(t.follows_up.review_ids) && t.follows_up.review_ids.includes(R && R.id))));
      if (facts && facts.should_fix.n > 0 && !answered) out.push({ step: 'follow_up', task_id: x.id, trigger: tref(R), policy_rev: rev, review_id: R.id });
    }
    // integrate: the work's review holds, the work is done and not on the branch, and every task it depends on has landed.
    // After a merge-side fix (fix_conflict, fix_checks) is done, the merge is tried again with that fix in the unit; its trigger is the fix.
    const mf = rf ? RF.mergeFixOf(rf, x.id) : null;
    if (!x.repairs && plan.integrate === 'on_hold' && x.state === 'done' && !(rf && RF.commitHeld(x, rf)) && x.review && x.review.state === 'holds' && (!merged(x) || (mf && !merged(mf))) && !merging && !(red && red.root !== x.id)) {
      const R = byId.get(x.review.review_id);
      const deps = (Array.isArray(x.depends_on) ? x.depends_on : []).map((d) => byId.get(d));
      const landed = deps.every((d) => d && d.state === 'done' && (d.integration == null || merged(d)));
      if (R && R.run_id === runId && isRelease(R) && landed) {
        const unit = [x].concat(tasks.filter((t) => t.id !== x.id && t.repairs && PW.rootOf(t, byId).id === x.id && t.state === 'done'));
        out.push({ step: 'integrate', task_id: x.id, trigger: mf && !merged(mf) ? tref(mf) : tref(R), policy_rev: rev, task_ids: unit.map((t) => t.id), review_id: R.id, ...(rf && plan.fix === 'builder' ? { fixable: true } : {}), ...(merged(x) ? { retry: true } : {}) });
      }
    }
  }
  // An integration that stopped on a conflict, or whose checks failed, goes to the builder as a fix task (fix_conflict, fix_checks).
  if (rf) for (const i of rf.integrations) {
    const m = RF.mergeAction(i, rf, (t) => planOf(t, byId));
    if (m && m.step) out.push({ step: m.step, task_id: m.root.id, trigger: { table: 'integration', id: i.id, seq: Number(i.seq) || 0 }, policy_rev: m.rev, worker: m.worker, ...((planOf(m.task, byId) || { plan: {} }).plan.build ? { build: planOf(m.task, byId).plan.build } : {}), conflict_task: m.task.id, spec: RF.mergeSpec(m, runId) });
  }
  return out.sort((a, b) => a.trigger.seq - b.trigger.seq || (a.step < b.step ? -1 : a.step > b.step ? 1 : 0));
}

// `core`: the harness view of the adapter's core (policy.claim and policy.finish are the harness channel's). `assignFor(stepCore)`: the
// adapter's task_assign made over a core view. `closing()`: the run manager is closing. `closeWaitMs`: how long close() lets a step in
// flight finish before every further core call is refused.
// `spawnFor(stepCore)`: the run manager's spawn made over a step's view (policy-steps-run.cjs spawnFor); null when the run has none. `turnOf(id)`:
// the turn a message to that live worker starts (the claim records it, so the step log can join the turn's cost); null when unknown.
// `stopWorker(id)`: the run manager's graceful stop, for a worker a step spawned once its work needs it no more (null: never stopped).
function createPolicyExecutor({ core, runId, assignFor, spawnFor = null, restartWorker = null, dataDir = null, turnOf = null, closing = () => false, closeWaitMs = 2000, log = () => {}, identity = null, aliveBy = null, stopWorker = null }) {
  const spawnedFor = new Map(); // worker id -> the work task a build or review step spawned it for (this adapter's life)
  const retired = new Set();
  const gate = { aborted: false };
  const g = gatedCore(core, gate, 'the policy executor'); // a call begun after the owner's shutdown would elect a stray owner (invariant 2)
  let armed = false; let closed = false; let running = null; let again = false; let swept = false;
  // The adapter that claims: its pid and creation time (read once, on the first claim). A claim whose claimant is gone by that identity is a dead
  // life's; one whose claimant is alive, this process's own or another adapter's, is never swept.
  let own = identity ? Promise.resolve(identity) : null;
  const ownId = () => own || (own = PROC.createdOf(process.pid).then((r) => ({ pid: process.pid, created: r && r.created != null ? String(r.created) : null }), () => ({ pid: process.pid, created: null })));
  const alive = aliveBy || (async (pid, created) => { if (created == null) return PROC.pidAlive(pid); const r = await PROC.createdOf(pid).catch(() => null); return !!r && String(r.created) === String(created); });
  const stopped = () => closed || gate.aborted || closing();
  const pending = new Set(); // steps running detached (a re-run of an evaluation): claimed started, settled when the evaluation ends

  const read = async (fn, field, fallback) => { const r = await fn({}); return (r && r[field]) || fallback; };
  // What policy-rounds.cjs needs beside the rows: the run's fix caps, and the evaluations that ended with no result (read only when a hand-back waits on one).
  const extras = async (tasks, run) => ({ rounds: { caps: RF.capsOf(run) }, failures: tasks.some((t) => t.run_id === runId && t.state === 'released' && t.handoff) ? await RF.readFailures(g, runId) : [] });

  // Once per adapter life, at its first pass: a claim still `started` whose claimant is no longer alive (pid and creation time) belongs to a life that
  // ended mid-step; a live claimant's claim, ours or another adapter's on the same run, is left alone. A claim with no claimant is a dead one's. Its effect may have landed: the row stamped with the claim's trigger (policy.list's `effect`) is
  // named, else the claim is an interrupted exception. It is never resumed or retried.
  async function sweep(steps) {
    const out = [];
    const seen = new Map();
    const live = async (pid, created) => { const k = `${pid}|${created}`; if (!seen.has(k)) { const me = await ownId(); seen.set(k, pid === me.pid && String(created) === String(me.created) ? true : await alive(pid, created)); } return seen.get(k); };
    for (const s of steps) {
      if (s.run_id !== runId || s.outcome !== 'started') continue;
      if (s.claimant_pid && await live(s.claimant_pid, s.claimant_created)) continue;
      try {
        await g.policy.finish(s.effect
          ? { seq: s.seq, outcome: 'done', row_ref: s.effect }
          : s.partial
          ? { seq: s.seq, outcome: 'exception', row_ref: s.partial, error: `interrupted: the adapter that claimed step ${s.step} on ${s.trigger_table}:${s.trigger_id}:${s.trigger_seq} ended after writing ${s.partial} and before the step's last write (its assignment); belay does not resume a step, so check and act` }
          : { seq: s.seq, outcome: 'exception', error: `interrupted: the adapter that claimed step ${s.step} on ${s.trigger_table}:${s.trigger_id}:${s.trigger_seq} ended before it finished it and wrote nothing that carries its stamp; belay does not resume a step, so check and act` });
        out.push(s.seq);
      } catch (e) { log(`policy sweep ${s.seq}: ${errText(e)}`); }
    }
    return out;
  }

  // The halted task ids as the store holds them now: the policy rows, tasks, integrations and plan revisions read again and the exceptions derived from them.
  async function haltedNow(run) {
    const [st, tk, ig] = [await read(g.policy.list, 'rows', []), await read(g.task.list, 'tasks', []), await read(g.integration.list, 'integrations', [])];
    return PW.haltedIds(PW.derive({ runId, tasks: tk, integrations: ig, steps: st, revisions: await PW.readRevisions(g.policy, runId, tk), ...(await extras(tk, run)) }), tk);
  }

  // After the claim and just before the step's first write: the run is not paused or ended, and the step is still due on fresh rows at the plan
  // revision it was claimed at (the pass's snapshot can be minutes old after an integrate). -> a reason to skip, or null.
  const seen = { run: null, tasks: [] }; // the run row and the task rows stillDue read, for the budget rule
  // A store read that threw is marked, so the pass retakes the step; any other throw in here is a bug and stays an exception.
  const rd = async (f, name) => { try { return await f(); } catch (e) { if (e && typeof e === 'object') e.stillDueRead = name; throw e; } };
  // A read that keeps failing reopens the same claim each pass: after this many in a row it is one exception (E8) that names the read.
  const readFails = new Map(); // keyOf(step, trigger) -> consecutive failures
  const READ_FAIL_MAX = 5;
  async function stillDue(c, seq) {
    const run = (await rd(() => g.run.get({}), 'run.get')).run;
    seen.run = run;
    if (!run || run.ended_at != null) return 'the run has ended after the step was claimed';
    if (run.paused_at != null) return 'E_PAUSED: the run was paused after the step was claimed; the claim is reopened and the step retaken after the resume';
    const tasks = await rd(() => read(g.task.list, 'tasks', []), 'task.list');
    seen.tasks = tasks;
    const integrations = c.step === 'integrate' || c.trigger.table === 'integration' ? await rd(() => read(g.integration.list, 'integrations', []), 'integration.list') : [];
    const rl = c.step === 'relaunch' ? { steps: (await rd(() => read(g.policy.list, 'rows', []), 'policy.list')).filter((r) => !(r.step === 'relaunch' && r.outcome === 'started' && r.trigger_table === c.trigger.table && r.trigger_id === c.trigger.id && Number(r.trigger_seq) === c.trigger.seq)), workers: await rd(() => read(g.worker.list, 'workers', []), 'worker.list') } : {}; // this claim is not a used relaunch
    const roundSteps = (await rd(() => read(g.policy.list, 'rows', []), 'policy.list')).filter((r) => r.seq !== seq); // the rounds read the step log, without this step's own claim
    const same = due({ runId, tasks, integrations, roundSteps, ...rl, ...(await rd(() => extras(tasks, run), 'run.get or failures')), ...(dataDir ? { isKilled: (w) => KM.isKilled(dataDir, w.id, w.pid, w.pid_created) } : {}) }).find((d) => keyOf(d.step, d.trigger) === keyOf(c.step, c.trigger));
    if (same && (await rd(() => haltedNow(run), 'task.list or policy.list')).has(c.task_id)) return `E_NOT_NOW: ${c.task_id} was halted after the step was claimed; the claim is reopened and the step retaken if the halt is lifted`;
    if (!same) return `E_NOT_NOW: the plan or the facts changed after the claim: ${c.step} on ${c.trigger.table}:${c.trigger.id} is no longer due; the claim is reopened and the step retaken if it is due again`;
    if ((same.policy_rev ?? null) !== (c.policy_rev ?? null)) return `E_NOT_NOW: the plan moved from rev ${c.policy_rev} to rev ${same.policy_rev} after the claim; the claim is reopened and the step retaken`;
    return null;
  }

  // The budget rule (ADR 0075 decision 1): a step that sends work to a worker is not taken at the soft threshold. -> the refusal text or null.
  const budgetRefusal = (c) => {
    if (!SENDS.has(c.step)) return null;
    const row = seen.tasks.find((t) => t.id === c.task_id); // the task row's own limit, read as the guard reads it (budget-guard.cjs loadAttach)
    return BUD.refusal(seen.run, { spend: (taskId) => g.usage.spend(taskId ? { task_id: taskId } : {}) }, c.task_id, row ? row.budget_usd : null);
  };

  // The restart of a dead worker for a step, once: a claim of its own (step `restart`, the dead worker and the step's trigger as its key), finished at once. -> true for
  // the first caller; false for every later one, across reopened claims and adapter lives; 'recent' for a later one while the first claim is younger than
  // RESTART_GRACE_MS (a slow restart may still be coming up: no other worker is started for the step yet).
  async function restartOnce(step, seq) {
    const me = await ownId();
    const t = step.trigger;
    const { row, existing } = await g.policy.claim({ claimant_pid: me.pid, ...(me.created != null ? { claimant_created: String(me.created) } : {}), step: 'restart', trigger: { table: 'worker', id: `${step.worker}|${step.step}|${t.table}:${t.id}:${t.seq}` }, task_id: step.task_id, worker_id: step.worker });
    if (existing) return Number.isFinite(row.at) && Date.now() - row.at < RESTART_GRACE_MS ? 'recent' : false;
    try { await g.policy.finish({ seq: row.seq, outcome: 'done', row_ref: `worker:${step.worker}` }); } catch (e) { log(`policy restart ${row.seq}: ${errText(e)}`); }
    return true;
  }

  async function take(c0, taken) {
    // The worker and the turn the step starts, known before the claim: a spawned reviewer's id is made here and its first turn is 1; a named
    // worker's next turn is the one its manager says. A turn the manager cannot say is left off (the log then prints no turn).
    const spawned = (c0.step === 'review' && c0.review && c0.review.spawn) || (c0.step === 'build' && c0.build && c0.build.spawn);
    // belay never substitutes an id the plan named: a retake after a pause spawns it in place (spawn-args.cjs checkIdFree allows this run's own dead row),
    // and an id a live worker holds is the spawn's refusal, an exception (E8).
    const c = spawned && !c0.worker ? { ...c0, worker: `${c0.step === 'build' ? 'bld' : 'rev'}-${crypto.randomUUID().slice(0, 8)}` } : c0;
    let turn = spawned ? 1 : null;
    if (turn == null && c.worker && turnOf) { try { const t = await turnOf(c.worker); if (Number.isInteger(t) && t > 0) turn = t; } catch { turn = null; } }
    const me = await ownId();
    const { row, existing } = await g.policy.claim({ claimant_pid: me.pid, ...(me.created != null ? { claimant_created: String(me.created) } : {}), step: c.step, trigger: c.trigger, task_id: c.task_id, ...(c.policy_rev != null ? { policy_rev: c.policy_rev } : {}), ...(c.worker ? { worker_id: c.worker } : {}), ...(turn != null ? { turn } : {}) });
    if (existing) return null;
    const stepCore = gatedCore(g.policyAs(row.seq), gate, 'the policy executor');
    async function finishStep() {
    let res;
    try {
      const rk = keyOf(c.step, c.trigger);
      const why = await stillDue(c, row.seq).then((w) => { readFails.delete(rk); return w; }, (e) => {
        if (!(e && e.stillDueRead)) throw e;
        const n = (readFails.get(rk) || 0) + 1; readFails.set(rk, n);
        if (n >= READ_FAIL_MAX) { readFails.delete(rk); throw Object.assign(new Error(`the ${e.stillDueRead} read failed ${n} times in a row after the claim: ${errText(e)}`), { code: 'E_READ_FAILED' }); }
        return `E_NOT_NOW: the facts could not be read after the claim (${errText(e)}); the claim is reopened and the step retaken`;
      });
      const over = why ? null : await budgetRefusal(c);
      res = why ? { outcome: 'skipped', error: why } : over ? { outcome: c.step === 'relaunch' ? 'skipped' : 'exception', error: over } : await STEPS.run(c, { core: stepCore, runId, assign: assignFor(stepCore), spawn: spawnFor ? spawnFor(stepCore) : null, restart: restartWorker, restartOnce: (step) => restartOnce(step, row.seq), stop: stopWorker, dataDir });
    } catch (e) { res = { outcome: 'exception', error: errText(e) }; }
    if (res && res.outcome === 'exception' && !res.row_ref && /^E_PAUSED/.test(res.error || '')) res = { outcome: 'skipped', error: res.error }; // the core refused it for the pause: nothing was written
    if (!res || !res.outcome) res = { outcome: 'exception', error: 'the step returned no outcome' };
    const spawnedId = res.spawned; delete res.spawned; // a coder a relaunch spawned: retired like the builder a build step spawns
    try { await g.policy.finish({ seq: row.seq, ...res }); } catch (e) {
      // A finish the store refused (a row_ref it could not find) is still a step that ended: it is recorded as the failure it is.
      res = { outcome: 'exception', error: `the step could not be recorded as ${res.outcome}: ${errText(e)}` };
      try { await g.policy.finish({ seq: row.seq, ...res }); } catch (e2) { log(`policy finish ${row.seq}: ${errText(e2)}`); return { seq: row.seq, step: c.step, outcome: 'started' }; }
    }
    taken.push({ seq: row.seq, step: c.step, task_id: c.task_id, outcome: res.outcome, row_ref: res.row_ref || null });
    if (res.outcome === 'done' && c.worker && (c.step === 'build' || c.step === 'review') && c[c.step] && c[c.step].spawn) spawnedFor.set(c.worker, c.task_id);
    if (res.outcome === 'done' && spawnedId) spawnedFor.set(spawnedId, c.root_id || c.task_id);
    return res;
    }
    // A re-run holds nothing else back: the claim stays started while the evaluation runs, and the pass goes on (the plan reads a started re-run as waiting).
    if (!RF.RERUN_STEPS.has(c.step)) return finishStep();
    const p = finishStep().catch((e) => log(`policy ${c.step} ${row.seq}: ${errText(e)}`)).then(() => { pending.delete(p); return stopped() ? null : tick().catch(() => {}); }); // the next step is taken at once, and settle() waits for it
    pending.add(p);
    return { outcome: 'started', detached: true };
  }

  // One reconciliation. -> { steps: [{ seq, step, task_id, outcome, row_ref }], swept: [seq], held: 'paused'|'ended'|null }.
  async function pass() {
    const out = { steps: [], swept: [], held: null };
    const steps = await read(g.policy.list, 'rows', []);
    const tasks = await read(g.task.list, 'tasks', []);
    if (!swept) { out.swept = await sweep(steps); swept = true; }
    if (!tasks.some((t) => t.run_id === runId && parse(t.policy))) return out;
    const run = (await g.run.get({})).run;
    if (!run || run.ended_at != null) { out.held = 'ended'; return out; }
    if (run.paused_at != null) { out.held = 'paused'; return out; }
    const integrations = await read(g.integration.list, 'integrations', []);
    const revisions = await PW.readRevisions(g.policy, runId, tasks); // an amend lifts a halt, and the fixes' creation order (policy-wakes derive)
    const ex = await extras(tasks, run);
    const halted = PW.haltedIds(PW.derive({ runId, tasks, integrations, steps, revisions, ...ex }), tasks);
    const claimed = new Set(steps.filter((s) => !(s.outcome === 'skipped' && /^E_(PAUSED|NOT_NOW)/.test(s.error || ''))).map((s) => keyOf(s.step, { table: s.trigger_table, id: s.trigger_id, seq: Number(s.trigger_seq) || 0 })));
    const workers = require('./policy-relaunch.cjs').mayNeed(tasks.filter((t) => t.run_id === runId), steps, runId, (t) => PW.rootOf(t, new Map(tasks.map((r) => [r.id, r])))) && g.worker && g.worker.list ? await read(g.worker.list, 'workers', []) : undefined; // worker rows only while a task a builder may have left open exists
    const dueNow = due({ runId, tasks, integrations, steps, workers, ...ex, ...(dataDir ? { isKilled: (w) => KM.isKilled(dataDir, w.id, w.pid, w.pid_created) } : {}), maxBuilds: Number.isInteger(run.max_parallel_builds) && run.max_parallel_builds > 0 ? run.max_parallel_builds : MAX_PARALLEL_BUILDS });
    if (readFails.size) { const keys = new Set(dueNow.map((d) => keyOf(d.step, d.trigger))); for (const k of readFails.keys()) if (!keys.has(k)) readFails.delete(k); } // a claim no longer due has no count
    for (const c of dueNow) {
      if (stopped()) break;
      if (c.capped) continue; // max_parallel_builds: the task waits for a slot, no exception (ADR 0074 amendment 4)
      if (halted.has(c.task_id) || claimed.has(keyOf(c.step, c.trigger))) continue;
      const now = (await g.run.get({})).run; // a pause that began during this pass stops the next claim
      if (!now || now.ended_at != null || now.paused_at != null) { out.held = now && now.ended_at == null ? 'paused' : 'ended'; break; }
      try { for (const id of await haltedNow(run)) halted.add(id); } catch (e) { log(`policy halt re-read: ${errText(e)}`); } // a read that fails leaves the halts the pass already has
      if (halted.has(c.task_id)) continue;
      const res = await take(c, out.steps);
      claimed.add(keyOf(c.step, c.trigger));
      if (res && res.outcome === 'exception' && !/^E_BUDGET/.test(res.error || '')) for (const id of PW.haltScope(c.task_id, tasks)) halted.add(id);
    }
    if (stopWorker && !stopped()) await retire(tasks);
    return out;
  }

  // A worker a step spawned is stopped (the manager's graceful stop, never a kill) once the work it was spawned for needs it no more: the work
  // is merged or cancelled, or its plan merges nothing and its review holds. Until then the builder takes the fixes and the reviewer the
  // re-reviews. A worker holding a lease on any unfinished task is left alone. Once per worker.
  async function retire(tasks) {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    for (const [wid, taskId] of spawnedFor) {
      if (retired.has(wid)) continue;
      const w = byId.get(taskId);
      if (!w) continue;
      const plan = PW.policyOf(w, byId) || {};
      const finished = w.state === 'cancelled' || (merged(w) && w.integration.passed !== false && w.integration.checks_passed !== false) || (!plan.integrate && w.state === 'done' && w.review && w.review.state === 'holds');
      if (!finished) continue;
      if (tasks.some((t) => t.lease && t.lease.holder === wid && !t.lease.expired && t.state !== 'done' && t.state !== 'cancelled')) continue;
      retired.add(wid);
      try { await stopWorker(wid); } catch (e) { log(`policy retire ${wid}: ${errText(e)}`); }
    }
  }

  // Run a pass, or ask the one in flight for another when it ends. Does nothing until armed (a run with no plan reads nothing).
  function tick() {
    if (!armed || closed) return Promise.resolve(null);
    if (running) { again = true; return running; }
    running = (async () => {
      try { let res; do { again = false; res = await pass(); } while (again && !stopped()); return res; } finally { running = null; }
    })();
    return running;
  }

  async function close() {
    closed = true; // no further claim
    if (running) {
      let timer; const cut = new Promise((r) => { timer = setTimeout(r, closeWaitMs); if (timer.unref) timer.unref(); });
      await Promise.race([running.catch(() => {}), cut]); clearTimeout(timer);
    }
    gate.aborted = true; // a step still in flight sends no further call; its claim stays `started` and the next life finishes it
  }

  return { settle: () => Promise.all([...pending]), tick, close, arm: () => { armed = true; }, isArmed: () => armed, pass, due };
}

module.exports = { createPolicyExecutor, due, planOf, keyOf, mergedOk, MAX_PARALLEL_BUILDS };
