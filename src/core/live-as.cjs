'use strict';
// live-as.cjs — ADR 0039: a process is named by {pid, created}. `process.kill(pid, 0)` proves only that some process holds the
// pid, and Windows hands a dead process's pid out again within seconds. A write that takes a row's pid as a life (an attach
// marking a dead worker, a worker written running, a task assigned) asks here instead, so a row that records the creation time
// of its process reads dead once another process holds the pid. A row with no recorded time, or a snapshot that cannot be read,
// is not proof of death: the pid is taken as live, as it was before. Write paths only; no read verb calls this (invariant 9).

const { pidAlive } = require('./lock.cjs');

// A snapshot costs about a second, so none is taken for a pid that is not running or a row with no creation time.
// A row with no creation time but a recorded image (`image`) needs one too: another image at the pid proves the reuse.
const needsSnapshot = (pid, created, image) => pid != null && (created != null || image != null) && pidAlive(pid);

// The snapshot for the given {pid, created} pairs, or null when none of them needs one or it cannot be read.
async function snapshotFor(pairs) {
  if (!pairs.some((p) => needsSnapshot(p.pid, p.created, p.image))) return null;
  return require('./proc-identity.cjs').processSnapshot({ kind: 'live-as' });
}

// -> true when `pid` runs as the process the row records. `snap` comes from snapshotFor.
// `image`: the image the row records, read only when it has no creation time. A live process never changes its image, so another
// image at the pid means the row's process has exited; a pid absent from the snapshot, or a snapshot that cannot be read, proves nothing.
function runsAs(pid, created, snap, image = null) {
  if (!pidAlive(pid)) return false;
  if (created == null && image != null && snap) {
    const e = snap.get(Number(pid));
    return !(e && !require('./proc-identity.cjs').imageIn(e.image, image));
  }
  if (created == null || !snap) return true;
  const v = require('./proc-identity.cjs').checkIdentity(Number(pid), { created: Number(created) }, snap);
  return v.ok || v.kind === 'unverifiable';
}

// For a write that decides inside a synchronous step (a store transaction, or a read-then-append with no await): the snapshot is
// taken first, for the pairs the step is expected to look at, and the step asks `ready.runsAs`. A pair the snapshot was not
// taken for (the row changed meanwhile) is checked by its pid alone, as before, never read as absent from a snapshot that never
// asked about it.
async function prepare(pairs) {
  const snap = await snapshotFor(pairs);
  const known = (pid, created, image) => pairs.some((p) => p.pid === pid && p.created === created && (p.image ?? null) === image);
  return { runsAs: (pid, created, image = null) => runsAs(pid, created, known(pid, created, image) ? snap : null, image) };
}

// The pairs a worker row asks about: its pid with the creation time it records, none for no row or a row with no pid yet.
const pairsOf = (w) => (w && w.pid != null ? [{ pid: w.pid, created: w.pid_created }] : []);
// The same, with the image the row records: for a caller that passes it to `runsAs` as well (run.end's close of the ending epoch).
const pairsWithImage = (w) => (w && w.pid != null ? [{ pid: w.pid, created: w.pid_created, image: w.pid_image || null }] : []);

module.exports = { prepare, pairsOf, pairsWithImage, runsAs, snapshotFor };
