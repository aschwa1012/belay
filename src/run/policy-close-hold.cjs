'use strict';
// policy-close-hold.cjs — what of a plan holds the headless idle close (orchestrator-idle-close.cjs). The policy executor runs in the
// orchestrator's adapter and acts on its own tick, and a planned hand-back does not wake the orchestrator, so without this the run could close
// between a work's evaluation and the step that follows it (a review not yet given, a merge not yet made), or under a step in flight.
// It reads the policy watcher's snapshot of this poll (policy-wakes.cjs createPolicyWatcher), so it adds no read and starts no process.
// Two kinds of hold, each named in the hold record the way a release evaluation's `eval:<id>` is:
//   policy:<step>:<task>  a step the executor's due() lists on these rows, not yet claimed, on a task no exception halts (haltedIds).
//                         Bounded: a step due for DUE_HOLD_MS without being claimed (the executor ticks every 2 s) stops holding,
//                         so a step that never runs (no executor, a store it cannot reach) cannot hold the run open.
//   policy-step:<seq>     a claim still `started` whose claimant (the adapter that took it) has a live pid: the step is running. A claim
//                         whose claimant is gone, or names none, is a dead life's and holds nothing (the next life's sweep finishes it).
// A step the executor took and finished `exception` halts its task (E8), so it is neither due nor in flight. The run timeout and a pause
// are unchanged: this only adds names to the close's `live` holds.

const { due, keyOf } = require('./policy-exec.cjs');
const PW = require('./policy-wakes.cjs');
const P = require('./process.cjs');

const DUE_HOLD_MS = 30000;

// -> the hold names. `snap`: the watcher's snapshot ({ runId, tasks, integrations, steps, revisions? }) or null. `since`: a Map the caller
// keeps across polls (a due step's first sighting). `alive(pid)`: the claimant check. `exceptions`: derive() of the same snapshot, if made.
function policyHolds(snap, since, { nowMs = Date.now(), dueHoldMs = DUE_HOLD_MS, alive = P.pidAlive, exceptions = null } = {}) {
  if (!snap || !Array.isArray(snap.tasks)) { since.clear(); return []; }
  const { runId } = snap;
  const steps = (snap.steps || []).filter((s) => s.run_id === runId);
  const out = [];
  for (const s of steps) if (s.outcome === 'started' && s.claimant_pid && alive(Number(s.claimant_pid))) out.push(`policy-step:${s.seq}`);
  // A claim the executor reopens (a pause or a plan that moved) is due again; any other claim has taken its trigger (policy-exec.cjs pass).
  const claimed = new Set(steps.filter((s) => !(s.outcome === 'skipped' && /^E_(PAUSED|NOT_NOW)/.test(s.error || ''))).map((s) => keyOf(s.step, { table: s.trigger_table, id: s.trigger_id, seq: Number(s.trigger_seq) || 0 })));
  const halted = PW.haltedIds(exceptions || PW.derive({ ...snap, failures: snap.failures || [] }), snap.tasks); // the watcher's own derivation of these rows, when given
  const seen = new Set();
  for (const c of due({ runId, tasks: snap.tasks, integrations: snap.integrations || [] })) {
    const key = keyOf(c.step, c.trigger);
    if (halted.has(c.task_id) || claimed.has(key)) continue;
    seen.add(key);
    if (!since.has(key)) since.set(key, nowMs);
    if (nowMs - since.get(key) < dueHoldMs) out.push(`policy:${c.step}:${c.task_id}`);
  }
  for (const k of [...since.keys()]) if (!seen.has(k)) since.delete(k);
  return out;
}

module.exports = { policyHolds, DUE_HOLD_MS };
