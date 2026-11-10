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

const PW = require('./policy-wakes.cjs');
const { untaken, mine, openOf, ready } = require('./policy-carried.cjs');

const IDS = 8; // task ids named in one wake; the rest are counted
const plural = (n) => `${n} open task${n === 1 ? '' : 's'}`;
const names = (ids, k) => `${ids.slice(0, k).join(', ')}${ids.length > k ? `, and ${ids.length - k} more` : ''}`;
// The text with as many ids as fit the wake cap (fewer named, the rest counted), then cut as every wake is.
function fit(build, ids) {
  let k = Math.min(IDS, ids.length), text = build(names(ids, k));
  while (k > 1 && Buffer.byteLength(text) > PW.WAKE_TEXT_MAX) text = build(names(ids, --k));
  return require('./review-wake.cjs').cut(text, PW.WAKE_TEXT_MAX);
}

const maxSeq = (tasks, runId) => mine(tasks, runId).reduce((m, t) => Math.max(m, Number(t.seq) || 0), 0);
const stateOf = (tasks, runId) => mine(tasks, runId).map((t) => `${t.id}:${t.seq}`).sort().join(',');
const isPlanned = (tasks, runId) => { const byId = new Map(tasks.map((t) => [t.id, t])); return mine(tasks, runId).some((t) => PW.policyOf(t, byId)); };

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
