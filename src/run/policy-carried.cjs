'use strict';
// policy-carried.cjs — the one reading of "the plan is carrying this task", used by the hand-back stalled wake (stall-wake.cjs untaken). A
// planned open task is stalled only when due() lists nothing for it, no step is in flight on it or on its tree, it is not blocked by a
// dependency still on its way (a done dependency its plan has to merge, a merge in flight, a review whose evaluation has not landed), and it
// is not halted. due() is the executor's own gate, called here as it is, so the wake and the executor cannot disagree. The idle close does not
// use it: it names every open task, because it is the net under this predicate and under the executor.

const { due, mergedOk } = require('./policy-exec.cjs');
const RF = require('./policy-rounds.cjs');
const PW = require('./policy-wakes.cjs');
const ROUNDS = new Set([...RF.ROUND_STEPS, ...RF.MERGE_FIX_STEPS, ...RF.RERUN_STEPS, 'reask']); // the steps of a fix round

// A released review whose evaluation has not landed (its hand-back is newer than its evaluation) is not yet settled: the plan is still about to act on it.
const evalPending = (t) => !!(t.handoff && !t.handoff.stood_down && t.handoff.at != null && !(t.results && Number(t.results.evaluated_at) >= Number(t.handoff.at)));
const mine = (tasks, runId) => tasks.filter((t) => t.run_id === runId);
const openOf = (tasks, runId) => mine(tasks, runId).filter((t) => t.state === 'open');
// A dependency is ready when it is done and, if its plan merges it and the plan is still at work on it (`carried`: a step due or in flight on
// it, or a task not yet terminal rooted at it, its review or a fix round), merged. This differs from the plan's build gate (policy-exec.cjs due,
// depReady) on purpose: a done, unmerged dependency nothing of the plan will move (an integrate on_hold with no review to lead to it) is ready
// by done, as the core's assign reads it, because only the orchestrator can move it.
const depReady = (u, byId, carried) => !!u && u.state === 'done' && (!carried.has(u.id) || !(PW.policyOf(u, byId) || {}).integrate || mergedOk(u));
const ready = (t, byId, carried = new Set()) => (Array.isArray(t.depends_on) ? t.depends_on : []).every((d) => depReady(byId.get(d), byId, carried));

// The open, ready tasks of the run that no policy step names: neither due nor claimed and still in flight, and not halted.
// `carried`: the tasks a due or in-flight step names (they are not named) and, for the ready check only, the work a review or fix not yet
// terminal (done, cancelled or released) is rooted at (PW.rootOf; a review by the work it depends on): the review step ends when it hands the review over, and a fix
// round has no step in flight between its steps, yet the plan is still carrying the work to its merge.
function untaken(snap) {
  const { runId } = snap;
  const tasks = snap.tasks || [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const named = new Set(PW.haltedIds(PW.derive({ ...snap, failures: snap.failures || [] }), tasks)); // a halted task's exception wake has gone: it is not "no policy step due"
  // The steps go to due() so a task a step already took (a build whose builder then died) is not counted as carried: it is the orchestrator's.
  const carried = new Set();
  // An integration merging holds every other integrate back in due(); the plan still carries those, so they are listed with the gate off. A stale one (its owner is gone) is no merge in flight: it keeps the gate, so the safety net still names what waits behind it.
  const firstDue = due({ runId, tasks, integrations: (snap.integrations || []).filter((i) => i.state !== 'merging' || i.stale), steps: snap.steps || [], rounds: snap.rounds, failures: snap.failures, roundSteps: snap.roundSteps, workers: snap.workers, isKilled: snap.isKilled });
  for (const c of firstDue) { carried.add(c.task_id); for (const id of c.task_ids || []) carried.add(id); }
  // A red branch (policy-rounds.cjs redOf) withholds every other integrate in due(), and a work awaiting its commit fix withholds its own. While a round is
  // at work on the holding root (a round step due or in flight on it, or a fix task of its tree not yet terminal) the plan carries those integrates, so
  // what depends on them is not free: asked again with no rounds, due() lists what it withholds. At the fix cap, or once the fix is cancelled, no round
  // is at work on the root, the hold carries nothing, and what waits behind it is named. A round at work on another task's tree silences nothing here.
  if (snap.rounds) {
    const rf = RF.ctxOf({ runId, now: snap.now, tasks, steps: snap.roundSteps || snap.steps, failures: snap.failures, caps: snap.rounds.caps, integrations: snap.integrations });
    const planFor = (t) => { const plan = PW.policyOf(t, byId); return plan ? { plan, rev: null } : null; };
    const red = RF.redOf(rf, planFor);
    const held = [];
    if (red) held.push({ root: red.root, all: true });
    for (const x of mine(tasks, runId)) if (RF.commitHeld(x, rf)) held.push({ root: x.id, all: false });
    if (held.length) {
      const rootId = (id) => (byId.get(id) ? PW.rootOf(byId.get(id), byId).id : id);
      const live = [...(snap.steps || []).filter((st) => st.run_id === runId && st.outcome === 'started' && ROUNDS.has(st.step)).map((st) => rootId(st.task_id)),
        ...firstDue.filter((c) => ROUNDS.has(c.step)).map((c) => rootId(c.task_id)),
        ...mine(tasks, runId).filter((t) => t.repairs && !['done', 'cancelled', 'released'].includes(t.state)).map((t) => PW.rootOf(t, byId).id)];
      const atWork = new Set(live);
      const ints = due({ runId, tasks, integrations: (snap.integrations || []).filter((i) => i.state !== 'merging' || i.stale), steps: snap.steps || [] }).filter((c) => c.step === 'integrate');
      for (const h of held) if (atWork.has(h.root)) for (const c of ints) if (h.all || c.task_id === h.root) { carried.add(c.task_id); for (const id of c.task_ids || []) carried.add(id); }
    }
  }
  for (const s of snap.steps || []) if (s.run_id === runId && s.outcome === 'started' && s.task_id) carried.add(s.task_id);
  for (const id of carried) named.add(id);
  const stepRoots = new Set(); // a step in flight owns every row of its work's tree, such as the review it has just written and not yet assigned
  for (const s of snap.steps || []) if (s.run_id === runId && s.outcome === 'started' && byId.get(s.task_id)) stepRoots.add(PW.rootOf(byId.get(s.task_id), byId).id);
  const atWork = new Set(carried);
  for (const t of mine(tasks, runId)) {
    if (t.state === 'done' || t.state === 'cancelled' || (t.state === 'released' && !evalPending(t))) continue; // released: a refuted review ends so, and one still owed its fix is carried through due()
    atWork.add(PW.rootOf(t, byId).id);
    if (t.acceptance && t.acceptance.verdict === true) for (const d of Array.isArray(t.depends_on) ? t.depends_on : []) if (byId.get(d)) atWork.add(PW.rootOf(byId.get(d), byId).id);
  }
  const inStep = (t) => stepRoots.has(PW.rootOf(t, byId).id) || (!!t.acceptance && t.acceptance.verdict === true && (Array.isArray(t.depends_on) ? t.depends_on : []).some((d) => byId.get(d) && stepRoots.has(PW.rootOf(byId.get(d), byId).id)));
  return openOf(tasks, runId).filter((t) => PW.policyOf(t, byId) && !inStep(t) && ready(t, byId, atWork) && !named.has(t.id)).map((t) => t.id).sort();
}

module.exports = { untaken, mine, openOf, ready };
