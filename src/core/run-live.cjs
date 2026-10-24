'use strict';
// run-live.cjs — is the adapter a run's row names still that process? A pid that answers proves only that some process holds
// it, and Windows reuses pids quickly, so a crashed run's pid can come back as an unrelated process. The creation time the
// attach recorded (adapter_pid_created) settles it, read from the process snapshot the kill paths use (ADR 0039).
// -> { state: 'dead' | 'live' | 'unverifiable', detail }
//    dead          the pid is gone, or now belongs to a process created at another time: the run lapsed
//    live          the pid holds a process created at the recorded time: the adapter is still there
//    unverifiable  the pid answers but no recorded or readable creation time can say whose it is (the attach is allowed, with a warning)

const ID = require('./proc-identity.cjs');
const { pidAlive } = require('./lock.cjs');

async function adapterState(row, { snapshot = null, platform = process.platform } = {}) {
  const pid = Number(row.adapter_pid);
  if (!pidAlive(pid)) return { state: 'dead', detail: `pid ${pid} is not running` };
  if (platform !== 'win32') return { state: 'unverifiable', detail: `pid ${pid} is running (no creation time is read on this platform)` };
  const snap = await ID.snapshotRetry({ attempts: 2, snapshot });
  if (!snap) return { state: 'unverifiable', detail: `pid ${pid} is running and the process snapshot could not be read` };
  if (row.adapter_pid_created == null) {
    const e = snap.get(pid);
    return e ? { state: 'unverifiable', detail: `pid ${pid} is running and the run recorded no creation time for it` } : { state: 'dead', detail: `pid ${pid} is not in the process snapshot` };
  }
  const c = ID.checkIdentity(pid, { created: Number(row.adapter_pid_created) }, snap);
  if (c.ok) return { state: 'live', detail: `pid ${pid} was created at ${c.identity.created}, as recorded` };
  if (c.kind === 'mismatch' || c.kind === 'absent') return { state: 'dead', detail: c.detail };
  return { state: 'unverifiable', detail: c.detail };
}

// The refusal text for a run row whose adapter is verified `live`.
function liveMessage(runId, row) {
  return `run ${runId} is held by an adapter that is still running (pid ${row.adapter_pid}, epoch ${row.epoch}), most likely one left behind by an earlier run: end that process by its exact pid, or start this run under another run id (run_id in the spec)`;
}

// Only a verified identity refuses: an unverifiable one lets the attach through and says so.
function unverifiedWarning(runId, row, a) {
  return `run ${runId}: the previous adapter (pid ${row.adapter_pid}, epoch ${row.epoch}) could not be verified as gone (${a.detail}); attaching anyway. If that pid is a live belay adapter, end it by its exact pid`;
}

module.exports = { adapterState, liveMessage, unverifiedWarning };
