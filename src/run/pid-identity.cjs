'use strict';
// pid-identity.cjs — ADR 0039 decision 1 on the run side, ADR 0048 decision 3. Reads a spawned worker's creation
// time right after spawn, from the next snapshot to start (one attempt), and keeps it on the record for rowOf to
// write as `pid_created`, with the image name the spawner launched as `pid_image`. The first rows go out without
// it and a restating row carries it when it lands. A read that fails leaves the row pending, not final: while this
// process holds the live child handle, any snapshot its gate completes after the spawn is checked for the pid, and
// reads are scheduled at 30 s, 60 s, 120 s and then every 300 s. Only when the child exits first does the error
// become final. A row with an error is never killed by a guess (by another process).

const path = require('node:path');
const P = require('./process.cjs');
const ID = require('../core/proc-identity.cjs');

const RETRY_SCHEDULE_MS = [30000, 60000, 120000];
const RETRY_EVERY_MS = 300000;
const SPAWN_SLACK_MS = 1000; // a late reading may not be earlier than this before the spawn call

const exitedYet = (child) => child.exitCode !== null && child.exitCode !== undefined || (child.signalCode !== null && child.signalCode !== undefined);
const restate = (w, force) => { if (w.ctx && w.ctx.writeRow) require('./write-row.cjs').restatePidCreated(w, w.ctx, force); };

function noteSpawn(w, child, { createdOf = P.createdOf, gate = ID.gate, schedule = RETRY_SCHEDULE_MS, every = RETRY_EVERY_MS, snapshotShared = ID.snapshotShared } = {}) {
  const pid = child.pid;
  const spawnedAt = Date.now();
  const spawnSeq = gate.stamp(); // a snapshot counts for this spawn only if it started after this
  w.pidCreated = null; w.pidCreatedError = null;
  w.pidImage = child.spawnfile ? path.basename(String(child.spawnfile)) : null;
  if (!Number.isInteger(pid)) { w.pidCreatedError = 'the spawn gave no pid'; w.pidCreatedPromise = null; return null; }
  const mine = () => w.pid === pid; // a relaunch took the record over; a read for the old life belongs to nobody
  let pending = false; let tries = 0; let timer = null; let off = null;
  const stop = () => { pending = false; clearTimeout(timer); if (off) off(); off = null; };
  const setPending = (why) => { w.pidCreatedError = `${why}; retrying while the worker runs (try ${tries})`; };
  const accept = (e) => { // the three conditions of decision 3, checked where the reading is taken
    if (!pending || !mine() || exitedYet(child) || !e || !Number.isFinite(e.created) || e.created < spawnedAt - SPAWN_SLACK_MS) return false;
    w.pidCreated = e.created; w.pidCreatedError = null; stop(); restate(w, true);
    return true;
  };
  const scheduleNext = () => {
    if (!pending) return;
    const wait = tries - 1 < schedule.length ? schedule[tries - 1] - (tries > 1 ? schedule[tries - 2] : 0) : every;
    timer = setTimeout(() => { if (!pending) return; tries += 1; snapshotShared({ kind: 'spawn-read' }).then((r) => { if (pending && !(r.snap && r.startSeq > spawnSeq && accept(r.snap.get(pid)))) { setPending(r.snap ? `the process snapshot had no creation time for pid ${pid}` : 'the process snapshot was unreadable'); scheduleNext(); } }, () => scheduleNext()); }, wait);
    if (timer.unref) timer.unref();
  };
  w.pidCreatedPromise = Promise.resolve().then(() => createdOf(pid)).then((r) => {
    if (!mine()) return;
    // A child that exited before the read may have lost its pid to another process: its snapshot entry proves nothing.
    if (exitedYet(child)) w.pidCreatedError = `the child had already exited when the creation time of pid ${pid} was read, so the reading is discarded`;
    else if (r && Number.isFinite(r.created)) w.pidCreated = r.created;
    else {
      pending = true; tries = 1;
      setPending(`the process snapshot had no creation time for pid ${pid} (unreadable, or the process had already gone)`);
      off = gate.onSnapshot((snapR) => { if (snapR.snap && snapR.startSeq > spawnSeq) accept(snapR.snap.get(pid)); });
      child.once('exit', () => { if (!pending) return; stop(); if (mine()) { w.pidCreatedError = `never read: the worker exited before its creation time was read (${tries} ${tries === 1 ? 'try' : 'tries'})`; restate(w, true); } });
      scheduleNext();
    }
  }).catch((e) => {
    if (mine()) w.pidCreatedError = `the process snapshot failed: ${(e && e.message) || e}`;
  }).then(() => {
    // The first rows went out before the read finished: restate the current state once with it.
    if (mine()) restate(w, false);
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

module.exports = { RETRY_SCHEDULE_MS, RETRY_EVERY_MS, killWorker, noteSpawn, adoptFromRow, rowFields, targetOf };
