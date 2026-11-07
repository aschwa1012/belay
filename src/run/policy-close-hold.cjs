'use strict';
// policy-close-hold.cjs — what of a plan holds the headless idle close (orchestrator-idle-close.cjs). The policy executor runs in the
// orchestrator's adapter and acts on its own tick, and a planned hand-back does not wake the orchestrator, so without this the run could close
// between a work's evaluation and the step that follows it (a review not yet given, a merge not yet made), or under a step in flight.
// It reads the policy watcher's snapshot of this poll (policy-wakes.cjs createPolicyWatcher), so it adds no store read. The holds, each named
// in the hold record the way a release evaluation's `eval:<id>` is:
//   policy-step:<seq>     a claim still `started` whose claimant (the adapter that took it) is alive by pid and creation time (ADR 0039).
//                         A claim whose claimant is gone, or names no pid, is a dead life's and holds nothing (the next life's sweep ends it).
//   policy-done:<seq>     a claim finished since the last snapshot this tracker read (keyed by seq and finished_at: a reopened claim can
//                         finish again). The worker rows the close decides on were read before the snapshot (orchestrator.cjs pollPass), so
//                         a step that started a worker's turn and finished between the two reads leaves rows where nobody is mid-turn. It
//                         holds this pass only: the next pass reads its rows after this snapshot, where that worker shows mid-turn and holds
//                         the close itself.
//   policy:<step>:<task>  a step the executor's due() lists, not yet claimed, on a task no exception halts (haltedIds). Bounded by DUE_HOLD_MS
//                         of an IDLE executor: the clock restarts while a claim is in flight or newly finished (the executor takes steps one
//                         at a time, so a step queued behind a slow one is not aged by it). A due step the executor never takes stops holding.
//   policy-read           the watcher is on and a read it needs failed this poll: the facts are unknown, as for a failed worker.list.
// A step that finished `exception` halts its task (E8), so after its one policy-done pass it is neither due nor in flight. The run timeout
// and a pause are unchanged.

const { due, keyOf } = require('./policy-exec.cjs');
const PW = require('./policy-wakes.cjs');
const P = require('./process.cjs');

const DUE_HOLD_MS = 30000;
const CLAIMANT_RECHECK_MS = 60000; // a claimant's creation time is read again after this, so a pid reused under a long step is found

// `alive(pid)`: the cheap check every poll. `createdOf(pid)`: the creation time read (a process snapshot), at most one per claimant per
// CLAIMANT_RECHECK_MS, never awaited by the close: until it answers, a live pid counts (fail toward holding).
function createPolicyCloseHold({ alive = P.pidAlive, createdOf = P.createdOf, now = Date.now } = {}) {
  let failedSince = null; // the first of an unbroken run of failed policy reads
  const since = new Map(); // due key -> the last time the executor was seen busy, or the key's first sighting while it was idle
  const finished = new Set(); // `${seq}|${finished_at}` of claims seen finished
  const ids = new Map(); // `${pid}|${created}` -> { match: true|false|null, at, reading }

  function claimantAlive(pid, created) {
    if (!pid || !alive(pid)) return false;
    if (created == null) return true; // a claim that recorded no creation time: the pid is all there is (as the executor's sweep reads it)
    const k = `${pid}|${created}`;
    let e = ids.get(k);
    if (!e) { e = { match: null, at: 0, reading: false }; ids.set(k, e); }
    if (!e.reading && (e.match === null || now() - e.at >= CLAIMANT_RECHECK_MS)) {
      e.reading = true;
      Promise.resolve().then(() => createdOf(pid)).then((r) => { if (r && r.created != null) e.match = String(r.created) === String(created); e.at = now(); }, () => { e.at = now(); }).finally(() => { e.reading = false; });
    }
    return e.match !== false;
  }

  // -> the hold names for this poll. `snap`: the watcher's snapshot (null when the watcher is off; `failed` or `readFailed` when a read it
  // needs failed). `exceptions`: derive() of the same snapshot, when the watcher made it.
  function holds(snap, { exceptions = null } = {}) {
    if (!snap) { since.clear(); return []; }
    // A failed read holds, as a failed worker.list does, but not for ever: past DUE_HOLD_MS of unbroken failures the facts are taken as
    // unknowable and the close goes ahead (the hold record names each pass it held).
    if (snap.failed || snap.readFailed || !Array.isArray(snap.tasks)) { const t0 = now(); if (failedSince == null) failedSince = t0; return t0 - failedSince < DUE_HOLD_MS ? ['policy-read'] : []; }
    failedSince = null;
    const { runId } = snap;
    const t = now();
    const steps = (snap.steps || []).filter((s) => s.run_id === runId);
    const out = [];
    let busy = false;
    for (const s of steps) {
      if (s.outcome === 'started') { if (claimantAlive(Number(s.claimant_pid), s.claimant_created)) { out.push(`policy-step:${s.seq}`); busy = true; } continue; }
      const k = `${s.seq}|${s.finished_at}`;
      if (finished.has(k)) continue;
      finished.add(k);
      out.push(`policy-done:${s.seq}`); busy = true;
    }
    // A claim the executor reopens (a pause or a plan that moved) is due again; any other claim has taken its trigger (policy-exec.cjs pass).
    const claimed = new Set(steps.filter((s) => !(s.outcome === 'skipped' && /^E_(PAUSED|NOT_NOW)/.test(s.error || ''))).map((s) => keyOf(s.step, { table: s.trigger_table, id: s.trigger_id, seq: Number(s.trigger_seq) || 0 })));
    const halted = PW.haltedIds(exceptions || PW.derive({ ...snap, failures: snap.failures || [] }), snap.tasks);
    const seen = new Set();
    for (const c of due({ runId, tasks: snap.tasks, integrations: snap.integrations || [], rounds: snap.rounds, failures: snap.failures, roundSteps: steps })) {
      const key = keyOf(c.step, c.trigger);
      if (halted.has(c.task_id) || claimed.has(key)) continue;
      seen.add(key);
      if (busy || !since.has(key)) since.set(key, t);
      if (t - since.get(key) < DUE_HOLD_MS) out.push(`policy:${c.step}:${c.task_id}`);
    }
    for (const k of [...since.keys()]) if (!seen.has(k)) since.delete(k);
    return out;
  }

  return { holds };
}

module.exports = { createPolicyCloseHold, DUE_HOLD_MS, CLAIMANT_RECHECK_MS };
