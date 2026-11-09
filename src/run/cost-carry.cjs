'use strict';
// cost-carry.cjs — a worker row's cost across launches. Claude Code reports total_cost_usd for the session it is in. Measured on this host
// (ADR 0068 amendment 1): after a graceful exit a --resume carries the session total; after a kill it starts again at zero; and after
// graceful stop, resume, KILL, resume the last process restored the total saved at the earlier GRACEFUL exit, not the killed process's.
// So a launch assumes none of these. It remembers the total each earlier process of the session ended on, and the new process's FIRST cost
// report R is read against them: its own spend is R less the largest remembered total not above R (zero when R is below all of them).
//   carried   (R at or above the last total)  -> the largest total not above R is the last one: the new spend is R less it.
//   restored  (R between an older total and the last) -> R less that older total.
//   restarted (R below every total)           -> R whole.
// The row grows by exactly that spend, so it never falls and, in each of the three, never counts the earlier spend twice. One case is
// accepted: a restarted total whose first report is already at or above some remembered total reads as restored or carried, and the row then
// undercounts by at most that total (the new process alone had to spend more than the earlier session had reported by then).

const EPS = 1e-9;

// A fresh session (the replace branch): its total starts at zero and the earlier totals no longer apply.
function fresh(w) { w.costBase = w.costUsd; w.costSeen = []; }

// At every launch: the previous process's last total is the row's cost less the base it was reported on top of.
function arm(w) {
  const last = Math.max(0, (w.costUsd || 0) - (w.costBase || 0));
  if (!Array.isArray(w.costSeen)) w.costSeen = [];
  if (last > EPS && !w.costSeen.some((t) => Math.abs(t - last) < EPS)) w.costSeen.push(last);
  w.costRowAtLaunch = w.costUsd || 0;
  w.costDecided = false;
}

// -> the row's new cost for a reported session total.
function total(w, reported) {
  if (w.costDecided === false) {
    w.costDecided = true;
    const below = (w.costSeen || []).filter((t) => t <= reported + EPS);
    w.costBase = w.costRowAtLaunch - (below.length ? Math.max(...below) : 0);
  }
  return (w.costBase || 0) + reported;
}

module.exports = { arm, total, fresh };
