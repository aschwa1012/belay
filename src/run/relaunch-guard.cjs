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

//
// One relaunch owns the window. A second one (two Codex messages, a message and a restart) is refused E_BUSY before it enters
// (refuseIfRelaunching, called in the same tick as the call that sets the flag). Behind that, each call holds its own token in
// `w.relaunching` (a set, null when empty): it removes only its own, and its failure's restatement runs only if no relaunch is in
// flight, no launch has happened since this call began, and the record is dead, so one relaunch's failure never releases another's
// lease and never ends another's window.
function refuseIfRelaunching(w, what) {
  if (w.relaunching != null) {
    const err = new Error(`worker ${w.id} is being relaunched, so it takes no ${what} now; retry when that relaunch returns`);
    err.code = 'E_BUSY'; err.detail = { worker_id: w.id, relaunching: true };
    throw err;
  }
}

async function relaunching(w, writeRow, fn) {
  const me = {}; const launches = w.launches;
  (w.relaunching || (w.relaunching = new Set())).add(me);
  const done = () => { if (w.relaunching && w.relaunching.delete(me) && !w.relaunching.size) w.relaunching = null; };
  let out;
  try {
    out = await fn();
  } catch (e) {
    done();
    await (w.queue = w.queue.then(() => (w.relaunching == null && w.launches === launches && w.state === 'dead' ? writeRow(w, 'dead', { releaseLeases: true }) : null)).catch((err) => {
      w.lastError = { where: 'worker.write/relaunch-release', code: err && err.code, message: err && err.message };
    }));
    throw e;
  } finally {
    done();
  }
  return out;
}

module.exports = { relaunching, refuseIfRelaunching };
