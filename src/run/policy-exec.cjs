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
const { gatedCore } = require('./gated-core.cjs');
const STEPS = require('./policy-steps-run.cjs');

const parse = (v) => { if (v && typeof v === 'object') return v; try { const p = typeof v === 'string' ? JSON.parse(v) : null; return p && typeof p === 'object' ? p : null; } catch { return null; } };
const errText = (e) => `${(e && e.code) || 'E_INTERNAL'}: ${String((e && e.message) || e).replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, 800)}`;
const keyOf = (step, t) => `${step}|${t.table}|${t.id}|${t.seq}`;
const isRelease = (t) => !!(t && t.results && t.results.trigger === 'release');
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

// -> the steps due on these rows, in row order (the trigger's seq, then the step's name). `snap`: { runId, tasks (task.list rows),
// integrations }. Pure: no store, no clock. A candidate: { step, task_id, trigger, policy_rev, worker (the named builder or refuter), ... }.
function due(snap) {
  const { runId } = snap;
  const all = snap.tasks || [];
  const byId = new Map(all.map((t) => [t.id, t]));
  const tasks = all.filter((t) => t.run_id === runId && t.state !== 'cancelled');
  const reviewsOf = new Map(); // task id -> the reviews (not cancelled) that depend on it
  for (const t of tasks) if (isReviewTask(t)) for (const d of Array.isArray(t.depends_on) ? t.depends_on : []) reviewsOf.set(d, (reviewsOf.get(d) || []).concat(t));
  const merging = (snap.integrations || []).some((i) => i.run_id === runId && i.state === 'merging');
  const out = [];
  const tref = (t) => ({ table: 'task', id: t.id, seq: Number(t.seq) || 0 });

  for (const x of tasks) {
    if (isReviewTask(x)) continue;
    const p = planOf(x, byId);
    if (!p) continue;
    const { plan, rev } = p;
    const root = PW.rootOf(x, byId);
    // fix: the work's review is refuted (belay's own evaluation) and a round is left; the fix goes to the one who built what was judged.
    if (!x.repairs && plan.fix === 'builder' && x.review && x.review.state === 'refuted' && x.review.rounds_left !== 0) {
      const R = byId.get(x.review.review_id);
      if (R && R.run_id === runId && isRelease(R)) {
        const judged = byId.get((Array.isArray(R.depends_on) ? R.depends_on : [])[0]);
        out.push({ step: 'fix', task_id: x.id, trigger: tref(R), policy_rev: rev, worker: handBy(judged) || handBy(x), review_id: R.id });
      }
    }
    // re_review: a fix task is done on belay's own evaluation and nothing reviews it yet; the review goes to the one who refuted.
    if (x.repairs && x.state === 'done' && plan.re_review === 'refuter' && isRelease(x) && !(reviewsOf.get(x.id) || []).length) {
      const answered = (Array.isArray(x.answers) ? x.answers : []).slice().reverse().map((id) => byId.get(id)).find((r) => r && handBy(r));
      const R = answered || (root.review && byId.get(root.review.review_id)) || null;
      out.push({ step: 're_review', task_id: root.id, trigger: tref(x), policy_rev: rev, worker: handBy(R), fix_id: x.id, review_id: R ? R.id : null });
    }
    // integrate: the work's review holds, the work is done and not on the branch, and every task it depends on has landed.
    if (!x.repairs && plan.integrate === 'on_hold' && x.state === 'done' && x.review && x.review.state === 'holds' && !merged(x) && !merging) {
      const R = byId.get(x.review.review_id);
      const deps = (Array.isArray(x.depends_on) ? x.depends_on : []).map((d) => byId.get(d));
      const landed = deps.every((d) => d && d.state === 'done' && (d.integration == null || merged(d)));
      if (R && R.run_id === runId && isRelease(R) && landed) {
        const unit = [x].concat(tasks.filter((t) => t.id !== x.id && t.repairs && PW.rootOf(t, byId).id === x.id && t.state === 'done'));
        out.push({ step: 'integrate', task_id: x.id, trigger: tref(R), policy_rev: rev, task_ids: unit.map((t) => t.id), review_id: R.id });
      }
    }
  }
  return out.sort((a, b) => a.trigger.seq - b.trigger.seq || (a.step < b.step ? -1 : a.step > b.step ? 1 : 0));
}

// `core`: the harness view of the adapter's core (policy.claim and policy.finish are the harness channel's). `assignFor(stepCore)`: the
// adapter's task_assign made over a core view. `closing()`: the run manager is closing. `closeWaitMs`: how long close() lets a step in
// flight finish before every further core call is refused.
function createPolicyExecutor({ core, runId, assignFor, closing = () => false, closeWaitMs = 2000, log = () => {}, startedAt = Date.now() }) {
  const gate = { aborted: false };
  const g = gatedCore(core, gate, 'the policy executor'); // a call begun after the owner's shutdown would elect a stray owner (invariant 2)
  let armed = false; let closed = false; let running = null; let again = false; let swept = false;
  const stopped = () => closed || gate.aborted || closing();

  const read = async (fn, field, fallback) => { const r = await fn({}); return (r && r[field]) || fallback; };

  // Once per adapter life, at its first pass: a claim older than this life that is still `started` belongs to a life that ended mid-step (a claim made since
  // is a live one, perhaps another adapter's). Its effect may have landed: the row stamped with the claim's trigger (policy.list's `effect`) is
  // named, else the claim is an interrupted exception. It is never resumed or retried.
  async function sweep(steps) {
    const out = [];
    for (const s of steps) {
      if (s.run_id !== runId || s.outcome !== 'started' || Number(s.at) >= startedAt) continue;
      try {
        await g.policy.finish(s.effect
          ? { seq: s.seq, outcome: 'done', row_ref: s.effect }
          : { seq: s.seq, outcome: 'exception', error: `interrupted: the adapter that claimed step ${s.step} on ${s.trigger_table}:${s.trigger_id}:${s.trigger_seq} ended before it finished it and wrote nothing that carries its stamp; belay does not resume a step, so check and act` });
        out.push(s.seq);
      } catch (e) { log(`policy sweep ${s.seq}: ${errText(e)}`); }
    }
    return out;
  }

  // After the claim and just before the step's first write: the run is not paused or ended, and the step is still due on fresh rows at the plan
  // revision it was claimed at (the pass's snapshot can be minutes old after an integrate). -> a reason to skip, or null.
  async function stillDue(c) {
    const run = (await g.run.get({})).run;
    if (!run || run.ended_at != null) return 'the run has ended after the step was claimed';
    if (run.paused_at != null) return 'E_PAUSED: the run was paused after the step was claimed; the claim is reopened and the step retaken after the resume';
    const tasks = await read(g.task.list, 'tasks', []);
    const integrations = c.step === 'integrate' ? await read(g.integration.list, 'integrations', []) : [];
    const same = due({ runId, tasks, integrations }).find((d) => keyOf(d.step, d.trigger) === keyOf(c.step, c.trigger));
    if (!same) return `the plan or the facts changed after the claim: ${c.step} on ${c.trigger.table}:${c.trigger.id} is no longer due`;
    if ((same.policy_rev ?? null) !== (c.policy_rev ?? null)) return `the plan moved from rev ${c.policy_rev} to rev ${same.policy_rev} after the claim`;
    return null;
  }

  async function take(c, taken) {
    const { row, existing } = await g.policy.claim({ step: c.step, trigger: c.trigger, task_id: c.task_id, ...(c.policy_rev != null ? { policy_rev: c.policy_rev } : {}), ...(c.worker ? { worker_id: c.worker } : {}) });
    if (existing) return null;
    const stepCore = gatedCore(g.policyAs(row.seq), gate, 'the policy executor');
    let res;
    try {
      const why = await stillDue(c);
      res = why ? { outcome: 'skipped', error: why } : await STEPS.run(c, { core: stepCore, assign: assignFor(stepCore) });
    } catch (e) { res = { outcome: 'exception', error: errText(e) }; }
    if (res && res.outcome === 'exception' && !res.row_ref && /^E_PAUSED/.test(res.error || '')) res = { outcome: 'skipped', error: res.error }; // the core refused it for the pause: nothing was written
    if (!res || !res.outcome) res = { outcome: 'exception', error: 'the step returned no outcome' };
    try { await g.policy.finish({ seq: row.seq, ...res }); } catch (e) {
      // A finish the store refused (a row_ref it could not find) is still a step that ended: it is recorded as the failure it is.
      res = { outcome: 'exception', error: `the step could not be recorded as ${res.outcome}: ${errText(e)}` };
      try { await g.policy.finish({ seq: row.seq, ...res }); } catch (e2) { log(`policy finish ${row.seq}: ${errText(e2)}`); return { seq: row.seq, step: c.step, outcome: 'started' }; }
    }
    taken.push({ seq: row.seq, step: c.step, task_id: c.task_id, outcome: res.outcome, row_ref: res.row_ref || null });
    return res;
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
    const halted = PW.haltedIds(PW.derive({ runId, tasks, integrations, steps, failures: [] }), tasks);
    const claimed = new Set(steps.filter((s) => !(s.outcome === 'skipped' && /^E_PAUSED/.test(s.error || ''))).map((s) => keyOf(s.step, { table: s.trigger_table, id: s.trigger_id, seq: Number(s.trigger_seq) || 0 })));
    for (const c of due({ runId, tasks, integrations })) {
      if (stopped()) break;
      if (halted.has(c.task_id) || claimed.has(keyOf(c.step, c.trigger))) continue;
      const now = (await g.run.get({})).run; // a pause that began during this pass stops the next claim
      if (!now || now.ended_at != null || now.paused_at != null) { out.held = now && now.ended_at == null ? 'paused' : 'ended'; break; }
      const res = await take(c, out.steps);
      claimed.add(keyOf(c.step, c.trigger));
      if (res && res.outcome === 'exception') for (const id of PW.haltScope(c.task_id, tasks)) halted.add(id);
    }
    return out;
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

  return { tick, close, arm: () => { armed = true; }, isArmed: () => armed, pass, due };
}

module.exports = { createPolicyExecutor, due, planOf, keyOf };
