'use strict';
// turn-wait.cjs — wait for a worker's current turn, answering at once for one that has already landed.
// A turn's waiters are resolved when its end is processed; a caller that starts waiting after that point (a
// fast turn, a slow host) would otherwise wait out its whole bound for a turn that already happened. The
// worker's launch and each message clear `turnEnded`, so a set flag is always the current turn's own.

const W = require('./worker.cjs');

// Resolves like W.waitTurn: a turn's facts, an exit's facts, or null at the bound. Decided synchronously, never
// after an await: draining the worker's queue first would hold the caller behind unrelated queued work (a
// harness /compact's), so the check and the registration share one tick. A turn whose end is parsed but still
// recording (`pendingTurnEnd` set) has not resolved its waiters yet, so a waiter registered now still gets it.
function waitTurnOrLanded(w, ms) {
  if (w.turnEnded && !w.pendingTurnEnd) {
    return Promise.resolve({ usage: w.lastTurnUsage, checkpoint_id: w.lastCheckpointId, paused: !!w.parkRequested, already: true });
  }
  if (w.settled && !w.pendingTurnEnd) return Promise.resolve({ exited: true, exit_code: w.exitCode, exit_signal: w.exitSignal, already: true });
  return W.waitTurn(w, ms);
}

module.exports = { waitTurnOrLanded };
