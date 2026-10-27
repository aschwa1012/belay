'use strict';
// run-trees.cjs — the run's close removes the task trees it can prove finished (ADR 0065). One core call after run.end and the
// run-end memory jobs: task.worktreeSweep, the operator's only. This module decides whether to make it (a fast close, Ctrl-C and a
// failed run.end skip it), names the workers the close could not prove ended so their trees stay, and shapes the receipt. It
// removes nothing itself and never changes the run's exit code.

const RI = require('./run-interactive.cjs');

const CUT = Symbol('cut');
const empty = (skipped) => ({ removed: [], kept: [], failed: [], orphans: [], integration_kept: [], skipped, ms: 0 });

// Worker ids the close did not prove ended: still alive after the kill, or a kill whose outcome is not `closed`.
function unprovenWorkers(closed) {
  if (!closed) return [];
  const ids = new Set((closed.still_alive || []).map((w) => w.worker_id));
  for (const k of closed.killed || []) if (k.outcome && k.outcome !== 'closed') ids.add(k.worker_id);
  return [...ids];
}

// Returns the `worktrees_closed` block. `endedRow` is run.end's answer (null when it failed); `ce` the console (interactive)
// or null; `late(message)` is told when the fast close cut the sweep.
async function closeTrees({ core, runId, endedRow, closed, ce, late, deps = {} }) {
  if (!endedRow || endedRow.ended_at == null) return empty('run_end_failed');
  const fast = RI.fastOf(ce);
  if (fast && fast.requested()) return empty('fast_close');
  let interrupted = false, wake = null;
  const stop = new Promise((r) => { wake = r; });
  const onInterrupt = () => { interrupted = true; wake(); };
  for (const sig of ['SIGINT', 'SIGBREAK']) process.on(sig, onInterrupt);
  try {
    const call = Promise.resolve().then(() => (deps.sweep || ((a) => core.task.worktreeSweep(a)))({ run_id: runId, unproven_workers: unprovenWorkers(closed) }));
    // A cut sweep exits no sooner than its call settles: the owner's store closes after this returns, and a removal still running
    // would finish its git and then fail to record it. The call stops before its next tree once told to, so the wait is at most one
    // tree's git. The fast close's late-message is not chained here: a cut sweep is named in `skipped`, never in the exit code.
    const done = RI.within(ce, call, 'the task-tree sweep', CUT, () => {});
    const got = await Promise.race([done, stop.then(() => CUT)]);
    if (got === CUT || interrupted) {
      const why = interrupted ? 'interrupted' : 'fast_close';
      try { await Promise.resolve().then(() => (deps.cancel || ((a) => core.task.worktreeSweepCancel(a)))({ run_id: runId })); } catch { /* the call below still settles */ }
      const settled = await call.catch(() => null);
      return settled ? { ...settled, skipped: why } : empty(why);
    }
    return got;
  } catch (e) {
    return { ...empty(null), error: (e && e.message) || String(e) };
  } finally { for (const sig of ['SIGINT', 'SIGBREAK']) process.off(sig, onInterrupt); }
}

// The text receipt's lines: one summary, one per failure, one per orphan. Nothing when the sweep did not run or had nothing.
function lines(receipt) {
  const w = receipt.worktrees_closed;
  if (!w) return [];
  if (w.skipped && w.skipped !== 'budget' && !w.removed.length) return [`worktrees: not swept (${w.skipped})`];
  if (w.error) return [`worktrees: sweep failed (${w.error})`];
  if (!w.removed.length && !w.kept.length && !w.failed.length && !w.orphans.length) return [];
  return [`worktrees: removed ${w.removed.length}, kept ${w.kept.length}, failed ${w.failed.length}`,
    ...w.failed.map((f) => `worktree not removed: ${f.path} (${f.code}: ${f.error})`),
    ...w.orphans.map((o) => `worktree recorded by no row: ${o.path} (${o.branch})`)];
}

module.exports = { closeTrees, lines, unprovenWorkers };
