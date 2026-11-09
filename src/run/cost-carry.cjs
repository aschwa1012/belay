'use strict';
// cost-carry.cjs — a worker row's cost across launches. Claude Code reports total_cost_usd for the session it is in. The model three live
// measurements fit (Claude Code 2.1.321, ADR 0068 amendment 1): the substrate saves the session total only at a GRACEFUL exit, a kill saves
// nothing, and a --resume starts from the last saved total (zero if none was ever saved). belay sees a graceful exit itself (exit code 0).
// So the worker keeps ONE number per session, `saved`: the process-reported total at the session's last graceful exit (0 until one happens;
// reset on a replace, a fresh session). It is the worker row's `cost_saved`, so an adopting adapter and a park resume have it.
// A new process's reports R are relative to `saved`: the row grows by R - saved, from the cost at its launch, so it never falls.
// Guard: a first report below `saved` means the model is wrong for this version; the process is then counted from zero (R whole) and the
// worker's lastError says so, so it is visible and never double counts silently. A graceful exit whose code belay did not see (a pid-poll
// settle) saves nothing here, so the next resume counts from the older total and the row can overcount by the difference.

const EPS = 1e-9;

// A fresh session (the replace branch): its total starts at zero and nothing is saved.
function fresh(w) { w.costBase = w.costUsd; w.costSaved = 0; w.costGraceful = false; }

// The process ended; a clean exit code means the substrate saved the total it had reported.
function noteExit(w) { w.costGraceful = w.exitCode === 0; }

// The saved total as the row records it: the exited process's own last report if it ended cleanly and reported, else the earlier figure.
function savedOf(w) {
  return w.costGraceful && w.costDecided === true ? Math.max(0, (w.costUsd || 0) - (w.costBase || 0)) : (w.costSaved || 0);
}

// At every launch.
function arm(w) {
  w.costSaved = savedOf(w); w.costGraceful = false;
  w.costRowAtLaunch = w.costUsd || 0;
  w.costDecided = false;
}

// -> the row's new cost for a reported session total.
function total(w, reported) {
  if (w.costDecided === false) {
    w.costDecided = true;
    const saved = w.costSaved || 0;
    if (reported < saved - EPS) {
      w.costBase = w.costRowAtLaunch;
      w.lastError = { where: 'cost', detail: `the first cost report ${reported} is below the total saved at the last graceful exit ${saved}; this process is counted from zero` };
    } else w.costBase = w.costRowAtLaunch - saved;
  }
  return (w.costBase || 0) + reported;
}

module.exports = { arm, total, fresh, noteExit, savedOf };
