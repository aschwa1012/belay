'use strict';
// wake.cjs — build step 5b, design item 3; extended by
// 5b-4, design item 1, to close the death-wake race
// (ADR 0015 §2, api.md §5 Liveness). Two pure functions, no store access and no I/O: `diffWorkers`
// derives the wakes owed, and now the pending deaths the poll should hold on, by comparing the
// store's own `worker.list` rows against the previous per-worker baseline the caller carries
// forward; `wakeText` renders the message the parent writes to the orchestrator's stdin. Content-
// free by design (ADR 0015 §2): no worker output ever appears in the text, only the id, the turn
// and the exit facts.

// build step 6f, design item 1, ADR 0023 amendment 3
// decision 3: a row of the run that first reads `paused` emits one `paused` event (in place of the
// `turn_end` for the interrupted turn) and is never counted as a pending death — its pid is dead by
// construction (a park's own row is written from the exit handler) and the park's own exit handler
// already produced this row, so there is nothing left for a death detector to announce.
//
// prev: { [worker_id]: { turns, state, pid_dead_seen_at_ms? } } — the baseline from the previous
// call, or {} on the first. `pid_dead_seen_at_ms` (5b-4) is present only while the row has stayed
// non-terminal with a dead pid continuously since that moment; a live pid or a terminal state drops
// it from the next baseline.
// rows: this poll's worker.list({}) rows (every state), already carrying pid_alive/last_event_age_ms
// (methods-run.cjs decorate) and, from build step 5b, mid_turn/death_established_by.
// runId: only rows for this run are considered; every other row is ignored and never baselined.
// nowMs, graceMs (5b-4): the poll's own elapsed clock and the grace a dead-pid row is held for
// before the caller's own 5a rule (a dead pid on a non-terminal row does not hold) applies to it.
// orphanGraceMs, adapterAlive(pid): a row whose adapter is dead has no detector left to write its death, so it
// is held only orphanGraceMs; without adapterAlive every row gets graceMs.
// sinceAt: the wall-clock ms the baseline began. A first-sight `dead` row whose exited_at is earlier is history (a run id run again,
// a publisher started late); any other first-sight death is news. Null: every first-sight death of this run is news.
function diffWorkers({ prev, rows, runId, nowMs, graceMs, orphanGraceMs = graceMs, adapterAlive = null, sinceAt = null }) {
  const next = { ...(prev || {}) };
  const events = [];
  const pending_deaths = [];
  for (const row of rows || []) {
    if (row.run_id !== runId) continue;
    const turns = row.turns || 0;
    let base = next[row.id];
    if (!base) {
      // First sight. A worker already stopped or dead when first seen produced no wake this
      // adapter could have written (it never watched the turn happen) — baseline it as seen and
      // move on: no event and no pending death either, however dead its pid already reads. Any
      // other first-sight state is baselined at turns 0: worker_spawn already returned at ready, so
      // a turn that ended between spawn and this poll is news, not history.
      // build step 6f, decision 3: a first-sight `paused` row is baselined silently too, same as
      // `stopped`/`dead` — a park this adapter never watched happen is history, not news.
      // Audit R3: a `dead` row of this run that died after the baseline began is news too. worker_spawn returned at ready, so a
      // worker that crashed (or was killed) before this poll is first seen dead, and its death and finished turns are owed a wake.
      const deathIsNews = row.state === 'dead' && !(sinceAt != null && Number.isFinite(row.exited_at) && row.exited_at < sinceAt);
      if ((row.state === 'stopped' || row.state === 'dead' || row.state === 'paused') && !deathIsNews) {
        next[row.id] = { turns, state: row.state };
        continue;
      }
      base = { turns: 0, state: deathIsNews ? 'starting' : row.state };
      next[row.id] = base;
    }
    const justParked = base.state !== 'paused' && row.state === 'paused';
    // Fix round (finding 6), narrowed by build step 6i design item 1 (C2): a park reuses the ordinary
    // graceful stop, which can write an intermediate `stopping` row that already carries the interrupted
    // turn's bumped count. A `stopping` row with `park_turns` set (this park's own turns-at-acceptance,
    // `pause.cjs` step 1b) reports every turn up to it exactly as a live row would — a turn that finished
    // on its own just before the pause is still `turn_end`, then `paused` — and masks only an increment
    // above it, the interrupted turn's own result the `paused` event below is about to announce (decision
    // 3). A `stopping` row with `park_turns` null (a plain stop, not a park) keeps the old full mask.
    const parkTurns = row.park_turns;
    const settledTurns = row.state === 'stopping' ? (parkTurns == null ? base.turns : Math.min(turns, parkTurns)) : turns;
    if (justParked) {
      // Should-fix (review of build step 6i item 1): the `paused` row carries `park_turns` forward too,
      // but this branch never read it, so a poll that never saw the intermediate `stopping` row (a park
      // whose own turn ended and settled between two polls) swallowed that turn_end outright. Reported
      // up to `park_turns` first, exactly as a `stopping` row above, before the `paused` event itself.
      if (parkTurns != null && parkTurns > base.turns) {
        const skipped = parkTurns - base.turns - 1;
        const ev = { worker_id: row.id, event: 'turn_end', turn: parkTurns, seq: row.seq };
        if (skipped > 0) ev.turns_skipped = skipped;
        events.push(ev);
      }
      events.push({ worker_id: row.id, event: 'paused', turn: turns, seq: row.seq, paused_by: row.paused_by || null });
    } else if (settledTurns > base.turns) {
      const skipped = settledTurns - base.turns - 1;
      const ev = { worker_id: row.id, event: 'turn_end', turn: settledTurns, seq: row.seq };
      if (skipped > 0) ev.turns_skipped = skipped;
      events.push(ev);
    }
    if (base.state !== 'dead' && row.state === 'dead') {
      events.push({
        worker_id: row.id, event: 'death', turn: turns, seq: row.seq,
        exit_code: row.exit_code == null ? null : row.exit_code,
        exit_signal: row.exit_signal == null ? null : row.exit_signal,
        death_established_by: row.death_established_by || null,
        ...(Array.isArray(row.leases_released) && row.leases_released.length ? { leases_released: row.leases_released } : {}), // ADR 0026 amendment 1
      });
    }
    // `stopped` (the harness ended it on someone's instruction) produces no event, and every other
    // transition (starting -> running, running -> idle between Codex turns) is silent too: `idle`
    // wakes only through the turns-grew check above, never through a state-transition check of its
    // own.
    const entry = { turns: settledTurns, state: row.state };
    // 5b-4: a non-terminal row whose pid this poll's own check found dead is a pending death until
    // the detector's row lands or the grace elapses. Not for a row that just reached `dead` or
    // `stopped` this very poll (its own event above is the record now, and a terminal row is never
    // pending), and not for one whose pid reads alive again (the field is simply not re-added, so it
    // drops out of the next baseline).
    if (row.state !== 'dead' && row.state !== 'stopped' && row.state !== 'paused' && row.state !== 'idle' && row.pid_alive === false) { // idle: a Codex worker between turns, its process finished by design
      const seenAt = base.pid_dead_seen_at_ms == null ? nowMs : base.pid_dead_seen_at_ms;
      entry.pid_dead_seen_at_ms = seenAt;
      const waited_ms = nowMs - seenAt;
      const grace = adapterAlive && !adapterAlive(row.adapter_pid) ? orphanGraceMs : graceMs;
      if (waited_ms < grace) pending_deaths.push({ worker_id: row.id, seen_at_ms: seenAt, waited_ms });
    }
    next[row.id] = entry;
  }
  return { events, next, pending_deaths };
}

// ADR 0026 amendments 1 and 2 (proposed): the leases a death released, as facts. Each task is open, unless the dead worker's own
// hand-back still lands (amendment 2), which the store will then show as released. The clauses, most to least informative.
const POINTER = ' Its rows are in the store: task_list, briefing.';
function releasedClauses(released) {
  const s = released.length > 1 ? 's' : '';
  return [` Released lease${s} ${released.map((r) => `${r.lease_id} on task ${r.task_id}`).join(', ')}; open unless its hand-back lands.`,
    ` Released its lease on task${s} ${released.map((r) => r.task_id).join(', ')}; open unless its hand-back lands.`,
    ` Released ${released.length} lease${s}; open unless a hand-back lands.`];
}

// A death wake, under the interactive cap. With leases released, the first fit wins: the full head with the lease and task ids,
// then the head without what established the death (the store's row keeps it) with them, then the count after either head, so
// the clause and the pointer both survive the cap. With no room even then, or nothing released, it is as before.
function deathText(event) {
  const full = `belay: worker ${event.worker_id} died during turn ${event.turn} ` +
    `(exit code ${event.exit_code}, signal ${event.exit_signal}, established by ${event.death_established_by}).`;
  const released = Array.isArray(event.leases_released) && event.leases_released.length ? event.leases_released : null;
  if (released) {
    const short = `belay: worker ${event.worker_id} died during turn ${event.turn} (exit code ${event.exit_code}).`;
    const [ids, tasks, count] = releasedClauses(released);
    const max = require('./release-eval.cjs').WAKE_TEXT_MAX;
    const fit = [[full, ids], [full, tasks], [short, ids], [short, tasks], [full, count], [short, count]].find(([h, c]) => Buffer.byteLength(h + c + POINTER, 'utf8') <= max);
    if (fit) return fit[0] + fit[1] + POINTER;
  }
  return full + POINTER;
}

// No worker output, ever: the id, the turn and (for a death) the exit facts are the whole of it.
// Both shapes stay comfortably under 400 bytes for any id this codebase generates.
// A wake never names idle workers: worker_wait's answer does (idle-remind.cjs).
function wakeText(event) {
  if (event.event === 'note_refuted' || event.event === 'scrub_alarm' || event.event === 'evaluated') return event.text; // evaluated: release-eval.cjs, facts only // note-wake.cjs: belay's own record, built from the core's facts
  if (event.event === 'death') return deathText(event);
  // build step 6f, decision 3's own words, ids and facts only (ADR 0015 §2): no worker output.
  if (event.event === 'paused') {
    return `belay: worker ${event.worker_id} was paused by ${event.paused_by} during turn ${event.turn}; ` +
      `its process is parked and its session kept, and it takes no turn until the operator resumes it.`;
  }
  // ADR 0058: the hand-back's evaluation, as facts, sized so the whole text fits the interactive wake budget.
  return require('./release-eval.cjs').turnEndText(`belay: worker ${event.worker_id} finished turn ${event.turn}.`,
    '', event.evaluated, event.evaluating);
}

// A worker this run manager (via the orchestrator's own adapter) launched is mid-turn on the store's
// own say-so (build step 5b): `starting` or `running`, a live pid, and `mid_turn: 1`. No stream is
// read here, and no turn-count heuristic stands in for what the row itself now carries — except for a
// row this migration never touched: `worker.cjs`'s own `rowOf` writes an explicit 0 or 1 on every row
// it ever produces (never leaves the column unset), so `mid_turn` is genuinely NULL only for a row
// written before this migration landed, or one planted directly through the store rather than through
// the run manager (as several of 5a's own tests do). Such a row carries no claim at all, and the
// pre-5b signal (a live `running` row with no turn yet) is what it is judged by instead. Moved here
// verbatim from orchestrator.cjs at build step 6f, to keep that file under its own line budget.
function isMidTurn(w) {
  if (w.pid_alive !== true) return false;
  if (w.state !== 'starting' && w.state !== 'running') return false;
  if (w.mid_turn === 1) return true;
  if (w.mid_turn === 0) return false;
  return w.turns === 0;
}

// 6f-2 design item 9: moved wholesale from orchestrator.cjs (`recordHold`) to keep that file under its
// own line budget. A moment, not a tick (5a-2): a hold record is appended only when the busy/awaiting/
// pending-deaths/parked/live sets differ from the previous poll's, the first poll included. `busy: null`
// with `established_by` naming a failed read is its own distinct moment. `reset()` is orchestrator.cjs's
// own `lastHoldKey = undefined`, called at every turn end (5a-3: a hold is scoped to one turn's idle
// period, not the whole run).
function createHoldRecorder() {
  let lastHoldKey;
  function reset() { lastHoldKey = undefined; }
  function record(holds, atMs, turn, busy, awaiting, establishedBy, pendingDeaths, parked, live) {
    const pd = pendingDeaths || [];
    const pk = parked || [];
    const lv = live || [];
    const key = busy === null
      ? ' '
      : JSON.stringify([busy.slice().sort(), awaiting.slice().sort(), pd.slice().sort(), pk.slice().sort(), lv.slice().sort()]);
    if (key === lastHoldKey) return;
    lastHoldKey = key;
    const rec = { at_ms: atMs, turn, busy, established_by: establishedBy, awaiting_wake: awaiting };
    if (pd.length) rec.pending_deaths = pd;
    if (pk.length) rec.parked = pk;
    if (lv.length) rec.live = lv;
    holds.push(rec);
  }
  return { reset, record };
}

module.exports = { diffWorkers, wakeText, isMidTurn, createHoldRecorder };
