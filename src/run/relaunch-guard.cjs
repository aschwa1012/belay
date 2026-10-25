'use strict';
// relaunch-guard.cjs — ADR 0026 amendment 2 decision 6 (proposed). A relaunch (a restart, a resume, a Codex turn) asks the core about
// its worker's lease (task.ensureHold) and then launches on that answer. A death of the old life that settles anywhere in between,
// its dead row landing after the answer, would release the lease the relaunch then runs under, and nothing would say so. No count
// or re-ask closes that window, since one always remains between the last read and the launch. So while the relaunch is under way
// the record says so (`w.relaunching`), and any dead row written meanwhile carries keep_leases (write-row.cjs), as the restart's own
// held death always has. The flag clears once launch() returns, which has moved `w.launches`: from then a death is the new life's
// and releases as normal, and a row of the old life still queued is dropped (exit.cjs lifeWrite).
//
// A relaunch that fails before it launched has kept a lease no process will work under. If a dead row was kept during it, that row
// is restated once with release_leases after the flag clears, so the death releases the lease as any other does. A relaunch that
// fails after launch() writes its own dead row (start-fail.cjs) with the flag clear, which releases as normal.

async function relaunching(w, writeRow, fn) {
  w.relaunching = true; w.keptDeath = false;
  let out;
  try {
    out = await fn();
  } catch (e) {
    w.relaunching = false;
    if (w.keptDeath && w.state === 'dead') { // no row of a new life was written
      await (w.queue = w.queue.then(() => writeRow(w, 'dead', { releaseLeases: true })).catch((err) => {
        w.lastError = { where: 'worker.write/relaunch-release', code: err && err.code, message: err && err.message };
      }));
    }
    throw e;
  } finally {
    w.relaunching = false;
  }
  return out;
}

module.exports = { relaunching };
