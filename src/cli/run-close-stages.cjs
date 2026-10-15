'use strict';
// run-close-stages.cjs — `belay run`'s call to the run-close stages (the Haiku scrubber, then the Opus archive reviewer). The workers
// are closed and run.end has not been written: the run process still owns the store, so the stages' reads and applies are in-process
// calls on its harness view (ADR 0044 decision 6). With notes off this loads nothing. A failure is never the run's failure: each
// stage records its own receipt and the exit code does not change.

const RI = require('./run-interactive.cjs');

const REAP_WAIT_MS = 1500;
// The exact-pid kill of ADR 0039: the worker row's creation time and image are the identity, and a pid they do not match is refused.
async function defaultKill(core, rec) {
  const PR = require('../core/process.cjs');
  let row = null;
  try { const got = await core.worker.get({ worker_id: rec.worker_id }); row = got && (got.worker || got); } catch { row = null; }
  return PR.killProcess(PR.rowTarget(row && row.pid === rec.pid ? row : { pid: rec.pid, pid_created: null }));
}
// After a cut: every child recorded at spawn that is still alive is killed by its exact pid; any that is still alive after that is named.
async function reap(core, sink, kill) {
  const { pidAlive } = require('../core/lock.cjs');
  const { waitPidGone } = require('../core/process.cjs');
  for (const rec of sink.pids) {
    if (sink.survivors.includes(rec.pid) || !pidAlive(rec.pid)) continue;
    try { await kill(core, rec); } catch { /* the pid check below decides */ }
    if (pidAlive(rec.pid) && (await waitPidGone(rec.pid, { timeoutMs: REAP_WAIT_MS })) === null) sink.survivors.push(rec.pid);
  }
}

// `levers` is the parsed spec's lever block (`memory_levers` present only when it differs from the defaults).
async function runCloseStages({ core, runId, levers, dataDir, worktree = null, goal = null, summary = null, ce = null, late = () => {}, stages = null, deps = {}, log = null, interrupted = null, killPid = null }) {
  const lv = levers && levers.memory_levers;
  if (!lv || !lv.notes) return null;
  const S = stages || require('../run/close-stages.cjs');
  // `fast`: a console closing (SIGHUP) or Ctrl-C (`interrupted`, set by cmd-run's SIGINT and SIGBREAK listener). Either way no stage spawns and a
  // running child is killed by its exact pid. `sink` keeps the pids of children that survived their kill, even when the stage is cut off.
  const sink = { survivors: [], pids: [] };
  const fast = () => !!((ce && ce.hupSeen()) || (interrupted && interrupted()));
  const out = await RI.within(ce, S.closeStages({ core: core.harness ? core.harness() : core, runId, levers: lv, dataDir, worktree, goal, summary, fast, log, sink, ...deps }), 'the run-close stages', { cut: true }, late, RI.END_RESERVE_MS);
  if (out && out.cut) await reap(core, sink, killPid || defaultKill); // a cut stage's children are found by the pids recorded at spawn
  return sink.survivors.length && out && out.cut ? { ...out, survivors: sink.survivors } : out;
}

module.exports = { runCloseStages };
