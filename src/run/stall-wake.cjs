'use strict';
// stall-wake.cjs — open work that nobody is assigned and no policy step will take (ADR 0074 amendment 3). Under a plan a hand-back is
// routine and wakes nobody (release-eval.cjs enrichWakes consumes its turn end), so an orchestrator that ended its turn to wait for a wake
// was never told the worker it meant to give the next task to was free, and the idle close then ended the run with that task open. Two wakes:
//   - after a hand-back the plan took (`seen.absorbed`), once its evaluation has landed: the open tasks whose dependencies are done and
//     that no policy step names, due or in flight. Each task is named in this wake at most once per run (`poll`);
//   - at the headless idle close, before the run closes: every open task of the run, ready or not (`atClose`). Each task is named in this
//     wake at most once per run, so it cannot loop. Its write is a pending write: it holds the close until the orchestrator has read it,
//     bounded by the same expiry as every wake. A close with open tasks left after it is recorded (`record().closed_open`).
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

const openOf = (tasks, runId) => tasks.filter((t) => t.run_id === runId && t.state === 'open');
const ready = (t, byId) => (Array.isArray(t.depends_on) ? t.depends_on : []).every((d) => { const u = byId.get(d); return u && u.state === 'done'; });

// The open, ready tasks of the run that no policy step names: neither due (and not halted) nor claimed and still in flight.
function untaken(snap) {
  const { runId } = snap;
  const tasks = snap.tasks || [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const named = new Set();
  const halted = PW.haltedIds(PW.derive({ ...snap, failures: snap.failures || [] }), tasks);
  for (const c of due({ runId, tasks, integrations: snap.integrations || [] })) if (!halted.has(c.task_id)) { named.add(c.task_id); for (const id of c.task_ids || []) named.add(id); }
  for (const s of snap.steps || []) if (s.run_id === runId && s.outcome === 'started' && s.task_id) named.add(s.task_id);
  return openOf(tasks, runId).filter((t) => ready(t, byId) && !named.has(t.id)).map((t) => t.id).sort();
}

function createStallWatcher({ core, runId }) {
  const armed = []; // hand-backs the plan took, not yet settled: { worker_id, task_ids }
  const toldPoll = new Set(), toldClose = new Set();
  const rec = { raised: [], closed_open: null };
  let n = 0;
  const wake = (ids, text, via) => { n += 1; rec.raised.push({ via, task_ids: ids }); return { event: 'stalled', worker_id: `stall:${runId}`, turn: 0, seq: n, task_ids: ids, text, established_by: via === 'close' ? 'task.list at the idle close' : 'task.list and policy.list after a hand-back the plan took' }; };

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
    if (!ids.some((id) => !toldPoll.has(id))) return [];
    for (const id of ids) toldPoll.add(id);
    return [wake(ids, fit((l) => `belay: worker ${last.worker_id} handed back ${last.task_ids.join(', ')} and the plan took the hand-back; ${plural(ids.length)} nobody is assigned, no policy step due: ${l}.`, ids), 'hand-back')];
  }

  // At the idle close, with nothing else holding it: -> the wake to write instead of closing, or null to close. `snap` as for poll; without a
  // usable one the run's tasks are read. A failed read says nothing and the close goes ahead, as the pre-close notice does.
  async function atClose(snap) {
    let tasks = snap && !snap.failed && Array.isArray(snap.tasks) ? snap.tasks : null;
    if (!tasks) { try { tasks = ((await core.task.list({})) || {}).tasks || []; } catch { return null; } }
    const ids = openOf(tasks, runId).map((t) => t.id).sort();
    if (!ids.length) { rec.closed_open = null; return null; }
    if (ids.some((id) => !toldClose.has(id))) {
      for (const id of ids) toldClose.add(id);
      return wake(ids, fit((l) => `belay: stalled: ${plural(ids.length)}, nobody assigned: ${l}. The run closes when you next end a turn with no worker mid-turn, and they stay open.`, ids), 'close');
    }
    rec.closed_open = ids; // told, and the orchestrator ended its turn with them still open: the close goes ahead, and the receipt says so
    return null;
  }

  return { poll, atClose, record: () => ({ raised: rec.raised.slice(), closed_open: rec.closed_open }) };
}

// The run's one watcher, kept on its state, so the poll and the idle close share what each has named.
const of = (state, ctx) => state.stallWatch || (state.stallWatch = createStallWatcher(ctx));

module.exports = { createStallWatcher, untaken, of, IDS };
