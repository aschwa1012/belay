'use strict';
// check-register.cjs — the spawn-register record of a command belay runs for a worker's code: an acceptance or integration check, or a
// git call in a worker's or an integration tree (a repository hook is a worker's code). The owner runs these as its own children, so a
// process they start must not pass the operator check as the operator (ADR 0045 decision 4). The record is the same one a worker has
// (spawn-register.cjs), kind `check`:
//   * written at spawn, before the child can reach an owner, already stamped, and retired when the child exits;
//   * stamped every STAMP_MS (1 s, under the 2 s slack spawn-provenance.cjs allows) while the child lives, with a plain file write and no
//     snapshot. An owner that is hard-killed (TerminateProcess runs no exit handler) leaves a record whose lifetime closes at the last
//     stamp, so every process the check started before the kill is covered. A worker's record is stamped every 30 s (run/seen-stamp.cjs);
//     a check starts descendants of its own at once, so it needs the fresher stamp;
//   * retired in this process's exit handler, with its lifetime closed at that moment, for an exit the process can see;
//   * given the child's creation time lazily: one snapshot, requested only for a check still running after CREATED_AFTER_MS, so a short
//     command (most git calls) costs no snapshot. A record without it keeps a tombstone named by pid alone and matches by pid.

const SR = require('./spawn-register.cjs');
const ID = require('./proc-identity.cjs');

const STAMP_MS = 1000;
const CREATED_AFTER_MS = 5000;
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
  for (const [pid, expect] of live) { try { SR.stampNow(pid, now, expect); } catch { /* a stamp is a refinement */ } }
}

function ensureRunning() {
  if (!hooked) { hooked = true; process.once('exit', retireAll); }
  if (!timer) { timer = setInterval(() => stamp(), STAMP_MS); if (timer.unref) timer.unref(); }
}

function stopIfIdle() {
  if (live.size === 0 && timer) { clearInterval(timer); timer = null; }
}

// Record `child` (just spawned; `spawnedAt` was read before the spawn call). Throws, naming what could not be recorded, when the
// register cannot be written: the caller ends the child. -> end(), to call when the child has exited.
function begin(child, kind, spawnedAt, what) {
  const expect = { kind, spawnedAt };
  const pid = child.pid;
  SR.registerProcess({ pid, ...expect, seenAt: Date.now() }, what);
  live.set(pid, expect);
  ensureRunning();
  const later = setTimeout(() => {
    if (live.get(pid) !== expect) return;
    const seq = ID.gate.stamp(); // a snapshot counts for this child only if it started after the spawn
    ID.snapshotShared({ kind: 'check-created' }).then((r) => {
      const e = r && r.snap && r.startSeq > seq ? r.snap.get(pid) : null;
      if (live.get(pid) === expect && e && Number.isFinite(e.created) && e.created >= spawnedAt - SPAWN_SLACK_MS) SR.update(pid, e.created, expect);
    }).catch(() => {});
  }, CREATED_AFTER_MS);
  later.unref();
  return () => {
    clearTimeout(later);
    if (live.get(pid) === expect) live.delete(pid);
    try { SR.unregister(pid, expect); } finally { stopIfIdle(); }
  };
}

module.exports = { begin, retireAll, stamp, liveCount: () => live.size, STAMP_MS, CREATED_AFTER_MS };
