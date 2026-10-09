'use strict';
// exit.cjs — build step 6f-2, design items 6 and 9. Split
// out of worker.cjs (to keep it under its own line budget): a worker's death — the terminal state word,
// the settled-state fix a later stop makes, and settle()'s own resolution of the exit/turn/ready waiters —
// kept together because all three reason about the very same moment.

const now = () => Date.now();

// The state settle() writes for a dead worker, computed from derived facts already on the record
// (whether a stop was asked for, the substrate, whether a turn had already ended, the exit code) —
// never from `w.state`, which `writeRow` sets only once the store confirms the write (manager.cjs
// `writeRow`'s comment) and can still be unset when the caller needs the answer now. Called exactly
// once, the first time a worker settles here; `settle` caches the answer on `w.settledState` because
// `stopRequested` and `exitCode` both keep moving afterwards (a late stop, a second death channel's
// fill-in) and recomputing from them later would answer a question about now, not about the death.
function terminalState(w) {
  // build step 6e-4: checked before stopRequested — a park's own doStop call sets that too, but its row
  // is `paused`, never `stopped`.
  if (w.parkRequested) return 'paused';
  return w.stopRequested ? 'stopped' : w.substrate === 'codex' && w.turnEnded && w.exitCode === 0 ? 'idle' : 'dead';
}

// 6e-5 item 2 (review 2, wait.cjs:32): manager.cjs's `stop` turns a parked worker's row 'stopped', but
// settle() fixed `w.settledState` 'paused' at the park's own exit and never revisits it — fixed here so
// `wait` (settledOf, wait.cjs) stops answering 'paused'. Any other state is left exactly as settle() fixed it.
function noteStoppedWhileSettled(w) {
  if (w.settledState === 'paused') {
    w.deathEstablishedBy = `${w.deathEstablishedBy}; stopped by an explicit stop while parked`;
    w.settledState = 'stopped';
  }
}

// design item 6 (worker.cjs:318, 6e-6 review 1 finding 3 and review 2 should-fix): a turn still in the
// pipe beats the exit. Resolves the exit/turn waiters as `exited`, unless a turn_end is still owed.
function resolveExitedWaiters(w, code, signal, establishedBy) {
  if (!w.pendingTurnEnd) {
    for (const r of w.turnWaiters.splice(0)) r({ exited: true, exit_code: code, exit_signal: signal, established_by: establishedBy });
  }
}

// design item 6: bounds the wait for the child's own 'close' event (fired once its stdio streams have
// ended, so any turn_end already in stdout has been parsed and onTurnEnd queued by then) for a child
// whose stdio never closes.
const EXIT_CLOSE_BOUND_MS = 2000;

// Liveness is derived, never self-reported (invariant 4): this is the exit-event half, and the
// manager's 1,000 ms pid poll is the other. Whichever gets there first calls settle().
function settle(w, code, signal, establishedBy, ctx) {
  // Death can be established by a pid check before the child `exit` event delivers the exit code,
  // and a row that says dead with no code is a weaker receipt than the one the OS is about to
  // offer. So a later channel that does carry a code fills in what the earlier one could not know,
  // names both channels, and rewrites the row (invariant 4: each rung names what established it).
  if (w.settled) {
    if (w.exitCode == null && w.exitSignal == null && (code != null || signal != null)) {
      w.exitCode = code;
      w.exitSignal = signal;
      w.deathEstablishedBy = w.deathEstablishedBy + '+' + establishedBy;
      // Fix round, should-fix finding: `w.settledState`, fixed at the first settle() call, not `w.state`
      // (which a queued write behind this one can still leave 'stopping'/'paused' racing settle's own).
      const state = w.settledState;
      w.queue = w.queue.then(() => ctx.writeRow(w, state)).catch((e) => {
        w.lastError = { where: 'worker.write/exit-code', code: e && e.code, message: e && e.message };
      });
    }
    return;
  }
  // A death the pid poll saw first and held for this event happened then, not now.
  w.exitedAt = w.pidGoneAt != null && w.pidGonePid === w.pid ? w.pidGoneAt : now();
  w.exitCode = code;
  w.exitSignal = signal;
  w.settled = true;
  const child = w.child; // captured before clearing: the deferred close listener below still needs it
  // fix round (verifier failure 1, manager.test.cjs regression): named so worker.cjs's own exit handler
  // can still recognise this same child's later 'exit' event as this record's once `w.child` reads null
  // below — otherwise a pid-poll settle here (code/signal still unknown) leaves no channel able to fill
  // the real exit code in when the OS event for this same, single child finally arrives.
  w.settledChild = child;
  w.child = null;
  w.deathEstablishedBy = establishedBy;
  const state = terminalState(w);
  w.settledState = state; // fixed now; the fill-in branch above must not recompute or move this
  // design item 6, widened by build step 6i design item 7b (C11): any channel that finds the child still
  // attached races a turn still in the pipe — pid-poll settles a live-pid-gone record whose 'exit' event
  // has not fired yet, exactly the same race an exit-event can lose to a late-arriving result. Only an
  // adopted record (no live child either way) resolves at once, exactly as before.
  if (child) {
    let done = false;
    // build step 6i-2 design item 5 (R6): a relaunch since this exact settle invalidates this wait —
    // `w.settledChild` (set to `child` just above, reset to null by worker.cjs's `attach` on the next
    // launch) names the launch this close-wait was armed for; a record no test ever relaunches keeps it
    // unchanged, so this resolves exactly as before.
    const stillCurrent = () => w.settledChild === child;
    const timer = setTimeout(() => { if (!done) { done = true; if (stillCurrent()) resolveExitedWaiters(w, code, signal, establishedBy); } }, EXIT_CLOSE_BOUND_MS);
    if (timer.unref) timer.unref();
    child.once('close', () => { if (done) return; done = true; clearTimeout(timer); if (stillCurrent()) resolveExitedWaiters(w, code, signal, establishedBy); });
  } else {
    resolveExitedWaiters(w, code, signal, establishedBy);
  }
  for (const r of w.exitWaiters.splice(0)) r({ code, signal, at: w.exitedAt, established_by: establishedBy });
  for (const r of w.readyWaiters.splice(0)) r(null);
  w.queue = w.queue.then(() => ctx.writeRow(w, state)).catch((e) => {
    w.lastError = { where: 'worker.write/exit', code: e && e.code, message: e && e.message };
  });
}

// 6i-2 fix round (item 5, the bound-timer half): exported so its own test (h15b, park-6.test.cjs) waits
// the real bound rather than a hand-copied guess of it.
module.exports = { terminalState, noteStoppedWhileSettled, settle, EXIT_CLOSE_BOUND_MS };
