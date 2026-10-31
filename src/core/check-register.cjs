'use strict';
// check-register.cjs — the spawn-register record of a command belay runs for a worker's code: an acceptance or integration check, or a
// git call that runs the repository's hooks. The owner runs these as its own children, so a process they start must not pass the
// operator check as the operator (ADR 0045 decision 4). The record is the same one a worker has (spawn-register.cjs), kind `check`:
//   * written at spawn, before the child can reach an owner, and retired when the child exits;
//   * stamped every 30 s while the child lives (as a worker's record is, run/seen-stamp.cjs), so a harness that dies mid-check leaves
//     a record whose lifetime closes at the last stamp and not at the spawn;
//   * retired in this process's exit handler, with its lifetime closed at that moment, so an exit the process can see (a stop, a
//     timeout, process.exit) leaves a tombstone that covers every orphan the check started;
//   * given the child's creation time once one snapshot has read it, so its tombstone is named by pid and creation time.
// A hard kill of the owner leaves the 30 s stamp gap, the same as for a worker.

const SR = require('./spawn-register.cjs');
const ID = require('./proc-identity.cjs');

const STAMP_MS = 30000;
const SPAWN_SLACK_MS = 1000; // a creation time earlier than this before the spawn call is another process's

const live = new Map(); // pid -> the identity the record was written with
let timer = null;
let hooked = false;

function retireAll() {
  const now = Date.now();
  for (const [pid, expect] of live) { try { SR.retire(pid, now, now, { checked: true, expect }); } catch { /* the next read retires it */ } }
  live.clear();
}

function stamp(now = Date.now()) {
  for (const pid of live.keys()) { try { SR.touch(pid, now); } catch { /* a stamp is a refinement */ } }
}

function ensureRunning() {
  if (!hooked) { hooked = true; process.once('exit', retireAll); }
  if (!timer) { timer = setInterval(stamp, STAMP_MS); if (timer.unref) timer.unref(); }
}

function stopIfIdle() {
  if (live.size === 0 && timer) { clearInterval(timer); timer = null; }
}

// Record `child` (just spawned; `spawnedAt` was read before the spawn call). Throws, naming what could not be recorded, when the
// register cannot be written: the caller ends the child. -> end(), to call when the child has exited.
function begin(child, kind, spawnedAt, what) {
  const expect = { kind, spawnedAt };
  const pid = child.pid;
  const seq = ID.gate.stamp(); // a snapshot counts for this child only if it started after the spawn
  SR.registerProcess({ pid, ...expect }, what);
  live.set(pid, expect);
  ensureRunning();
  ID.snapshotShared({ kind: 'check-created' }).then((r) => {
    const e = r && r.snap && r.startSeq > seq ? r.snap.get(pid) : null;
    if (live.get(pid) === expect && e && Number.isFinite(e.created) && e.created >= spawnedAt - SPAWN_SLACK_MS) SR.update(pid, e.created, expect);
  }).catch(() => {});
  return () => {
    if (live.get(pid) === expect) live.delete(pid);
    try { SR.unregister(pid, expect); } finally { stopIfIdle(); }
  };
}

module.exports = { begin, retireAll, stamp, liveCount: () => live.size, STAMP_MS };
