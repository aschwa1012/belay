'use strict';
// late-handback.cjs — ADR 0026 amendment 2 (proposed): a hand-back that reaches the core after its holder died is accepted there
// (lease-holder-dead.cjs), but no turn of that worker will ever end, and a turn's end is what starts the evaluation at release
// (release-eval.cjs). So for a bounded window after a worker settles dead, the run manager's own pid poll looks once a tick for a
// hand-back of that worker that no evaluation has read, and starts it exactly as a turn's end would. A hand-back released just
// before the death, whose turn never ended either, is found the same way. One look in flight at a time; the window closes once one
// evaluation has started, or LATE_HANDBACK_MS after the death.

const RE = require('./release-eval.cjs');

const LATE_HANDBACK_MS = 10000; // ADR 0029: Claude Code ends its MCP server 300 to 400 ms after its stdin closes; a wide margin

function check(w, ctx, now = Date.now()) {
  if (!w.settled || w.settledState !== 'dead') return;
  if (!w.lateHandback || w.lateHandback.launches !== w.launches) w.lateHandback = { launches: w.launches, until: (w.exitedAt || now) + LATE_HANDBACK_MS, busy: false, done: false };
  const lh = w.lateHandback;
  if (lh.done || lh.busy) return;
  if (now > lh.until) { lh.done = true; return; }
  lh.busy = true;
  RE.notePending(w, ctx).then((ids) => {
    if (ids && w.lateHandback === lh && w.settled) { lh.done = true; RE.startRelease(w, ctx); }
  }, () => {}).finally(() => { lh.busy = false; });
}

module.exports = { check, LATE_HANDBACK_MS };
