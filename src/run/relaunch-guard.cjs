'use strict';
// relaunch-guard.cjs — ADR 0026 amendment 2 decision 6 (proposed). A relaunch (a restart, a resume, a Codex turn) asks the core about
// its worker's lease (task.ensureHold) and then launches on that answer. A death of the old life that settles anywhere in between,
// its dead row landing after the answer, would release the lease the relaunch then runs under, and nothing would say so. No count
// or re-ask closes that window, since one always remains between the last read and the launch. So while the relaunch is under way
// the record says so (`w.relaunching`), and any dead row written meanwhile carries keep_leases (write-row.cjs), as the restart's own
// held death always has. The flag clears once launch() returns, which has moved `w.launches`: from then a death is the new life's
// and releases as normal, and a row of the old life still queued is dropped (exit.cjs lifeWrite).
//
// A relaunch that fails before it launched may leave a dead worker holding a lease no process will work under: one a death during
// it kept, one a kept dead row still in flight writes after the failure, or one ensureHold granted back (a death recorded before the
// relaunch). So the failure chains onto the worker's queue, after any row in flight, and if the record is then `dead` (no row of a
// new life was written; a failed resume leaves `paused`, which keeps its lease) it restates the dead row once with release_leases,
// and the core releases whatever the worker still holds. A relaunch that fails after launch() writes its own dead row
// (start-fail.cjs) with the flag clear, which releases as normal.

async function relaunching(w, writeRow, fn) {
  w.relaunching = true;
  let out;
  try {
    out = await fn();
  } catch (e) {
    w.relaunching = false;
    await (w.queue = w.queue.then(() => (w.state === 'dead' ? writeRow(w, 'dead', { releaseLeases: true }) : null)).catch((err) => {
      w.lastError = { where: 'worker.write/relaunch-release', code: err && err.code, message: err && err.message };
    }));
    throw e;
  } finally {
    w.relaunching = false;
  }
  return out;
}

module.exports = { relaunching };
