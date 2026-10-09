'use strict';
// pid-identity.cjs — ADR 0039 decision 1 on the run side. Reads a spawned worker's creation time once,
// right after spawn, from one CIM snapshot, and keeps it on the record for rowOf to write as
// `pid_created`, with the image name the spawner launched as `pid_image`. The read runs beside the launch
// (about a second); the first rows go out without it and a restating row carries it when it lands. A failed
// read is tried SPAWN_READ_ATTEMPTS times while the snapshot is unreadable; only then does it store null and
// say why in `pid_created_error`, and a row with that error is never killed by a guess.

const path = require('node:path');
const P = require('./process.cjs');

const SPAWN_READ_ATTEMPTS = 3; // review follow-up: a row becomes unverified only after every read failed
const SPAWN_READ_BACKOFF_MS = 250;

const exitedYet = (child) => child.exitCode !== null && child.exitCode !== undefined || (child.signalCode !== null && child.signalCode !== undefined);

function noteSpawn(w, child, { createdOf = P.createdOf } = {}) {
  const pid = child.pid;
  w.pidCreated = null; w.pidCreatedError = null;
  w.pidImage = child.spawnfile ? path.basename(String(child.spawnfile)) : null;
  if (!Number.isInteger(pid)) { w.pidCreatedError = 'the spawn gave no pid'; w.pidCreatedPromise = null; return null; }
  w.pidCreatedPromise = Promise.resolve().then(() => createdOf(pid, { attempts: SPAWN_READ_ATTEMPTS, backoffMs: SPAWN_READ_BACKOFF_MS })).then((r) => {
    if (w.pid !== pid) return; // a relaunch took the record over; this read belongs to the old life
    // A child that exited before the read may have lost its pid to another process: its snapshot entry proves nothing.
    if (exitedYet(child)) w.pidCreatedError = `the child had already exited when the creation time of pid ${pid} was read, so the reading is discarded`;
    else if (r && Number.isFinite(r.created)) w.pidCreated = r.created;
    else w.pidCreatedError = `the process snapshot had no creation time for pid ${pid} (unreadable on all ${SPAWN_READ_ATTEMPTS} attempts, or the process had already gone)`;
  }).catch((e) => {
    if (w.pid === pid) w.pidCreatedError = `the process snapshot failed: ${(e && e.message) || e}`;
  }).then(() => {
    // The first rows went out before the read finished: restate the current state once with it.
    if (w.pid === pid && w.ctx && w.ctx.writeRow) require('./write-row.cjs').restatePidCreated(w, w.ctx);
  });
  return w.pidCreatedPromise;
}

// An adopted record keeps what its row said about the same pid.
function adoptFromRow(w, row) {
  w.pidCreated = Number.isFinite(row.pid_created) ? row.pid_created : null;
  w.pidCreatedError = row.pid_created_error || null;
  w.pidImage = row.pid_image || null;
  w.pidCreatedPromise = null;
}

// The row fields. Always written, null included: a stale value from a previous pid must never merge through.
const rowFields = (w) => ({
  pid_created: w.pidCreated == null ? null : w.pidCreated,
  pid_created_error: w.pidCreated == null ? (w.pidCreatedError || null) : null,
  pid_image: w.pidImage || null,
});

// The kill target for a worker record: its live child handle when it has one, else the row's identity.
function targetOf(w) {
  if (w.child && w.child.pid === w.pid) return w.child;
  return P.rowTarget({ pid: w.pid, pid_created: w.pidCreated, pid_created_error: w.pidCreatedError, pid_image: w.pidImage, substrate: w.substrate });
}

// The kill sequence for a worker record (ADR 0039 decision 3): handle when live, else its row's identity.
// -> { tree, pidKill, identity, refused, descendants_not_killed }; a refusal is a result, never a throw.
async function killWorker(w) {
  return P.killProcess(targetOf(w)).catch((e) => ({ tree: null, pidKill: { signalled: false, error: 'EIDENTITY' }, identity: null, refused: { refused: 'identity', kind: 'unverifiable', detail: (e && e.message) || String(e) } }));
}

module.exports = { SPAWN_READ_ATTEMPTS, killWorker, noteSpawn, adoptFromRow, rowFields, targetOf };
