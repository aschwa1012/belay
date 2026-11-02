'use strict';
// proc-gone.cjs — "this process is gone", asserted by identity (ADR 0039) rather than by bare pid. `process.kill(pid, 0)` says
// a pid is held, not that the process the test started still holds it: once that process exits, Windows may hand the number to an
// unrelated one within seconds, and a suite that spawns continuously takes it. So the test captures the process's creation time
// while it is known alive (`identify`), and "gone" later means no process holds the pid, or the holder was created at another time.
// A snapshot that cannot be read while the pid is held fails the test; it never counts as gone. Where a test holds the child's
// handle, `child.exitCode !== null` or the 'exit' event is the better proof and needs none of this.

const assert = require('node:assert');
const ID = require('../../src/core/proc-identity.cjs');
const { pidAlive } = require('../../src/core/lock.cjs');

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

async function readSnapshot(pid, what) {
  const snap = await ID.snapshotRetry({ attempts: 2 });
  assert.ok(snap, `the process snapshot could not be read while checking pid ${pid} (${what})`);
  return snap;
}

// The identity of a process that is alive now: { pid, created }. `created` is null only when no process held the pid at the time
// (it died first), so any later holder is another process. A held pid whose creation time the snapshot lacks is a failed
// precondition.
async function identify(pid) {
  if (!pidAlive(pid)) return { pid, created: null };
  const snap = await readSnapshot(pid, 'identifying it while alive');
  const e = snap.get(pid);
  if (!e) return { pid, created: null }; // it exited between the signal and the snapshot
  assert.ok(e.created != null, `no creation time in the process snapshot for the live pid ${pid}`);
  return { pid, created: e.created };
}

// An identity the product recorded (a receipt's or a row's pid_created) instead of one read by the test. Without a creation time it
// cannot tell the process from a reuser of its number, so `isGone` fails while the pid is held rather than guess.
const recorded = (pid, created) => ({ pid, created: created == null ? null : created, recorded: true });

// True when no process holds `identity.pid`, or the holder is not the identified one.
async function isGone(identity) {
  if (!pidAlive(identity.pid)) return true;
  if (identity.created == null) {
    assert.ok(!identity.recorded, `pid ${identity.pid} is held and no creation time was recorded for it, so it cannot be told from a reused number`);
    return true; // nothing held the pid when it was identified, so a holder now is another process
  }
  const snap = await readSnapshot(identity.pid, 'checking that it is gone');
  const e = snap.get(identity.pid);
  if (!e) return true;
  assert.ok(e.created != null, `no creation time in the process snapshot for the held pid ${identity.pid}`);
  return e.created !== identity.created;
}

async function assertGone(identity, message) {
  assert.ok(await isGone(identity), message || `pid ${identity.pid} (created ${identity.created}) is still alive`);
}

// Resolves true once the identified process is gone, false at the deadline.
async function waitGone(identity, { deadlineMs = 15000, intervalMs = 50 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    if (await isGone(identity)) return true;
    await tick(intervalMs);
  }
  return isGone(identity);
}

// A child the test holds the handle of: true once it has exited (the handle's own exit code or signal, or its 'exit' event), false at the
// deadline. The handle cannot be fooled by a reused pid number.
function childExited(child, { deadlineMs = 15000 } = {}) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.removeListener('exit', onExit); resolve(false); }, deadlineMs);
    function onExit() { clearTimeout(timer); resolve(true); }
    child.once('exit', onExit);
  });
}

// For a run manager over a fake core: the identity of the process named by the first worker row that carries a pid, taken as that row is
// written. The process is alive then (just spawned) and the product has not yet had the chance to end it, so a launch that is refused and
// killed before it returns can still be proved gone afterwards. Read the result's `id` once the launch is done; null if no row named a pid.
function identifyOnWrite(core) {
  const out = { id: null };
  const write = core.worker.write.bind(core.worker);
  core.worker.write = async (row) => { if (!out.id && row.pid) out.id = await identify(row.pid); return write(row); };
  return out;
}

// Which of these identities are still held, from ONE process snapshot taken after a cheap signal-0 filter (a pid nothing holds is gone for
// certain, so a set that has all exited costs no snapshot). Asking one identity at a time would cost a snapshot each and spread the sample
// over seconds. A held pid with a recorded identity that has no creation time fails, as in `isGone`.
async function heldAmong(identities) {
  const live = identities.filter((id) => pidAlive(id.pid));
  if (!live.length) return [];
  const snap = await readSnapshot(live[0].pid, 'checking the identified set');
  return live.filter((id) => {
    const e = snap.get(id.pid);
    if (!e) return false;
    if (id.created == null) {
      assert.ok(!id.recorded, `pid ${id.pid} is held and no creation time was recorded for it, so it cannot be told from a reused number`);
      return false;
    }
    assert.ok(e.created != null, `no creation time in the process snapshot for the held pid ${id.pid}`);
    return e.created === id.created;
  });
}

// The identities of `rootPids` and every descendant they have now, all from the one snapshot, so a pid reused between two reads cannot
// give a stranger's creation time. A root the snapshot does not hold is left out (it is already gone).
async function identifyTree(rootPids) {
  const snap = await readSnapshot(rootPids[0], 'identifying a process tree');
  const out = new Map();
  for (const root of rootPids.filter(Boolean)) {
    const e = snap.get(root);
    if (e && e.created != null) out.set(root, { pid: root, created: e.created });
    for (const d of ID.descendantsOf(root, snap).leavesFirst) if (d.created != null) out.set(d.pid, { pid: d.pid, created: d.created });
  }
  return [...out.values()];
}

// Identities of several pids, in order.
const identifyAll = (pids) => Promise.all(pids.map((p) => identify(p)));

module.exports = { identify, identifyAll, heldAmong, identifyTree, identifyOnWrite, recorded, isGone, assertGone, waitGone, childExited };
