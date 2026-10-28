'use strict';
// live-as.cjs — ADR 0039: a process is named by {pid, created}. `process.kill(pid, 0)` proves only that some process holds the
// pid, and Windows hands a dead process's pid out again within seconds. A write that takes a row's pid as a life (an attach
// marking a dead worker, a worker written running, a task assigned) asks here instead, so a row that records the creation time
// of its process reads dead once another process holds the pid. A row with no recorded time, or a snapshot that cannot be read,
// is not proof of death: the pid is taken as live, as it was before. Write paths only; no read verb calls this (invariant 9).

const { pidAlive } = require('./lock.cjs');

// A snapshot costs about a second, so none is taken for a pid that is not running or a row with no creation time.
const needsSnapshot = (pid, created) => pid != null && created != null && pidAlive(pid);

// The snapshot for the given {pid, created} pairs, or null when none of them needs one or it cannot be read.
async function snapshotFor(pairs) {
  if (!pairs.some((p) => needsSnapshot(p.pid, p.created))) return null;
  return require('./proc-identity.cjs').processSnapshot({ kind: 'live-as' });
}

// -> true when `pid` runs as the process the row records. `snap` comes from snapshotFor.
function runsAs(pid, created, snap) {
  if (!pidAlive(pid)) return false;
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
  const known = (pid, created) => pairs.some((p) => p.pid === pid && p.created === created);
  return { runsAs: (pid, created) => runsAs(pid, created, known(pid, created) ? snap : null) };
}

module.exports = { prepare, runsAs, snapshotFor };
