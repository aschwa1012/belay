'use strict';
// Process primitives. Build step 6b moved the kill mechanics (IS_WINDOWS, assertPid, killPid, killTree,
// childPids, waitPidGone) to src/core/process.cjs, verbatim, so the CLI can kill without importing
// src/run; this file re-exports them under the same names, unchanged for every caller here, beside the
// three helpers that stay run-only: pidAlive, spawnWorker, gracefulStop.

const { spawn } = require('node:child_process');
const coreProcess = require('../core/process.cjs');

const { IS_WINDOWS, assertPid, killPid, killTree, killProcess, rowTarget, createdOf, processSnapshot, descendantTargets, killMany, childPids, waitPidGone } = coreProcess;

// A pid is alive if signal 0 lands. EPERM means the process exists and belongs to someone else, so
// it counts as alive; ESRCH is the only "gone".
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

// Spawn a worker. stdin is a pipe for Claude Code (the control channel, ADR 0008 §1) and ignored
// for Codex (one process per turn, prompt in argv).
function spawnWorker({ exe, args, cwd, env, stdin = 'pipe' }) {
  const child = spawn(exe, args, {
    cwd,
    env,
    stdio: [stdin, 'pipe', 'pipe'],
    windowsHide: true,
  });
  return child;
}

// Graceful stop of a stream-json Claude Code worker is closing its stdin (ADR 0001 §5, exit < 1 s).
// Resolves with how it ended so the caller can report `graceful` honestly.
function gracefulStop(child, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => finish({ graceful: false, timed_out: true, ms: Date.now() - t0 }), timeoutMs);
    child.once('exit', (code, signal) =>
      finish({ graceful: true, timed_out: false, ms: Date.now() - t0, exit_code: code, exit_signal: signal })
    );
    try {
      if (child.stdin && !child.stdin.destroyed) child.stdin.end();
    } catch {
      /* already gone; the exit event or the timeout answers */
    }
  });
}

module.exports = {
  IS_WINDOWS,
  pidAlive,
  assertPid,
  killPid,
  killTree,
  killProcess,
  descendantTargets,
  killMany,
  rowTarget,
  createdOf,
  processSnapshot,
  childPids,
  spawnWorker,
  gracefulStop,
  waitPidGone,
  withKillLock: coreProcess.withKillLock, // ADR 0039 review: belay stop's worker kills and the run's worker close share it
  lastSignalAt: coreProcess.lastSignalAt,
};
