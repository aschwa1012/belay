'use strict';
// run-close-stages.cjs — `belay run`'s call to the run-close stages (the Haiku scrubber, then the Opus archive reviewer). The workers
// are closed and run.end has not been written: the run process still owns the store, so the stages' reads and applies are in-process
// calls on its harness view (ADR 0044 decision 6). With notes off this loads nothing. A failure is never the run's failure: each
// stage records its own receipt and the exit code does not change.

const RI = require('./run-interactive.cjs');

const REAP_WAIT_MS = 1500; // the longest a reap waits for the pids to go when no close budget applies
const REAP_MIN_MS = 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The exact-pid kills of ADR 0039, all from ONE process snapshot (killMany): each recorded child's worker row gives its creation time and
// image, and a pid they do not match is refused. Under a console close the snapshot is the one the SIGHUP started.
async function defaultKill(core, recs, ce) {
  const PR = require('../core/process.cjs');
  const targets = await Promise.all(recs.map(async (rec) => {
    let row = null;
    try { const got = await core.worker.get({ worker_id: rec.worker_id }); row = got && (got.worker || got); } catch { row = null; }
    return PR.rowTarget(row && row.pid === rec.pid ? row : { pid: rec.pid, pid_created: null });
  }));
  return PR.killMany(targets, ce && ce.snapshot ? { snapshot: () => ce.snapshot(0) } : {});
}
// After a cut: every child recorded at spawn that is still alive is killed by its exact pid, in one batch, and any still alive when the time
// is up is named. The time is what the fast close has left once its stages are cut, less the owner shutdown's reserve (run.end and the
// shutdown must not start late); with no console budget (a Ctrl-C in a headless run) it is a few seconds. It never waits past that.
async function reap(core, sink, kill, ce) {
  const { pidAlive } = require('../core/lock.cjs');
  const live = sink.pids.filter((r) => !sink.survivors.includes(r.pid) && pidAlive(r.pid));
  if (!live.length) return;
  const budget = ce && ce.leftMs ? Math.min(REAP_WAIT_MS, Math.max(REAP_MIN_MS, ce.leftMs(RI.SHUTDOWN_RESERVE_MS))) : REAP_WAIT_MS;
  const t0 = Date.now();
  const work = (async () => {
    try { await kill(core, live, ce); } catch { /* the pid checks below decide */ }
    while (live.some((r) => pidAlive(r.pid)) && Date.now() - t0 < budget) await sleep(25);
  })();
  await Promise.race([work, sleep(budget)]);
  for (const r of live) if (pidAlive(r.pid)) sink.survivors.push(r.pid);
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
  // A cut leaves the stage running behind it. Its core is gated: once the cut is declared, nothing the stage has not yet sent reaches
  // the store, so no receipt or apply can be written after the owner's shutdown (it would elect a stray owner). A child's exit
  // fill-in and the stage's own receipts are among the refused.
  const gate = { aborted: false };
  const gated = require('../run/gated-core.cjs').gatedCore(core.harness ? core.harness() : core, gate, 'the run-close stage');
  const cutLate = (m) => { gate.aborted = true; late(m); };
  const out = await RI.within(ce, S.closeStages({ core: gated, runId, levers: lv, dataDir, worktree, goal, summary, fast, log, sink, ...deps }), 'the run-close stages', { cut: true }, cutLate, RI.END_RESERVE_MS);
  if (out && out.cut) await reap(core, sink, killPid || defaultKill, ce); // a cut stage's children are found by the pids recorded at spawn
  return sink.survivors.length && out && out.cut ? { ...out, survivors: sink.survivors } : out;
}

module.exports = { runCloseStages };
