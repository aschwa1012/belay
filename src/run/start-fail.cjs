'use strict';
// start-fail.cjs — how a start that does not reach `running` ends (contract §5, ADR 0045 decision 2). A process launched under a bind
// holds a key as long as it lives, so every way out of the startup transaction (a startup window that passes, a ready check that
// refuses, a row write that rejects) ends in the same place: the bind revoked, the child ended by its exact identity, a `dead` row.
// `guarded(w, fn)` runs the transaction after the launch; whatever it throws, the launch is settled before the error is handed back.

const { fail } = require('./errors.cjs');
const PI = require('./pid-identity.cjs');
const W = require('./worker.cjs');
const BL = require('./bind-launch.cjs');

// The launch guard has refused this worker (native-memory.cjs sets the flag before it throws).
const refusedByGuard = (w, e) => !!(w && w.nativeMemoryRefused) || !!(e && e.code === 'E_NATIVE_MEMORY_MISMATCH');

function createStartFail({ core, writeRow }) {
  // Revoke the bind before the kill, end the child, wait for the exit, write the `dead` row. `quiet`: the caller is already failing
  // with its own error, so a step that throws here is not allowed to replace it. -> the bind's { bind_id, revoked }.
  // `park`: a resume whose launch failed before any row moved (the worker still reads `paused`) goes back to parked, not dead: the
  // child's exit then writes the `paused` row (exit.cjs terminalState), and a retried resume finds the worker as the pause left it.
  // A launch REFUSED by the launch guard (native memory: a folder, a settings.json that disagrees) is a standing condition, not a
  // transient failure: it settles `dead` (native-memory.cjs refuseLaunch), so worker_wait answers dead, and never parks, whatever else
  // the caller asked for. Only a start that failed for want of luck (a row write, a ready window) goes back to parked.
  async function abortStart(w, { quiet = false, exitCode = false, park = false, cause = null } = {}) {
    const step = async (fn) => { if (!quiet) return fn(); try { return await fn(); } catch { return undefined; } };
    w.launchFailed = true; // a turn end mid-teardown must not write a `running` row for a start that failed
    if (park && refusedByGuard(w, cause)) park = false;
    if (park) { // back to the park this resume started from, its own facts kept: every reader of a park expects { at, by }
      const p = w.resumingFrom || { at: null, by: null };
      w.parkRequested = { at: p.at, by: p.by, resultsSeen: [], startFailed: true };
      w.paused = w.resumingFrom || null;
    }
    const bind = await BL.revokeBind(core, w);
    if (!w.settled && w.pid) {
      await step(async () => { w.treeKill = (await PI.killWorker(w)).tree; await W.waitExit(w, 5000); });
    }
    // The exit code is the most useful field the failure carries, and a pid check can establish the death before the exit event
    // delivers one (by seconds under load). Wait, bounded, for it.
    if (exitCode && W.deathByPidCheck(w)) await W.awaitExitCode(w, W.EXIT_CODE_WAIT_MS);
    await step(() => w.queue);
    if (w.state !== 'dead' && !park) await step(() => writeRow(w, 'dead'));
    return bind;
  }

  // The one shape a failed start takes: E_NO_READY { pid, exit_code, stderr_tail, reason }. Nothing rejects before the worker is
  // settled and its `dead` row is written (invariant 5).
  async function failNoReady(w, reason, extra = {}) {
    const bind = await abortStart(w, { exitCode: true });
    fail('E_NO_READY', reason, {
      worker_id: w.id, pid: w.pid, exit_code: w.exitCode, exit_signal: w.exitSignal,
      stderr_tail: w.stderr.slice(-2000), reason, spawn_error: w.spawnError,
      death_established_by: w.deathEstablishedBy, bind_id: bind.bind_id, bind_revoked: bind.revoked, ...extra,
    });
  }

  async function guarded(w, fn, { parkOnFailure = false } = {}) {
    const wasParked = parkOnFailure && w.state === 'paused'; // read before the transaction moves the state
    try { return await fn(); }
    catch (e) {
      if (!(e && e.code === 'E_NO_READY' && e.detail && e.detail.worker_id === w.id)) await abortStart(w, { quiet: true, park: wasParked && w.state === 'paused', cause: e }); // failNoReady has settled its own
      throw e;
    }
  }

  return { failNoReady, abortStart, guarded };
}

module.exports = { createStartFail };
