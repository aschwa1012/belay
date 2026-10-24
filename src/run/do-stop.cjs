'use strict';
// do-stop.cjs — the stop sequence of one worker (graceful close of stdin, then the subtree and the exact pid,
// ADR 0011 section 2 and ADR 0039), moved verbatim out of manager.cjs to keep that file under its line budget.
// `stop`, `doRestart` and pause's park all reach it through the manager.

const P = require('./process.cjs');
const PI = require('./pid-identity.cjs'); // ADR 0039
const W = require('./worker.cjs');

const now = () => Date.now();

function createDoStop({ ctx, writeRow }) {
  return async function doStop(w, mode, timeout_ms, { skipRowWrite = false, treatPidAsDead = false } = {}) {
    const worker_id = w.id;
    const t0 = now();
    const pid = w.pid;
    w.stopRequested = true;
    w.stopCalls = (w.stopCalls || 0) + 1; // launchBound compares this across its bind await: a launch a stop overtook is abandoned
    // Already gone, or a parked worker's dead-by-construction pid, never re-checked (fix round #2, :351). A record with no process
    // by construction (a settled death, an adopted terminal row) is gone whatever its pid number answers now: that pid may be reused.
    if (!pid || treatPidAsDead || PI.noProcess(w) || !P.pidAlive(pid)) {
      const stateBefore = w.state;
      W.settleHeld(w, ctx, 'pid-check-on-stop'); await w.queue; // a death the poll still holds settles now
      const state = W.terminalState(w);
      // Fix round: `paused` dropped here. 6e-5: `skipRowWrite` (a stale record) writes nothing over it.
      if (!skipRowWrite && !['stopped', 'dead', 'idle'].includes(w.state)) await writeRow(w, state);
      return { worker_id, pid, exit_code: w.exitCode, exit_signal: w.exitSignal, ms_to_exit: 0, graceful: false, killed: false, session_id: w.sessionId, stale: skipRowWrite || undefined,
        // B9: nothing was stopped, because the process was already gone (a parked worker has no process by design, so it is not this).
        ...(treatPidAsDead ? {} : { already_exited: true, state_before: stateBefore, note: `worker ${worker_id} had already exited${!pid ? ' (it has no process)' : P.pidAlive(pid) ? ` (its process ended; pid ${pid} now belongs to another process)` : ` (pid ${pid} is not running)`}; nothing was stopped` }) };
    }
    // Fix round (6f-2): pause.cjs's own step 1b already wrote this row `stopping` — never repeated here.
    if (w.state !== 'stopping') await writeRow(w, 'stopping');
    let graceful = false;
    let killed = false; let refused = null; let notKilled = null;
    // Closing stdin needs a stdin: an adopted worker's pipes belong to the adapter that spawned it,
    // so there is nothing to close and the kill is the only channel left.
    if (mode === 'graceful' && w.substrate === 'claude-code' && w.child) {
      graceful = (await P.gracefulStop(w.child, timeout_ms)).graceful;
    }
    if (!graceful) {
      // The subtree first, then the exact pid as the backstop that produces the exit event (ADR 0011 §2).
      const kr = await PI.killWorker(w); // ADR 0039: `killed` is what the kill did, never what was attempted
      w.treeKill = kr.tree; refused = kr.refused; notKilled = kr.descendants_not_killed; killed = !refused;
      if (w.child) await W.waitExit(w, Math.max(2000, Math.min(timeout_ms, 10000)));
      else await P.waitPidGone(pid, { timeoutMs: Math.max(2000, Math.min(timeout_ms, 10000)) });
    }
    if (w.child) await W.waitExit(w, 5000);
    await w.queue;
    // No child means no exit event, so nothing else will write this row: same fix as the finding above.
    // A refusal that proved nothing leaves the process possibly running: no terminal row then (a 'mismatch' or an
    // 'absent' proves the worker is not at that pid, so its terminal row is true).
    const maybeLive = refused && refused.kind === 'unverifiable' && P.pidAlive(pid);
    if (!w.child && !maybeLive && w.state !== W.terminalState(w)) await writeRow(w, W.terminalState(w));
    return {
      worker_id, pid, exit_code: w.exitCode, exit_signal: w.exitSignal,
      ms_to_exit: Math.max(0, (w.exitedAt || now()) - t0), graceful, killed, session_id: w.sessionId, // 0 when the exit came before the stop (an adopted row's old exited_at)
      tree_kill: w.treeKill || null, ...(refused ? { refused: refused.refused, kind: refused.kind, detail: refused.detail } : {}), ...(notKilled ? { descendants_not_killed: notKilled } : {}),
    };
  };
}

module.exports = { createDoStop };
