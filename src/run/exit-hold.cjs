'use strict';
// The pid-poll death hold's behaviour; its bounds are src/core/exit-hold.cjs (outside src/run so the CLI can read them).

const K = require('../core/exit-hold.cjs');
const { POLL_EXIT_HOLD_MS, holdBoundMs } = K;
const { pidAlive } = require('./process.cjs');
const EX = require('./exit.cjs');

// True while the death of a record whose child is still attached should wait for the exit event (the exit
// handler settles it first, 'exit-event', if it arrives). The first check of a pid starts the clock; a
// relaunch's new pid restarts it. An adopted record (no child) has no event coming, and a record not yet ready
// is failNoReady's (its own bounded wait), so neither is held. The bound is exit-hold.cjs's.
function holdForExitEvent(w) {
  if (!w.child || !w.readyAt) return false;
  if (w.pidGoneAt == null || w.pidGonePid !== w.pid) { w.pidGoneAt = Date.now(); w.pidGonePid = w.pid; }
  return Date.now() - w.pidGoneAt < holdBoundMs();
}

// Settles a held death at once (pid gone, exit event pending) for a caller that cannot wait on the hold: stop, restart.
function settleHeld(w, ctx, label) {
  if (!w.child || w.settled || !w.pid || pidAlive(w.pid)) return false;
  EX.settle(w, w.exitCode, w.exitSignal, label, ctx);
  return true;
}

module.exports = { ...K, holdForExitEvent, settleHeld };
