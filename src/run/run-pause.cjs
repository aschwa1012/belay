'use strict';
// run-pause.cjs — build step 6f, design item 3, ADR 0023
// amendment 3 decisions 4 and 5. The run pause's own control: dispatched by the owner
// (src/core/owner.cjs `_dispatchRunControl`) for `run.pause` and `run.resume`, exactly as `run.stop`
// already is (src/run/stop.cjs). `pauseWorker(worker_id, caller)`/`resumeWorker(worker_id, caller)` are
// injected by cmd-run.cjs as calls of src/cli/adapter-pipe.cjs's `callWorkerAdapter` with `worker.pause`
// and `worker.resume` — src/run never imports src/cli. `hook` is the same `{ pid, exited, stop, pause,
// resume }` object orchestrator.cjs hands `stopControl.attach()`.

const { classifyResumeSet, buildParks } = require('./resume-set.cjs');

// `interactive` (ADR 0023 amendment 5): the orchestrator is the operator's live session, so the run pause neither
// interrupts it nor writes it a resume line; it parks and relaunches the run's workers and records the same row.
// The wake an interactive session gets when its run resumes (no resume line exists there): belay's own words, ids and
// facts only, at most 220 bytes (the mod's cap is 221 for the plugin name `belay`).
function resumeWakeText(by, resumed, left, held) {
  const list = (ids, max) => (ids.length <= max ? ids.join(', ') || 'none' : `${ids.slice(0, max).join(', ')} and ${ids.length - max} more`);
  const build = (max) => `belay: run resumed by ${by}: relaunched ${list(resumed, max)}${left.length ? `; left parked ${list(left, max)}` : ''}; ${held} held event${held === 1 ? '' : 's'} follow.`;
  for (const max of [4, 2, 1, 0]) { const t = build(max); if (Buffer.byteLength(t) <= 220) return t; }
  return build(0).slice(0, 220);
}

function createRunPauseControl({ runId, core, hook, pauseWorker, resumeWorker, stopInFlight, beforeResume, interactive = false }) {
  let inFlight = null; // { op: 'pause'|'resume', promise }
  // ADR 0037 wave 2 fix: an interactive run has no run-hold, so this process's own memory is the ground truth for
  // "paused" (a stale paused_at carried across a reattach does not count) and the wake publisher's hold.
  let interactivePaused = false;
  let lastResume = null; // interactive: what the wake publisher needs to announce a resume (taken once)

  // The orchestrator-facing halves of a pause and a resume: the only two steps an interactive run skips.
  async function interruptOrchestrator(by) { return interactive ? { interrupt: null, timeout: null } : hook.pause(by); }
  async function resumeOrchestrator(by, line) { return interactive ? { held: [], line: null, timeout: null } : hook.resume(by, line); }

  function refused(code, message, detail) {
    const e = new Error(message);
    e.code = code;
    e.detail = detail;
    return Promise.reject(e);
  }

  async function currentRun() { return (await core.run.get()).run; }

  // Every row of this run reading `starting`/`running` with a live pid, any substrate — decision 4.4:
  // only a Claude Code one is actually paused; a Codex one is named `not_paused` with `E_SUBSTRATE`.
  async function liveRows() {
    const { workers } = await core.worker.list({});
    return workers.filter((w) => w.run_id === runId && (w.state === 'starting' || w.state === 'running') && w.pid_alive === true);
  }
  async function pausedRows() {
    const { workers } = await core.worker.list({});
    return workers.filter((w) => w.run_id === runId && w.state === 'paused');
  }

  // `pauseWorker`/`resumeWorker` are `callWorkerAdapter`'s own shape: they never reject, they resolve
  // `{ success: bool, ... }` (src/cli/adapter-pipe.cjs) — so success is read from the field, not caught.
  async function attemptPause(w, caller, outcomes, reason) {
    if (outcomes.has(w.id)) return;
    if (w.substrate !== 'claude-code') {
      outcomes.set(w.id, { worker_id: w.id, ok: false, error: { code: 'E_SUBSTRATE', message: `worker ${w.id} is ${w.substrate}; pause is docked for Codex (ADR 0023 decision 2)` } });
      return;
    }
    const receipt = await pauseWorker(w.id, caller, reason);
    if (receipt.success) outcomes.set(w.id, { worker_id: w.id, ok: true, receipt });
    else outcomes.set(w.id, { worker_id: w.id, ok: false, error: receipt.error || { code: 'E_INTERNAL', message: receipt.reason } });
  }

  // Fix round (finding 2): the same fact `run.stop` already refuses on — an orchestrator that has
  // exited is not something a pause can reach. Checked ahead of the row and the slot both, exactly as
  // `stop.cjs`'s own `handle` checks `hook.exited()` before dispatching.
  // 6f-2 design item 2 (blocking review 2, run-pause.cjs:50): review 2's own case is a run whose stdin
  // the timeout or the idle rule has already closed, before the orchestrator's `exit` event has even
  // landed — `hook.exited()` alone misses that window. `hook.finishing()` (orchestrator.cjs's own
  // `state.finishing`) is true for every one of those reasons and for an exited run alike, so it is
  // checked first and named `{ phase: 'finishing', ended_by }`; the narrower `exited()` case keeps its
  // own `{ phase: 'ended' }` wording for a hook that answers both (every real one does).
  function refuseIfExited() {
    if (typeof hook.exited === 'function' && hook.exited()) {
      return refused('E_NOT_FOUND', `the run's orchestrator (run ${runId}) has already exited`, { phase: 'ended' });
    }
    if (typeof hook.finishing === 'function' && hook.finishing()) {
      const ended_by = typeof hook.endedBy === 'function' ? hook.endedBy() : null;
      return refused('E_NOT_FOUND', `the run (${runId}) is finishing${ended_by ? `: ${ended_by}` : ''}`, { phase: 'finishing', ended_by });
    }
    return null;
  }

  // build step 6i item 5 (C13, second half): a `run.stop` in flight is finishing too — the same refusal
  // `refuseIfExited` gives every other way a run finishes, not `E_BUSY {op:'stop'}` (pause.cjs and stop.cjs's own
  // `handle` between them already order every check by `finishing()`; this call site was the one left out).
  function refuseIfStopping() {
    if (typeof stopInFlight !== 'function' || !stopInFlight()) return null;
    const ended_by = typeof hook.endedBy === 'function' ? hook.endedBy() : null;
    return refused('E_NOT_FOUND', `the run (${runId}) is finishing${ended_by ? `: ${ended_by}` : ''}`, { phase: 'finishing', ended_by });
  }

  // Fix round (finding 1b): ground truth for "is this run already paused" is this process's own
  // in-memory state (`hook.isPaused`, run-hold.cjs), never the row alone — `run.attach` carries
  // `paused_at`/`paused_by` forward across a reattach (ADR 0023 amendment 3 decision 4.1), so a fresh
  // epoch's row can read paused while nothing here is holding anything. Falls back to the row only for
  // a hook that exposes no `isPaused` (s4's own fake hook).
  function isActuallyPaused(run) {
    if (interactive) return interactivePaused;
    return typeof hook.isPaused === 'function' ? hook.isPaused() : run.paused_at != null;
  }

  // ADR 0023 amendment 3 decision 4: mark + write the row, stop the clock, interrupt, then park.
  // `reason` is passed only by this process (ADR 0034's embedder-failure guard); the pipe's `run.pause` control hands
  // `pause` one argument, so a remote caller cannot supply it. `by` keeps the caller's role:pid and appends the cause,
  // and the same string is stamped on every park (control.cjs), so the run row and its parks agree (amendment 4).
  async function doPause(params, reason) {
    const run = await currentRun();
    if (!run) return refused('E_NOT_FOUND', `no run row exists for ${runId}`, { run_id: runId });
    if (!interactive && typeof hook.pause !== 'function') return refused('E_NOT_FOUND', 'the run has no orchestrator to pause yet', { phase: 'before-spawn' });
    const exited = refuseIfExited();
    if (exited) return exited;
    if (isActuallyPaused(run)) return { already: true, run };
    const by = `${params.caller.role}:${params.caller.pid}${reason ? ` [${reason}]` : ''}`;
    // item 1 (ADR 0023 amendment 4 decision 1): captured before any park, feeding both the receipt's own
    // (unchanged) `already_parked` ids and `pause_parks.already_parked`'s row pairs below.
    const alreadyParkedRows = await pausedRows();
    const already_parked = alreadyParkedRows.map((w) => w.id);

    const pausedAt = Date.now();
    await core.run.setPaused({ paused: true, at: pausedAt, by });
    if (interactive) interactivePaused = true; // from here the wake publisher holds its wakes
    const { interrupt, timeout } = await interruptOrchestrator(by);

    const outcomes = new Map();
    for (const w of await liveRows()) await attemptPause(w, params.caller, outcomes, reason);
    // decision 4.4: list once more; a worker spawned by a tool call still in flight at the interrupt
    // is caught here, not left `not_paused` for a park that could still have reached it.
    for (const w of await liveRows()) await attemptPause(w, params.caller, outcomes, reason);

    const workers = [];
    const not_paused = [];
    for (const o of outcomes.values()) (o.ok ? workers : not_paused).push(o.ok ? { worker_id: o.worker_id, receipt: o.receipt } : { worker_id: o.worker_id, error: o.error });
    for (const w of await liveRows()) {
      if (!outcomes.has(w.id)) not_paused.push({ worker_id: w.id, error: { code: 'E_INTERNAL', message: 'still live after both listing passes (recorded limit)' } });
    }

    // item a (blocking, R-review; R1/V1, ADR 0023 amendment 4 decision 1): `pause_parks` is built by
    // resume-set.cjs's `buildParks` from each receipt's own pair, never a fresh row re-read here — a hand
    // resume and re-pause by another identity, landing while a later park in this same pause is still in
    // flight, would otherwise show that later row and be recorded (and later relaunched) as this pause's own.
    // fixer-c regression: `by` (this pause's own identity) is passed through so a receipt a shared runOp
    // promise hands back from a different identity's hand pause is never read as this pause's own park.
    const parks = buildParks(outcomes, alreadyParkedRows, by);
    await core.run.setPaused({ paused: true, at: pausedAt, by, parks });

    const runRow = await currentRun();
    return { already: false, run: runRow, interrupt, timeout, workers, not_paused, already_parked };
  }

  // ADR 0023 amendment 3 decision 5, rebuilt by build step 6i-2 design item 1 (ADR 0023 amendment 4
  // decisions 1, 2; R1, V1): matches by equality with `run.pause_parks`, the set `doPause` recorded —
  // never by comparing this run process's own clock with the worker adapter's (6i's `paused_at >=
  // run.paused_at`, which two processes' `Date.now()` do not keep causal order for on this host).
  async function doResume(params) {
    const run = await currentRun();
    if (!run) return refused('E_NOT_FOUND', `no run row exists for ${runId}`, { run_id: runId });
    const exited = refuseIfExited();
    if (exited) return exited;
    if (!isActuallyPaused(run)) return refused('E_ARGS', `run ${runId} is not paused`, { run_id: runId });
    // ADR 0034 decision 2: an injected check (the embedder re-load) that may refuse the resume; the run stays paused.
    if (typeof beforeResume === 'function') await beforeResume(run, params);
    const by = `${params.caller.role}:${params.caller.pid}`;
    // fix-up (a): read from the run row alone, never an in-memory fallback (amendment 4, "rejected
    // alternatives": the store is the resume's real source; the row must always answer null or an
    // object, never undefined, which is what made a fallback tempting).
    const pauseParks = run.pause_parks;
    const rows = await pausedRows();
    const classified = classifyResumeSet(rows, pauseParks);
    const byId = new Map(rows.map((w) => [w.id, w]));

    const workers_resumed = [];
    const left_parked = [];
    for (const c of classified.left_parked) left_parked.push({ worker_id: c.worker_id, paused_by: c.paused_by, [c.reason]: true });
    for (const id of classified.resume) {
      const receipt = await resumeWorker(id, params.caller);
      if (receipt.success) { workers_resumed.push({ worker_id: id, receipt }); continue; }
      const error = receipt.error || { code: 'E_INTERNAL', message: receipt.reason };
      left_parked.push({ worker_id: id, paused_by: byId.get(id).paused_by, error });
    }

    const span_ms = Date.now() - run.paused_at;
    const beyond = (list) => (list.length > 10 ? `${list.slice(0, 10).map((w) => w.worker_id).join(', ')} and ${list.length - 10} more` : list.map((w) => w.worker_id).join(', ') || 'none');
    const pauser = /embedder-failure [(]/.test(run.paused_by || '') ? `an embedder failure paused this run (${String(run.paused_by).replace(/^[^[]*\[|\]$/g, '')})` : 'the operator paused this run';
    const line = `belay: ${pauser} ${span_ms} ms ago and has been resumed now; resumed [${beyond(workers_resumed)}]; left parked [${beyond(left_parked)}].`;

    const result = await resumeOrchestrator(by, line);
    const runRow = await core.run.setPaused({ paused: false });
    if (interactive) {
      lastResume = {
        id: `${runId}:resume:${run.paused_at}`, parks: ((pauseParks && pauseParks.parked) || []).filter((p) => workers_resumed.some((x) => x.worker_id === p.worker_id)),
        text: (n) => resumeWakeText(by, workers_resumed.map((x) => x.worker_id), left_parked.map((x) => x.worker_id), n),
      };
      interactivePaused = false;
    } // the held wakes are released, in order, at the publisher's next poll
    return {
      resumed: true, run: runRow, span_ms, workers_resumed, left_parked,
      held_wakes: result.held, line: result.line, timeout: result.timeout,
    };
  }

  // Fix round (finding 1): the live run here is `runId`; a caller naming any other id (a stale row from
  // an earlier or unrelated run in the same data dir, not yet ended) must be refused, exactly as
  // `stop.cjs`'s own `handle` refuses one — never acted on as if it named this run.
  function refuseWrongRun(params) {
    if (!params || params.run_id !== runId) {
      return refused('E_NOT_FOUND', `the live run here is ${runId}, not ${params && params.run_id}`, { live_run_id: runId });
    }
    return null;
  }

  function pause(params, reason) {
    const wrong = refuseWrongRun(params);
    if (wrong) return wrong;
    // Fix round (finding 3), reworded by item 5: a `belay stop` in flight owns the run now; racing it
    // with a pause is what let a resume relaunch a worker into a run already being torn down.
    const stopping = refuseIfStopping();
    if (stopping) return stopping;
    if (inFlight && inFlight.op === 'resume') return refused('E_BUSY', "run.pause: a run.resume is already in flight for this run", { op: 'resume' });
    if (inFlight && inFlight.op === 'pause') return inFlight.promise;
    const p = doPause(params, reason);
    inFlight = { op: 'pause', promise: p };
    p.then(() => { inFlight = null; }, () => { inFlight = null; });
    return p;
  }

  function resume(params) {
    const wrong = refuseWrongRun(params);
    if (wrong) return wrong;
    const stopping = refuseIfStopping();
    if (stopping) return stopping;
    if (inFlight && inFlight.op === 'pause') return refused('E_BUSY', "run.resume: a run.pause is already in flight for this run", { op: 'pause' });
    if (inFlight && inFlight.op === 'resume') return inFlight.promise;
    const p = doResume(params);
    inFlight = { op: 'resume', promise: p };
    p.then(() => { inFlight = null; }, () => { inFlight = null; });
    return p;
  }

  // stop.cjs's own `pauseSettled` hook: resolves once any pause/resume in flight has settled, never
  // rejects, so a stop is never refused or raced by one.
  function settled() {
    return inFlight ? inFlight.promise.then(() => null, () => null) : Promise.resolve(null);
  }

  return { pause, resume, settled, isPaused: () => interactivePaused, takeResume: () => { const r = lastResume; lastResume = null; return r; } };
}

module.exports = { createRunPauseControl };
