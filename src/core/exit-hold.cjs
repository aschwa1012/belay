'use strict';
// The bounds of the pid-poll death hold, in one place so every wait that sits behind the hold derives from them.

// The manager's pid poll interval (manager.cjs).
const POLL_MS = 1000;

// How long a pid check that finds the child gone holds the death (and so its wake) for the child's own 'exit'
// event, the only channel with the exit code. The event trailed the pid check by up to 4.7 s under CPU
// saturation (receipts/w2-flakes/exit-lag-32.txt); 6 s is that plus a quarter. Past it the death settles as
// before: null code, established by the pid check, so liveness never hangs.
const POLL_EXIT_HOLD_MS = 6000;

// From the child's death to a terminal row in the store: the hold, one poll tick to notice it, and a write margin.
const DEATH_LAND_MS = POLL_EXIT_HOLD_MS + POLL_MS + 1000;

// 5b-4: how long `belay run` holds the idle close on a non-terminal row whose pid it finds dead. It must outlast
// the detector's landing, hold included, or the death is never announced; the old 1,500 ms was sized for a detector
// that took at most one poll.
// Only a live adapter can still write the row, so a row whose adapter_pid is dead (planted, orphaned) gets the
// short grace of a detector that never comes: one poll plus margin.
const DEATH_GRACE_MS = DEATH_LAND_MS;
const ORPHAN_GRACE_MS = 1500;

// BELAY_POLL_EXIT_HOLD_MS lowers the bound for tests; clamped to [0, POLL_EXIT_HOLD_MS].
function holdBoundMs() {
  const env = process.env.BELAY_POLL_EXIT_HOLD_MS;
  if (env === undefined || env === '' || !Number.isFinite(Number(env))) return POLL_EXIT_HOLD_MS;
  return Math.min(POLL_EXIT_HOLD_MS, Math.max(0, Number(env)));
}

module.exports = { POLL_MS, POLL_EXIT_HOLD_MS, DEATH_LAND_MS, DEATH_GRACE_MS, ORPHAN_GRACE_MS, holdBoundMs };
