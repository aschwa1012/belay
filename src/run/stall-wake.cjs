'use strict';
// stall-wake.cjs — open work that nobody is assigned and no policy step will take (ADR 0074 amendment 3). Under a plan a hand-back is
// routine and wakes nobody (release-eval.cjs enrichWakes consumes its turn end), so an orchestrator that ended its turn to wait for a wake
// was never told the worker it meant to give the next task to was free, and the idle close then ended the run with that task open. Two wakes:
//   - after a hand-back the plan took (`seen.absorbed`), once its evaluation has landed: the open tasks whose dependencies are done and
//     that no policy step names, due or in flight, or halts (its exception wake has already gone). Sent on every such hand-back that leaves
//     some (`poll`): a queue drained by fewer workers than tasks is told after each one, and the hand-backs bound it;
//   - at the headless idle close of a planned run, before the run closes: every open task of the run, ready or not (`atClose`). Sent again
//     only when a task row of the run has moved since the last one, so an unchanged state cannot loop. Its write is a pending write: it holds
//     the close until the orchestrator has read it, bounded by the same expiry as every wake. A close with open tasks left after it is
//     recorded (`record().closed_open`).
// The wake's seq is the run's highest task row seq, a store fact, so a restarted interactive publisher does not reuse a delivered id.
// Facts only: task ids, a worker id, counts. Never an instruction and never a step: what to do with open work is the orchestrator's.

const { due } = require('./policy-exec.cjs');
const PW = require('./policy-wakes.cjs');

const IDS = 8; // task ids named in one wake; the rest are counted
const plural = (n) => `${n} open task${n === 1 ? '' : 's'}`;
const names = (ids, k) => `${ids.slice(0, k).join(', ')}${ids.length > k ? `, and ${ids.length - k} more` : ''}`;
// The text with as many ids as fit the wake cap (fewer named, the rest counted), then cut as every wake is.
function fit(build, ids) {
  let k = Math.min(IDS, ids.length), text = build(names(ids, k));
  while (k > 1 && Buffer.byteLength(text) > PW.WAKE_TEXT_MAX) text = build(names(ids, --k));
  return require('./review-wake.cjs').cut(text, PW.WAKE_TEXT_MAX);
}

// A released review whose evaluation has not landed (its hand-back is newer than its evaluation) is not yet settled: the plan is still about to act on it.
const evalPending = (t) => !!(t.handoff && t.handoff.at != null && !(t.results && Number(t.results.evaluated_at) >= Number(t.handoff.at)));
const mine = (tasks, runId) => tasks.filter((t) => t.run_id === runId);
const openOf = (tasks, runId) => mine(tasks, runId).filter((t) => t.state === 'open');
// A dependency is ready when it is done and, if its plan merges it and the plan is still at work on it (`carried`: a step due or in flight on
// it, or a task not yet terminal rooted at it, its review or a fix round), merged. This differs from the plan's build gate (policy-exec.cjs due,
// depReady) on purpose: a done, unmerged dependency nothing of the plan will move (an integrate on_hold with no review to lead to it) is ready
// by done, as the core's assign reads it, because only the orchestrator can move it.
const depReady = (u, byId, carried) => !!u && u.state === 'done' && (!carried.has(u.id) || !(PW.policyOf(u, byId) || {}).integrate || !!(u.integration && u.integration.state === 'merged'));
const ready = (t, byId, carried = new Set()) => (Array.isArray(t.depends_on) ? t.depends_on : []).every((d) => depReady(byId.get(d), byId, carried));
const maxSeq = (tasks, runId) => mine(tasks, runId).reduce((m, t) => Math.max(m, Number(t.seq) || 0), 0);
const stateOf = (tasks, runId) => mine(tasks, runId).map((t) => `${t.id}:${t.seq}`).sort().join(',');
const isPlanned = (tasks, runId) => { const byId = new Map(tasks.map((t) => [t.id, t])); return mine(tasks, runId).some((t) => PW.policyOf(t, byId)); };

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
  // An integration merging holds every other integrate back in due(); the plan still carries those, so they are listed with the gate off.
  for (const c of due({ runId, tasks, integrations: (snap.integrations || []).filter((i) => i.state !== 'merging'), steps: snap.steps || [] })) { carried.add(c.task_id); for (const id of c.task_ids || []) carried.add(id); }
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

// `planned()`: whether the store shows a plan for the run (planned.cjs), for an idle close with no policy snapshot.
function createStallWatcher({ core, runId, planned = () => false }) {
  const armed = []; // hand-backs the plan took, not yet settled: { worker_id, task_ids }
  let closeState = null; // the run's task rows (id:seq) when the last close wake was written
  const rec = { raised: [], closed_open: null };
  const wake = (ids, text, via, tasks) => {
    rec.raised.push({ via, task_ids: ids });
    return { event: 'stalled', worker_id: `${via === 'close' ? 'stall-close' : 'stall'}:${runId}`, turn: 0, seq: maxSeq(tasks, runId), task_ids: ids, text, established_by: via === 'close' ? 'task.list at the idle close' : 'task.list and policy.list after a hand-back the plan took' };
  };

  // -> [] or [the wake]. `seen`: the release-eval map (absorbed hand-backs, and `pending`, the evaluations still out). `snap`: the policy
  // watcher's snapshot of this poll (null when off, `failed` when its read failed: nothing is decided, the hand-back stays armed).
  function poll(seen, snap) {
    if (seen && Array.isArray(seen.absorbed) && seen.absorbed.length) armed.push(...seen.absorbed.splice(0));
    if (!armed.length || !snap || snap.failed || snap.readFailed || !Array.isArray(snap.tasks)) return [];
    const pending = (seen && seen.pending) || new Map();
    if (armed.some((a) => a.task_ids.some((id) => pending.has(id)))) return []; // an evaluation still out: the plan's next step is not known yet
    const last = armed[armed.length - 1];
    armed.length = 0;
    const ids = untaken(snap);
    if (!ids.length) return [];
    return [wake(ids, fit((l) => `belay: worker ${last.worker_id} handed back ${last.task_ids.join(', ')} and the plan took the hand-back; ${plural(ids.length)} nobody is assigned, no policy step due: ${l}.`, ids), 'hand-back', snap.tasks)];
  }

  // At the idle close, with nothing else holding it: -> the wake to write instead of closing, or null to close. `snap` as for poll; without a
  // usable one, and with a plan in the store, the run's tasks are read. A run with no plan is not checked. A failed read says nothing and the
  // close goes ahead, as the pre-close notice does.
  async function atClose(snap) {
    let tasks = snap && !snap.failed && Array.isArray(snap.tasks) ? snap.tasks : null;
    if (!tasks) {
      if (!planned()) return null;
      try { tasks = ((await core.task.list({})) || {}).tasks || []; } catch { rec.closed_open = null; rec.close_read_failed = true; return null; }
    }
    if (!planned() && !isPlanned(tasks, runId)) return null;
    const open = openOf(tasks, runId);
    const ids = open.map((t) => t.id).sort();
    if (!ids.length) { rec.closed_open = null; return null; }
    const now = stateOf(tasks, runId);
    if (now !== closeState) {
      closeState = now;
      const byId = new Map(tasks.map((t) => [t.id, t]));
      const readyIds = ids.filter((id) => ready(byId.get(id), byId)), waiting = ids.length - readyIds.length;
      const shown = waiting ? readyIds.concat(ids.filter((id) => !readyIds.includes(id))) : ids; // the ready ones first: those are the ones to start
      const note = waiting ? ` (${readyIds.length ? `${readyIds.length} ready: ${names(readyIds, 4)}; ` : ''}${waiting} waiting on dependencies)` : '';
      return wake(ids, fit((l) => `belay: stalled: ${plural(ids.length)}, nobody assigned${note}: ${l}. The run closes when you next end a turn with no worker mid-turn, and they stay open.`, shown), 'close', tasks);
    }
    rec.closed_open = ids; // told, and the orchestrator ended its turn with nothing changed: the close goes ahead, and the receipt says so
    return null;
  }

  return { poll, atClose, record: () => ({ raised: rec.raised.slice(), closed_open: rec.closed_open, ...(rec.close_read_failed ? { close_read_failed: true } : {}) }) };
}

// The run's one watcher, kept on its state, so the poll and the idle close share what each has named.
const of = (state, ctx) => state.stallWatch || (state.stallWatch = createStallWatcher(ctx));

module.exports = { createStallWatcher, untaken, of, IDS };
