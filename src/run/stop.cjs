'use strict';
// stop.cjs — build step 5c, design item 3. The stop
// sequence a run's own control pipe runs: end the orchestrator by the stdin rule, then wait for its
// workers to settle (or kill by exact pid what has not), and report both as derived facts. Every step
// here reads the store or the process table; nothing is a worker's or an orchestrator's own claim.

const P = require('./process.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A row that claims to be running but has no live pid to back it up is not something belay stop can
// kill; it can only say so. build step 6e-4: `paused` is dropped — a parked worker is never live.
function claimsLive(w) {
  return w.state === 'starting' || w.state === 'running' || w.state === 'stopping';
}

// build step 6f, ADR 0023 amendment 3 decision 4.4: `pauseSettled`, when given, is awaited before the
// ordinary stop sequence runs — the same shape `run-pause.cjs`'s own `settled()` exposes, so `stop` is
// never refused by, and never races, a `run.pause`/`run.resume` in flight. Defaults to an immediate
// no-op so every other caller (tests included) is unaffected.
function createStopControl({ runId, core, closeGraceMs, pauseSettled = async () => null }) {
  let hook = null; // { pid, exited, stop, pause, resume } — attached once the orchestrator's spawn is confirmed
  let inFlight = null;
  let completed = null; // 5c-2 design item 1: the last doStop receipt to resolve, kept after inFlight clears

  // `stopT0` is the whole stop sequence's own t0 (doStop's, below) — "after the stop began" in every
  // message here means since that instant, never since the worker phase itself started polling.
  async function killWorkerRow(w, stopT0, closeGraceMsNow) {
    const t0 = Date.now();
    // ADR 0039: the row's own identity (pid_created), never the bare pid; a refusal is reported, not hidden.
    const { tree, pidKill, identity, refused } = await P.withKillLock(() => P.killProcess(P.rowTarget(w))).catch((e) => ({ tree: { ok: false, terminated: 0, ms: Date.now() - t0 }, pidKill: { signalled: false, error: 'EIDENTITY' }, identity: null, refused: { refused: 'identity', detail: (e && e.message) || String(e) } }));
    const gone = await P.waitPidGone(w.pid, { timeoutMs: 2000 });
    return {
      killed: {
        tree: { ok: tree.ok, terminated: tree.terminated, ms: tree.ms },
        pid: { signalled: pidKill.signalled, error: pidKill.error },
        identity, ...(refused ? { refused: refused.refused, kind: refused.kind || null, detail: refused.detail, ...(refused.manual ? { manual: refused.manual } : {}) } : {}),
        pid_alive_after: gone === null ? P.pidAlive(w.pid) : false,
        ms: Date.now() - t0,
      },
      note: `still alive ${Date.now() - stopT0} ms after the stop began, past the ${closeGraceMsNow} ms bound; killed by exact pid`,
    };
  }

  // `stopT0` names the stop; `phaseStart` (this phase's own start, always >= stopT0) bounds the poll
  // against `closeGraceMs` and gives `worker_phase_ms` — the worker phase's own duration, separate
  // from how long step (a) took to end the orchestrator first.
  async function workerPhase(stopT0, phaseStart) {
    let rows = [];
    let hitBound = false;
    for (;;) {
      rows = (await core.worker.list({})).workers.filter((w) => w.run_id === runId);
      if (!rows.some((w) => claimsLive(w) && w.pid_alive === true)) break;
      if (Date.now() - phaseStart >= closeGraceMs) { hitBound = true; break; }
      await sleep(200);
    }
    if (!hitBound) {
      // The condition was met before the bound: give an adapter's own stopped/dead row a moment to land.
      await sleep(500);
      rows = (await core.worker.list({})).workers.filter((w) => w.run_id === runId);
    }
    const workers = rows.map((w) => {
      const entry = {
        id: w.id, pid: w.pid, state: w.state, seq: w.seq, exit_code: w.exit_code, exit_signal: w.exit_signal,
        death_established_by: w.death_established_by, pid_alive: w.pid_alive, mid_turn: w.mid_turn,
        established_by: `worker.list row seq ${w.seq} at ${Date.now() - stopT0} ms after the stop began, plus a pid check`,
        killed: null, note: null,
      };
      return entry;
    });
    // Killing is async per row; run it after the entries are built so `established_by`'s timestamp
    // reflects the read, not the kill.
    for (let i = 0; i < rows.length; i++) {
      const w = rows[i];
      if (!claimsLive(w)) continue;
      if (!w.pid_alive) { workers[i].note = 'the row claims a live state but the pid is dead; nothing wrote its exit'; continue; }
      const { killed, note } = await killWorkerRow(w, stopT0, closeGraceMs);
      workers[i].killed = killed;
      workers[i].note = note;
    }
    return { workers, worker_phase_ms: Date.now() - phaseStart };
  }

  // `why` is passed only by this process (ADR 0034: an embedder failure that cannot be fixed inside a run); the
  // pipe's `run.stop` control hands `handle` one argument. It must still say `stdin closed`, the stop's own rule.
  async function doStop(params, why) {
    await pauseSettled(); // 6f: never race a pause/resume in flight; stop always waits it out
    const t0 = Date.now(); // the stop's own t0 (design item 3): step (a) starts the instant this runs
    const reason = why || `stopped by belay stop (caller pid ${params.caller.pid}); stdin closed`;
    const facts = await hook.stop(reason);
    const orchestrator = {
      pid: facts.pid, exit_code: facts.exit_code, exit_signal: facts.exit_signal,
      // The child's own lifetime (facts.ms, measured from the run loop's own t0) is not this stop's
      // close time: ms_to_exit is how long THIS stop's own close-then-kill took, timed from t0 above,
      // not from when the orchestrator process itself was spawned (blocking finding, reviewer round 1).
      ms_to_exit: Date.now() - t0, graceful: !facts.killed_after_close, ended_by: facts.ended_by,
      established_by: 'the child exit event',
    };
    const phaseStart = Date.now();
    const { workers, worker_phase_ms } = await workerPhase(t0, phaseStart);
    // 6f, ADR 0023 amendment 3 decision 4.4: named from the same rows the worker phase already read —
    // a paused row claims no life for `claimsLive`/`killWorkerRow` to touch, so it is simply the rows
    // still reading `paused` once the worker phase settles.
    const left_parked = workers.filter((w) => w.state === 'paused').map((w) => w.id);
    return {
      run_id: runId, caller_pid: params.caller.pid, owner_pid: process.pid,
      orchestrator, workers, worker_bound_ms: closeGraceMs, worker_phase_ms, ms: Date.now() - t0, left_parked,
    };
  }

  function refused(code, message, detail) {
    const e = new Error(message);
    e.code = code;
    e.detail = detail;
    return Promise.reject(e);
  }

  function handle(params, why) {
    if (!params || params.run_id !== runId) {
      return refused('E_NOT_FOUND', `the live run here is ${runId}, not ${params && params.run_id}`, { live_run_id: runId });
    }
    if (!hook) return refused('E_NOT_FOUND', 'the run has no orchestrator to stop yet', { phase: 'before-spawn' });
    // A stop already running is checked BEFORE `hook.exited()` (should-fix, reviewer round 1): once
    // step (a) ends the orchestrator, `exited()` turns non-null while the worker phase is still
    // running for the whole of `closeGraceMs` — a second caller must still get that same in-flight
    // stop's receipt, not an `ended` refusal for a stop that is demonstrably still in flight.
    if (inFlight) return inFlight;
    const already = hook.exited();
    if (already) {
      // 5c-2 design item 1: once a stop run through this control has completed, `completed` names who
      // did it, so a later caller learns its own stop did nothing and who actually stopped the run —
      // not just that the orchestrator is gone (the `already` facts alone, kept for the case the
      // orchestrator exited on its own and no stop through this control ever completed).
      const detail = completed
        ? { phase: 'ended', ...already, stopped_by: { caller_pid: completed.caller_pid, at_ms: completed.ms } }
        : { phase: 'ended', ...already };
      return refused('E_NOT_FOUND', `the run's orchestrator (pid ${hook.pid}) already exited: ${already.ended_by}`, detail);
    }
    const p = doStop(params, why);
    inFlight = p;
    // 5c-2 design item 1: whatever doStop does, `inFlight` clears once it settles, so the next
    // `run.stop` is never poisoned by a rejected worker phase, and a resolved stop's receipt is kept in
    // `completed` for the `already`-exited refusal above rather than replayed as a second success.
    p.then(
      (receipt) => { completed = receipt; inFlight = null; },
      () => { inFlight = null; }
    );
    return p;
  }

  function attach(h) { hook = h; }

  // Resolves when no stop is in flight — at once if none was ever requested — with the completed
  // receipt when one exists, else null. Never rejects: a failed stop still lets the caller
  // (cmd-run.cjs) proceed.
  function settled() {
    return inFlight ? inFlight.then((r) => r, () => null) : Promise.resolve(completed);
  }

  // 6f fix round (finding 3): the reverse of `pauseSettled` above — `run-pause.cjs` reads this to
  // refuse a pause/resume while a stop actually owns the run, rather than racing it (a resume relaunching
  // a worker the stop's own worker phase then kills by pid). True only while `doStop` is in flight.
  function stopping() { return !!inFlight; }

  return { handle, attach, settled, stopping };
}

module.exports = { createStopControl };
