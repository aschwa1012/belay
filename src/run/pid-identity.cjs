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
const SR = require('../core/spawn-register.cjs');
const { err } = require('../core/errors.cjs');

const RETRY_SCHEDULE_MS = [30000, 60000, 120000];
const RETRY_EVERY_MS = 300000;
const SPAWN_SLACK_MS = 1000; // a late reading may not be earlier than this before the spawn call

const exitedYet = (child) => child.exitCode !== null && child.exitCode !== undefined || (child.signalCode !== null && child.signalCode !== undefined);
// The register record is written at spawn without a creation time (conservative: its window opens at the spawn call), so a failed update
// costs precision, not safety. It must never reject a promise nothing awaits (that ends the adapter and skips every worker's cleanup):
// the failure is kept on the record, where status reads it, and the conservative record stays.
function updateRegister(w, pid, created) {
  try { SR.update(pid, created); }
  catch (e) { w.lastError = { where: 'spawn-register.update', code: e && e.code, message: (e && e.message) || String(e) }; }
}
const restate = (w, force) => { if (w.ctx && w.ctx.writeRow) require('./write-row.cjs').restatePidCreated(w, w.ctx, force); };

// ADR 0045 decision 4: a worker is recorded in the machine-wide spawn register the moment it exists, so another store's owner never takes
// its child for an operator. A register that cannot be written ends the child and its descendants and fails the launch: a worker no owner
// can recognise must not run. The retries before the refusal take about a second, long enough for the child to have started a helper, so
// the end is a tree kill by the live handle (descendants first, the parent last), never the parent alone. The refusal carries the
// teardown as a non-enumerable `teardown` promise that settles once both are gone; the caller awaits it before it hands the error back.
const TEARDOWN_WAIT_MS = 10000;
async function endUnregistered(child, error) {
  const out = { tree: null, parent_gone: null, descendants_not_killed: null };
  try {
    const r = await P.killProcess(child);
    out.tree = r.tree ? { ok: !!r.tree.ok, terminated: r.tree.terminated, killed: r.tree.killed } : null;
    out.descendants_not_killed = r.descendants_not_killed || (r.tree && r.tree.tree_refused) || null;
  } catch (e) { out.descendants_not_killed = (e && e.message) || String(e); }
  if (P.pidAlive(child.pid)) { try { child.kill(); } catch { /* it may already be gone */ } }
  out.parent_gone = (await P.waitPidGone(child.pid, { timeoutMs: TEARDOWN_WAIT_MS })) !== null;
  Object.assign(error.detail, { teardown: out });
  return out;
}

function registerSpawn(w, child, dataDir, kind = 'worker') {
  if (!Number.isInteger(child.pid)) return;
  try { SR.register({ pid: child.pid, kind, dataDir, workerId: w.id, spawnedAt: child.belaySpawnStartedAt }); }
  catch (e) {
    const refusal = err('E_SUBSTRATE', `worker ${w.id}: the spawn register could not be written (${(e && e.message) || e}); the process and its descendants were ended, because a worker no owner can recognise must not run`, { worker_id: w.id, pid: child.pid, reason: 'spawn_register' });
    Object.defineProperty(refusal, 'teardown', { value: endUnregistered(child, refusal).catch(() => null), enumerable: false });
    throw refusal;
  }
  child.once('exit', () => SR.unregister(child.pid));
}

function noteSpawn(w, child, { createdOf = P.createdOf, gate = ID.gate, schedule = RETRY_SCHEDULE_MS, every = RETRY_EVERY_MS, snapshotShared = ID.snapshotShared } = {}) {
  const pid = child.pid;
  const spawnedAt = Number.isFinite(child.belaySpawnStartedAt) ? child.belaySpawnStartedAt : Date.now(); // the time before the spawn call, when the spawner took it
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
    w.pidCreated = e.created; w.pidCreatedError = null; stop(); updateRegister(w, pid, e.created); restate(w, true);
    return true;
  };
  const scheduleNext = () => {
    if (!pending) return;
    const wait = tries - 1 < schedule.length ? schedule[tries - 1] - (tries > 1 ? schedule[tries - 2] : 0) : every;
    timer = setTimeout(() => { if (!pending) return; tries += 1; snapshotShared({ kind: 'spawn-read' }).then((r) => { if (pending && !(r.snap && r.startSeq > spawnSeq && accept(r.snap.get(pid)))) { setPending(r.snap ? `the process snapshot had no creation time for pid ${pid}` : 'the process snapshot was unreadable'); scheduleNext(); } }, () => scheduleNext()); }, wait);
    if (timer.unref) timer.unref();
  };
  w.pidCreatedPromise = Promise.resolve().then(() => createdOf(pid, { kind: 'spawn-read' })).then((r) => {
    if (!mine()) return;
    // A child that exited before the read may have lost its pid to another process: its snapshot entry proves nothing.
    if (exitedYet(child)) w.pidCreatedError = `the child had already exited when the creation time of pid ${pid} was read, so the reading is discarded`;
    else if (r && Number.isFinite(r.created) && (!Number.isFinite(child.belaySpawnStartedAt) || r.created >= spawnedAt - SPAWN_SLACK_MS)) w.pidCreated = r.created; // the same rule as a later reading
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
    if (mine()) { if (w.pidCreated != null) updateRegister(w, pid, w.pidCreated); restate(w, false); }
  });
  return w.pidCreatedPromise;
}

// An adopted record keeps what its row said about the same pid.
function adoptFromRow(w, row) {
  w.pidCreated = Number.isFinite(row.pid_created) ? row.pid_created : null;
  // A pending read ("retrying while the worker runs") was kept alive by the adapter that held the child handle. Every row this
  // adapter writes carries its own adapter_pid, and it holds no handle for this one, so nothing will read it again: the error
  // becomes final here, and the manual-stop hint stops promising that the row may be verified shortly.
  const err = row.pid_created_error || null;
  w.pidCreatedError = err && /retrying while the worker runs/.test(err) ? `never read: ${err.replace(/; retrying while the worker runs.*$/, '')}; the adapter that held the worker's handle is gone, and the adapter that adopted it holds none` : err;
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

// A record with no process by construction: no child handle, and either this adapter settled its death or the row it was adopted
// from reads a state that has none (a death, a stop, a park, a Codex worker between turns). Its pid number may belong to another
// process by now, so no caller may read that pid's signal-0 answer as this worker's life (ADR 0039).
const NO_PROCESS_STATES = new Set(['dead', 'stopped', 'paused', 'idle']);
const noProcess = (w) => !w.child && (w.settledState != null || NO_PROCESS_STATES.has(w.state));

// Liveness for a read path (no snapshot, invariant 9): false for a record with no process, else the pid check.
const pidLive = (w) => !!w.pid && !noProcess(w) && P.pidAlive(w.pid);

// Liveness for an intervention that acts on the answer: the handle when this adapter holds one, else the row's identity checked
// against one snapshot. A mismatch or an absent pid is not this worker; a row with no creation time, or a snapshot that cannot be
// read, proves nothing, so the worker may be alive.
async function verifiedLive(w, { snapshot = () => P.snapshotShared({ kind: 'liveness' }) } = {}) {
  if (!pidLive(w)) return false;
  if (w.child && w.child.pid === w.pid) return ID.handleLive(w.child);
  const t = targetOf(w);
  if (t.created == null) return true;
  const r = await snapshot();
  const c = ID.checkIdentity(w.pid, t, r && r.snap);
  return c.ok || c.kind === 'unverifiable';
}

// The kill sequence for a worker record (ADR 0039 decision 3): handle when live, else its row's identity.
// -> { tree, pidKill, identity, refused, descendants_not_killed }; a refusal is a result, never a throw.
async function killWorker(w) {
  return P.killProcess(targetOf(w)).catch((e) => ({ tree: null, pidKill: { signalled: false, error: 'EIDENTITY' }, identity: null, refused: { refused: 'identity', kind: 'unverifiable', detail: (e && e.message) || String(e) } }));
}

module.exports = { RETRY_SCHEDULE_MS, RETRY_EVERY_MS, killWorker, noteSpawn, registerSpawn, adoptFromRow, rowFields, targetOf, noProcess, pidLive, verifiedLive };
