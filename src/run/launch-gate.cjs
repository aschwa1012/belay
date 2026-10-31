'use strict';
// launch-gate.cjs — what a spawn or a restart owes a stop or a run pause that overtakes it while it is still starting. Neither can
// see a worker with no process: a stop finds no pid, and a run pause lists rows by live pid. So:
//   - a stop that lands before the launch makes the spawn refuse (abortIfStopped);
//   - a pause that lands while a launch is in flight (w.launching for a spawn, the `restart` op for a restart) is held on the record
//     (`w.pauseOnLaunch`) and answered by the launch itself: refused at its last pre-launch check (no process starts, E_PAUSED), or,
//     once the worker is up and its `running` row is written, parked by a pause of its own (settle). The pause's caller gets that
//     park's receipt, so the worker is in this pause's parks and a run resume relaunches it. A launch that fails answers it with an
//     error. The worker's opening message is sent before Claude Code reports ready, so a launch that was past its last check is
//     interrupted at ready, not before.

const { fail, CoreError } = require('./errors.cjs');

function abortIfStopped(w) {
  if (!w.stopRequested) return;
  w.launchFailed = true;
  // The task lease the spawn's assignment took (if it ran) stays with the stopped worker: only a dead row releases a lease for the
  // run, and a dead row over a stop is what the failed-start path avoids. Restart the worker, or take control, to move the task.
  fail('E_SUBSTRATE', `worker ${w.id}: a stop arrived before the launch; the launch is abandoned and no process was started${w.taskId ? `. Task ${w.taskId}'s lease, if its assignment ran, is still held by ${w.id}: restart ${w.id} to continue it` : ''}`, { worker_id: w.id, substrate: w.substrate, state: w.state, reason: 'stopped_during_launch', launched: false, task_id: w.taskId || null });
}

// The paused-run gate in the last tick of a spawn's or a restart's pre-launch work. The core is asked first; the held pause is read
// after it, synchronously, so a pause that lands from here on is held and answered at ready. `restart`: the old process has already
// been stopped, so the refusal says so (the worker is stopped, not parked: a run resume does not bring it back).
async function refuseIfPaused(core, runId, w, { restart = false } = {}) {
  let refusal = null;
  try { await require('./paused-gate.cjs').refuseSpawnIfPaused(core, runId); } catch (e) { refusal = e; }
  if (!refusal && w && w.pauseOnLaunch) refusal = new CoreError('E_PAUSED', `run ${runId} is paused (${w.pauseOnLaunch.by}), and a paused run starts no new work`, { run_id: runId });
  if (!refusal) return;
  if (restart && refusal.code === 'E_PAUSED') {
    refusal.message = `${refusal.message}. worker ${w.id}'s earlier process has ended and no new one was started: it is stopped, not parked, so a run resume will not bring it back; restart it after the resume`;
    refusal.detail = { ...(refusal.detail || {}), worker_id: w.id, old_pid: w.pid, launched: false, state: w.state };
  }
  throw refusal;
}

// The gate once more, with the process launched and its pid row written (so a pause that lands after this is held, above): a run pause
// that set the run row before that row existed listed nothing, so the launch holds it itself and is parked at ready, by the pause's own
// `by`. This closes the window a restart of a stopped worker has between its last check and its pid row, where no row is listable.
async function holdIfPaused(core, runId, w) {
  if (w.pauseOnLaunch) return;
  try { await require('./paused-gate.cjs').refuseSpawnIfPaused(core, runId); } catch (e) {
    if (!e || e.code !== 'E_PAUSED') throw e;
    pendPark(w, (e.detail && e.detail.paused_by) || 'run pause (launch in flight)', {});
  }
}

const launchInFlight = (w) => w.launching === true || (!!w.op && w.op.name === 'restart');

// A pause of a worker whose launch is in flight: held, and answered by settle. Two pauses share one answer.
function pendPark(w, by, bounds) {
  if (!w.pauseOnLaunch) {
    const pp = { by, bounds, at: Date.now() };
    pp.promise = new Promise((resolve, reject) => { pp.resolve = resolve; pp.reject = reject; });
    pp.promise.catch(() => {}); // the caller awaits it; an unobserved rejection must not escape if the caller is gone
    w.pauseOnLaunch = pp;
  }
  return w.pauseOnLaunch.promise;
}

// The launch is over (`running` written, or it failed): answer the held pause. -> the park's receipt, or null.
async function settle(w, pause, launchError) {
  const pp = w.pauseOnLaunch;
  if (!pp) return null;
  w.pauseOnLaunch = null;
  if (launchError) {
    const refused = launchError.code === 'E_PAUSED';
    pp.reject(new CoreError(refused ? 'E_PAUSED' : 'E_WORKER_NOT_LIVE', `worker ${w.id}: the launch in flight ${refused ? 'was refused because the run is paused; no process was started' : 'failed before the worker was ready'}, so there is nothing to park`, { worker_id: w.id, launch_refused: refused, launched: false, cause: launchError.code || null }));
    return null;
  }
  try { const r = await pause({ worker_id: w.id, by: pp.by, ...pp.bounds }); pp.resolve(r); return r; } catch (e) { pp.reject(e); return null; }
}

// A spawn: `fn(hold)` sets hold.w once the worker record exists. A held pause is answered when the spawn returns or fails.
async function tracked(hold, pause, fn) {
  let res;
  try { res = await fn(hold); } catch (e) { if (hold.w) { hold.w.launching = false; await settle(hold.w, pause, e); } throw e; }
  hold.w.launching = false;
  const parked = await settle(hold.w, pause);
  return parked ? { ...res, parked_by_run_pause: { paused_by: parked.paused_by, paused_at: parked.paused_at } } : res;
}

// A restart: the op promise `p`; the slot is clear by the time it resolves, so the park can take it.
async function afterOp(w, pause, p) {
  let res;
  try { res = await p; } catch (e) { await settle(w, pause, e); throw e; }
  const parked = await settle(w, pause);
  return parked ? { ...res, parked_by_run_pause: { paused_by: parked.paused_by, paused_at: parked.paused_at } } : res;
}

module.exports = { abortIfStopped, refuseIfPaused, holdIfPaused, launchInFlight, pendPark, tracked, afterOp };
