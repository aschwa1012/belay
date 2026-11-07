'use strict';
// orchestrator-idle-close.cjs — the headless orchestrator's idle-close decision, moved out of orchestrator.cjs (its line budget). Once
// the orchestrator is idle: hold the close for a mid-turn worker, an unanswered write, a pending death, a parked or stopping worker,
// a release evaluation or a plan's step due or in flight; then write the steps no digest has shown (digest-wake.cjs); otherwise tell it once about the trees the close would keep (ADR 0065 amendment 1), then close its stdin.
// -> true when this pass closed the run (the caller returns without scheduling another poll).
const { isMidTurn } = require('./wake.cjs');

async function idleClose(c) {
  const { state, rows, runId, pending_deaths, turnAtCall, hold, awaitingWakeIds, callWatcher, recordHold, preClose, writeWake, closeThenKillOnDeadline, policyWatcher = null, flushDigest = null, stall = null } = c;
  // A plan's step due or in flight holds the close too (policy-close-hold.cjs): belay's own next step is not left to a closing run.
  const planHolds = policyWatcher ? (state.policyHold || (state.policyHold = require('./policy-close-hold.cjs').createPolicyCloseHold())).holds(policyWatcher.snapshot(), { exceptions: policyWatcher.active() }) : [];
  const busy = rows.filter((w) => w.run_id === runId && isMidTurn(w)).map((w) => w.id);
  const awaiting = awaitingWakeIds(); // also prunes state.pendingWrites of anything past its expiry
  const pendingIds = pending_deaths.map((p) => p.worker_id);
  // 6f design item 1: a `paused` row holds the close exactly as a mid-turn worker does.
  const parked = rows.filter((w) => w.run_id === runId && w.state === 'paused').map((w) => w.id);
  // 6f-2 design item 1 (blocking, orchestrator.cjs:308): a worker mid-park holds the close too. Its
  // row reads `stopping` with a live pid — not mid-turn (`busy`), not yet `paused` (`parked`), and
  // not a pending death (the pid is alive) — the one gap review 2 found. An ordinary idle `running`
  // or `starting` worker (pid alive, no turn owed) is deliberately NOT held here: the idle-close rule
  // ends the run regardless of a live, merely-idle worker process, by design.
  const live = rows.filter((w) => w.run_id === runId && w.state === 'stopping' && w.pid_alive === true).map((w) => w.id).concat(require('./release-eval.cjs').evaluatingHolds(state.evalSeen, rows, runId)).concat(callWatcher.holds()).concat(planHolds).concat([...((state.evalSeen && state.evalSeen.deathHeld) || new Map()).keys()].map((k) => `relaunch:${k}`)); // a builder's death a plan is relaunching (policy-relaunch.cjs) holds the close and the stall notice // ADR 0058: a release evaluation holds the close, and so does a detached integrate or task_evaluate
  // 6f design item 5: the resume line carries no worker id, so awaitingWakeIds() alone never named
  // it; an idle orchestrator right after resume could otherwise close under that very write before
  // the resumed turn starts. Any write still unanswered, worker-tagged or not, holds the close.
  if (hold.isPaused()) { // 6f design item 2: never closed by the idle rule while paused
    recordHold(turnAtCall, busy, awaiting, 'run paused', pendingIds, parked, live);
  } else if (busy.length === 0 && state.pendingWrites.length === 0 && pendingIds.length === 0 && parked.length === 0 && live.length === 0) {
    if (state.finishing) return true;
    const st = stall ? await stall.atClose(policyWatcher && policyWatcher.snapshot()) : null; if (state.finishing) return true; // ADR 0074 amendment 3: open tasks nobody is assigned are named once before the close; that write holds it until read
    if (st) { if (flushDigest) await flushDigest.write(st); else writeWake(st); return false; } // the steps no digest has shown ride it (digest-wake.cjs carry)
    const pre = await preClose.check({ isPaused: hold.isPaused }); if (state.finishing) return true; // once; never closes in the pass that read
    if (pre.wake && policyWatcher && policyWatcher.doneCurrent && policyWatcher.doneCurrent()) pre.wake = null; // the done wake was the last word and nothing moved: no extra turn for the trees the close keeps (the run receipt names them)
    if (pre.wake) { if (flushDigest) await flushDigest.write(pre.wake); else writeWake(pre.wake); } else if (!pre.ran && state.idle && !hold.isPaused()) {
      if (flushDigest && await flushDigest()) return false; // ADR 0074 amendment 2: steps no wake carried are written alone before the close; that write holds it until it is read
      if (state.finishing) return true;
      closeThenKillOnDeadline('orchestrator ended a turn with no worker mid-turn; stdin closed'); return true; }
  } else if (pendingIds.length) {
    const kept = rows.filter((w) => pendingIds.includes(w.id) && w.pid_dead_seen_at != null); // rows the dead-pid memory is holding dead (dead-pids.cjs)
    const by = kept.length ? `worker.list; pid dead (seen dead at ${kept.map((w) => `${w.id} ${w.pid_dead_seen_at}`).join(', ')} by ${[...new Set(kept.map((w) => w.pid_dead_by))].join(', ')}, and the number reads alive since: another process may hold it), awaiting the detector's row` : "worker.list; pid dead, awaiting the detector's row";
    recordHold(turnAtCall, busy, awaiting, by, pendingIds, parked, live);
  } else {
    recordHold(turnAtCall, busy, awaiting, 'worker.list', pendingIds, parked, live);
  }
  return false;
}

module.exports = { idleClose };
