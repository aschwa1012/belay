'use strict';
// turn-wait.cjs — wait for a worker's current turn, answering at once for one that has already landed.
// A turn's waiters are resolved when its end is processed; a caller that starts waiting after that point (a
// fast turn, a slow host) would otherwise wait out its whole bound for a turn that already happened. The
// worker's launch and each message clear `turnEnded`, so a set flag is always the current turn's own.

const W = require('./worker.cjs');

// Resolves like W.waitTurn: a turn's facts, an exit's facts, or null at the bound. The queue is drained first
// so a turn end already parsed has finished recording; the check and the registration then share one tick.
async function waitTurnOrLanded(w, ms) {
  await w.queue;
  if (w.turnEnded) return { usage: w.lastTurnUsage, checkpoint_id: w.lastCheckpointId, paused: !!w.parkRequested, already: true };
  if (w.settled) return { exited: true, exit_code: w.exitCode, exit_signal: w.exitSignal, already: true };
  return W.waitTurn(w, ms);
}

module.exports = { waitTurnOrLanded };
