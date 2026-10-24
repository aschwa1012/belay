'use strict';
// run-hold.cjs — build step 6f, design item 2, ADR 0023
// amendment 3 decisions 1 and 3. The orchestrator's own pause state, moved out of orchestrator.cjs so
// that file stays under its own line budget: `orchestrator.cjs` keeps the child process, the parser
// and the timers, and calls into this module for everything a run pause needs to remember or do.
//
// While the run is paused: `writeWake` (orchestrator.cjs) holds every wake in `wakesHeld` instead of
// writing it — held wakes are recorded, never suppressed; `pollOnce` never closes stdin, recording a
// hold `established_by: 'run paused'`; the `timeout_ms` timer is cleared by the caller, the remaining
// milliseconds captured here and returned to the caller to re-arm on resume.
//
// The hook handed to the stop control (orchestrator.cjs) gains `pause(by)` and `resume(by)`, both thin
// delegations to `pause()`/`resume()` here, which do the actual interrupt exchange: an unconditional
// `control_request` on the child's stdin, a bounded wait for its `control_response`, and, when the
// orchestrator was mid-turn at the send, a further wait (inside the same bound) for that turn's own
// end. `onControlResponse`/`onTurnEnd` are called by orchestrator.cjs's `handleEvent` for every such
// event, whether or not a pause is waiting on one — a no-op when nothing is.

const crypto = require('node:crypto');

const INTERRUPT_TIMEOUT_MS = 5000;

// `child`: the spawned orchestrator process (its `.stdin` is written to directly, as pause.cjs's own
// worker-level interrupt does). `getIdle`: () => state.idle at the instant of the call. `onDeadline(reason)`
// is orchestrator.cjs's own `closeThenKillOnDeadline`, called when the timeout clock this module now owns
// (design item 9: moved here wholesale from orchestrator.cjs to keep that file under its own line budget)
// fires unpaused. `writeStdinLine(text, workerId, wakeRecord)` and `wakeText(rec)` are orchestrator.cjs's
// own, injected so `resume()` can write the resume line and every held wake without orchestrator.cjs
// needing its own wrapper around this module's state. `nowMs()` (design item 5, run-hold.cjs:133) is
// milliseconds since the run's own t0, the same basis every entry in `wakes[]` uses — never the wall clock.
function createRunHold({ child, getIdle, onDeadline, writeStdinLine, wakeText, pushWake, nowMs }) {
  let paused = false;
  let pausedAt = null;
  let pausedBy = null;
  const wakesHeld = [];
  const pauses = []; // { at_ms, by, resumed_at_ms, interrupt }
  let controlWaiter = null; // { request_id, resolve }
  let turnEndWaiter = null; // { resolve }

  // `6f, amendment 3 decision 2`: lets a run pause stop the clock and a resume re-arm what remained.
  let timeoutTimer = null;
  let timeoutDeadline = null; // the wall-clock deadline while timeoutTimer is armed; null if none
  function armTimeout(ms) {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    timeoutTimer = setTimeout(() => onDeadline('timeout'), ms);
    timeoutDeadline = Date.now() + ms;
  }
  function clearTimeoutClock() { if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; } }
  function getTimeoutRemaining() { return timeoutDeadline == null ? null : Math.max(0, timeoutDeadline - Date.now()); }

  const isPaused = () => paused;
  const pausedFacts = () => ({ paused_at: pausedAt, paused_by: pausedBy });

  // orchestrator.cjs's writeWake: while paused, hold the wake record instead of writing it. Returns
  // true when held (the caller must then skip the ordinary stdin write and `state.wakes.push`).
  function holdWake(rec) {
    if (!paused) return false;
    // 6f-2 fix round (note, run-hold.cjs:57): run-relative, like every other `at_ms` in this receipt
    // (design item 5) — this was still `Date.now()`, the one field review 2 found left as wall clock.
    wakesHeld.push({ ...rec, held_at_ms: nowMs() });
    return true;
  }

  function onControlResponse(ev) {
    if (controlWaiter && ev.request_id === controlWaiter.request_id) {
      const w = controlWaiter; controlWaiter = null; w.resolve(ev);
    }
  }
  function onTurnEnd(ev) {
    if (turnEndWaiter) { const w = turnEndWaiter; turnEndWaiter = null; w.resolve(ev); }
  }

  // ADR 0023 amendment 3 decision 4.3: `pause(by)` sets the paused state synchronously (so a caller
  // reading it right after this call sees it held), then sends the interrupt and waits.
  //
  // Both waiters are armed BEFORE the interrupt is written to stdin, and never after. A substrate (the
  // fake included) can answer the control_response and end the interrupted turn in the very same
  // stdout chunk: `child.stdout`'s 'data' handler runs every event of that chunk synchronously, one
  // `handleEvent` call after another, before any promise continuation (including this function's own
  // resumption past an `await`) gets a turn. Arming `turnEndWaiter` only after `await`-ing the control
  // response (the previous shape) let that exact ordering land the turn_end on a waiter that did not
  // exist yet — lost, not late — so `turn_ended` read back false and the caller waited out the whole
  // bound for nothing. Both are armed here, synchronously, before `child.stdin.write` ever runs.
  async function pause(by) {
    paused = true;
    // design item 5: `pausedAt` counts from the run's own t0, like every wakes[] record, not wall clock.
    pausedAt = nowMs();
    pausedBy = by;
    const remaining_ms = getTimeoutRemaining();
    clearTimeoutClock();

    const turnWasRunning = !getIdle();
    const t0 = Date.now();
    const requestId = 'belay-run-pause-' + crypto.randomUUID();

    const controlPromise = new Promise((resolve) => {
      const timer = setTimeout(() => { controlWaiter = null; resolve(null); }, INTERRUPT_TIMEOUT_MS);
      if (timer.unref) timer.unref();
      controlWaiter = { request_id: requestId, resolve: (ev) => { clearTimeout(timer); resolve(ev); } };
    });
    const turnEndPromise = turnWasRunning ? new Promise((resolve) => {
      const timer = setTimeout(() => { turnEndWaiter = null; resolve(null); }, INTERRUPT_TIMEOUT_MS);
      if (timer.unref) timer.unref();
      turnEndWaiter = { resolve: (ev) => { clearTimeout(timer); resolve(ev); } };
    }) : null;

    const stdin = child.stdin;
    let sent = !!stdin && !stdin.destroyed && !stdin.writableEnded;
    if (sent) {
      try { stdin.write(JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } }) + '\n'); }
      catch { sent = false; }
    }
    if (!sent) controlWaiter = null; // nothing will ever answer; the armed promise's own timer settles it

    const control = sent ? await controlPromise : null;
    const response_ms = control ? Date.now() - t0 : null;

    let turn_ended = false, result_subtype = null, result_ms = null;
    if (turnEndPromise) {
      const ev = await turnEndPromise;
      if (ev) { turn_ended = true; result_subtype = ev.subtype || null; result_ms = Date.now() - t0; }
    }

    const interrupt = {
      sent, request_id: requestId, response_subtype: control ? control.subtype : null, response_ms,
      turn_was_running: turnWasRunning, turn_ended, result_subtype, result_ms,
    };
    pauses.push({ at_ms: pausedAt, by, resumed_at_ms: null, interrupt, remaining_ms });
    return { paused_at: pausedAt, paused_by: pausedBy, interrupt, timeout: remaining_ms == null ? null : { remaining_ms } };
  }

  // Flips the state, re-arms the clock, writes `line` (the exact text the caller computed — it alone
  // knows which workers were resumed or left parked, ADR 0023 amendment 3 decision 5), then every wake
  // still held, in order, each stamped `held_ms`, via the injected `writeStdinLine`/`wakeText`.
  function resume(by, line) {
    const rec = pauses[pauses.length - 1];
    const remaining_ms = rec ? rec.remaining_ms : null;
    // design item 5: both sides of this subtraction are the same run-relative basis (nowMs()), so the
    // duration comes out right whether pausedAt itself is wall clock or run-relative.
    const span_ms = pausedAt == null ? null : nowMs() - pausedAt;
    if (rec) rec.resumed_at_ms = nowMs();
    paused = false;
    pausedAt = null;
    pausedBy = null;
    if (remaining_ms != null) armTimeout(remaining_ms);
    const lineText = line || 'the operator has resumed this run.';
    // Fix round (finding 5): tracked exactly as a worker's own wake is (pushed to `state.wakes` and
    // handed to `writeStdinLine` as its own record), so the run result's `wakes` says whether the
    // substrate answered this write or it expired, rather than leaving it out entirely.
    const resumeRec = {
      at_ms: nowMs(), worker_id: null, event: 'resume_line',
      bytes: Buffer.byteLength(lineText, 'utf8'), orchestrator_idle_at_write: getIdle(),
      established_by: 'run resume',
    };
    pushWake(resumeRec);
    writeStdinLine(lineText, null, resumeRec);
    // Marked delivered rather than removed, so `wakesHeld` stays the full history across however many
    // pause/resume cycles this run has, for the final receipt's `wakes_held` (design item 2).
    const held = wakesHeld.filter((w) => !w.delivered);
    const delivered = [];
    for (const w of held) {
      w.delivered = true;
      const heldRec = { ...w, held_ms: nowMs() - w.held_at_ms };
      delete heldRec.held_at_ms; delete heldRec.delivered;
      writeStdinLine(wakeText(w), w.worker_id, heldRec);
      pushWake(heldRec);
      delivered.push(heldRec);
    }
    // design item 9 (amendment 3 decision 2): the resume receipt names the new deadline beside armed_ms.
    const timeout = remaining_ms == null ? null : { armed_ms: remaining_ms, new_deadline_at: Date.now() + remaining_ms };
    return { resumed_by: by, span_ms, held: delivered, line: lineText, timeout };
  }

  return {
    isPaused, pausedFacts, holdWake, onControlResponse, onTurnEnd, pause, resume,
    wakesHeld, pauses, armTimeout, clearTimeoutClock, getTimeoutRemaining,
  };
}

module.exports = { createRunHold, INTERRUPT_TIMEOUT_MS };
