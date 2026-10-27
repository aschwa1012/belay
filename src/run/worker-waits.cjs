'use strict';
// worker-waits.cjs — the waits on a worker record (its ready event, its next turn, its exit) and the bounded wait for an exit code
// a pid check got ahead of. Moved verbatim out of worker.cjs to keep that file under its line budget; worker.cjs re-exports them.

// How long a caller with no budget of its own (failNoReady) holds a pid-established death for its exit event.
// Under CPU saturation the event trailed the pid check by up to 4.7 s (receipts/w2-flakes/exit-lag-32.txt);
// 15 s is three times that and still bounded. A spawn error answers at once, not after this (noteExitEvent above).
const EXIT_CODE_WAIT_MS = 15000;

// A death established by a pid check (not an exit event, not a spawn error) is the only one an exit event can
// still be on its way for. wait.cjs and failNoReady gate their wait on it; a spawn-error death emits no `exit`.
const PID_CHANNELS = ['pid-poll', 'pid-check-on-stop', 'pid-check-on-restart', 'pid-check-before-running-write', 'core-refused-running'];
const deathByPidCheck = (w) => !!w.settledChild && PID_CHANNELS.some((c) => String(w.deathEstablishedBy).startsWith(c));

// Wait, bounded, for an exit code the OS has not delivered yet. Returns as soon as one is known.
async function awaitExitCode(w, ms) {
  if (w.exitCode != null || w.exitSignal != null || !w.exitEventSeen) return;
  let timer;
  await Promise.race([w.exitEventSeen, new Promise((r) => { timer = setTimeout(r, ms); })]);
  clearTimeout(timer);
}

const waitReady = (w, ms) =>
  new Promise((res) => {
    if (w.readyAt) return res({ session_id: w.sessionId });
    const r = (e) => {
      clearTimeout(t);
      res(e);
    };
    const t = setTimeout(() => {
      const i = w.readyWaiters.indexOf(r);
      if (i >= 0) w.readyWaiters.splice(i, 1);
      res(null);
    }, ms);
    w.readyWaiters.push(r);
  });

const waitTurn = (w, ms) =>
  new Promise((res) => {
    const r = (v) => {
      clearTimeout(t);
      res(v);
    };
    const t = setTimeout(() => {
      const i = w.turnWaiters.indexOf(r);
      if (i >= 0) w.turnWaiters.splice(i, 1);
      res(null);
    }, ms);
    w.turnWaiters.push(r);
  });

const waitExit = (w, ms) =>
  new Promise((res) => {
    if (w.settled) return res({ code: w.exitCode, signal: w.exitSignal, at: w.exitedAt });
    const r = (v) => {
      clearTimeout(t);
      res(v);
    };
    const t = setTimeout(() => {
      const i = w.exitWaiters.indexOf(r);
      if (i >= 0) w.exitWaiters.splice(i, 1);
      res(null);
    }, ms);
    w.exitWaiters.push(r);
  });

module.exports = { waitReady, waitTurn, waitExit, awaitExitCode, deathByPidCheck, PID_CHANNELS, EXIT_CODE_WAIT_MS };
