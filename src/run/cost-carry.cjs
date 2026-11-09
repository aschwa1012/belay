'use strict';
// cost-carry.cjs — a worker row's cost across launches. Claude Code reports total_cost_usd for the session it is in. After a graceful exit a
// --resume carries the session total; after a kill it starts again at zero (measured on this host, see the ADR 0068 amendment). So a launch
// assumes neither: it remembers the previous session total, and the new process's FIRST cost report decides.
//   reported < previous total  -> the total did not carry: the base becomes the row's cost so far, and the row adds the new total to it.
//   reported >= previous total -> it carried: the base stays, and the row is base + that total.
// The row never goes down and, in either case, never counts a spend twice. One ambiguous case is accepted: a total that did not carry whose
// first report is already at or above the whole previous session total reads as carried, and the row then undercounts by at most that
// previous total (the new process alone had to spend more than the entire earlier session before its first report).

const EPS = 1e-9;

// At every launch: the previous session total is the row's cost less the base it was reported on top of.
function arm(w) {
  w.costPrior = Math.max(0, (w.costUsd || 0) - (w.costBase || 0));
  w.costRowAtLaunch = w.costUsd || 0;
  w.costDecided = false;
}

// -> the row's new cost for a reported session total.
function total(w, reported) {
  if (w.costDecided === false) {
    w.costDecided = true;
    if (reported < w.costPrior - EPS) w.costBase = w.costRowAtLaunch; // restarted from zero
  }
  return (w.costBase || 0) + reported;
}

module.exports = { arm, total };
