'use strict';
// cost-carry.cjs — a worker row's cost across launches. Claude Code reports total_cost_usd for the session it is in. The model three live
// measurements fit (Claude Code 2.1.321, ADR 0068 amendment 1): the substrate saves the session total only at a GRACEFUL exit, a kill saves
// nothing, and a --resume starts from the last saved total (zero if none was ever saved). belay sees a graceful exit itself (exit code 0).
// So the worker keeps ONE number per session, `saved`: the process-reported total at the session's last graceful exit (0 until one happens;
// reset on a replace, a fresh session). It is the worker row's `cost_saved`, so an adopting adapter and a park resume have it.
// A new process's reports R are relative to `saved`: the row grows by R - saved, from the cost at its launch, so it never falls.
// Guard: a first report below `saved` means the model is wrong for this version; the process is then counted from zero (R whole) and the
// worker's lastError says so, so it is visible and never double counts silently.
// Unknown exit: when an adapter dies its workers see stdin close and exit cleanly (saving the total), but the adopting adapter finds only a
// dead pid. If the previous process's exit code is unknown, it had reported a cost, and no operator kill mark names it, the next process's first
// report R starts from the larger of `saved` and that process's last total, when that total is not above R. Exact when it did exit cleanly; if it
// was in fact killed this can only undercount, by at most the gap between the two.

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
function arm(w, dataDir) {
  w.costSaved = savedOf(w);
  const last = Math.max(0, (w.costUsd || 0) - (w.costBase || 0));
  const unknownExit = w.exitCode == null && w.exitSignal == null && last > w.costSaved + EPS && !(dataDir && w.id && require('../core/kill-mark.cjs').isKilledLoose(dataDir, w.id, w.pid, w.pidCreated));
  w.costUnknown = unknownExit ? last : null;
  w.costGraceful = false;
  w.costRowAtLaunch = w.costUsd || 0;
  w.costDecided = false;
}

// -> the row's new cost for a reported session total.
function total(w, reported) {
  if (w.costDecided === false) {
    w.costDecided = true;
    const saved0 = w.costSaved || 0;
    const saved = w.costUnknown != null && w.costUnknown <= reported + EPS ? w.costUnknown : saved0; // see the unknown-exit note above
    if (reported < saved0 - EPS) {
      w.costBase = w.costRowAtLaunch;
      w.lastError = { where: 'cost', detail: `the first cost report ${reported} is below the total saved at the last graceful exit ${saved0}; this process is counted from zero` };
    } else w.costBase = w.costRowAtLaunch - saved;
  }
  return (w.costBase || 0) + reported;
}

module.exports = { arm, total, fresh, noteExit, savedOf };
