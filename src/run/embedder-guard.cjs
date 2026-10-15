'use strict';
// embedder-guard.cjs — ADR 0034. Two things `belay run` does about the embedder: warm it before anything is
// spawned (decision 1), and decide what an embedder failure during the run does (decision 2, the
// `on_embedder_failure` lever). An embedder failure is an error whose detail.embedder is exactly true; the
// message text is never read (the signature is agreed with src/core/embedder.cjs's owner).

const { MODES: ON_FAILURE, normalize: normalizeMode } = require('../core/embedder-mode.cjs'); // required | keyword | off (stop and continue are the old names)
const WARM_TIMEOUT_MS = 600000; // a cold-cache warm-up at the start: nothing else waits yet

const isEmbedderFailure = (e) => !!(e && e.detail && typeof e.detail === 'object' && e.detail.embedder === true);

// What the operator should do, by the error's code and its detail.cause (and detail.phase for a timeout). Never a
// guess at a cause the error does not name.
function fixFor(code, cause, phase) {
  if (code === 'E_MODEL_CHANGED' || cause === 'canary') return 'the store was built with a different embedding model than the one in use, which cannot change inside a run: stop, then run with the store\'s model or a fresh data dir';
  const dead = cause === 'dead';
  if (code === 'E_MODEL_ABSENT' && !dead) return 'run `belay embedder fetch` to put the model in belay\'s cache (or `npm install` for a missing package), then resume or run again';
  if (code === 'E_MODEL_ABSENT') return 'the embedder process exited or cannot be reached; check the host (memory, disk, antivirus), then resume to start a fresh one';
  // memory.warm's own wait limit (E_TIMEOUT, detail.in_process or a pipe call): the CALL ended, the load continues.
  if (code === 'E_TIMEOUT') return 'the wait for the model load ended before the load did, and the load goes on; run `belay resume` (or run again) to wait for it again, and check the host if it keeps happening';
  if (cause === 'op_failed') return 'an embed call failed inside the embedder process (the raw error is in the message); check the host, then resume to start a fresh embedder';
  if (code === 'E_EMBEDDER_TIMEOUT' && phase === 'load') return 'the model load did not finish in its bound (a heavily loaded host); resume or run again when the host is quieter';
  if (code === 'E_EMBEDDER_TIMEOUT') return 'the embedder process hung on a call that it had loaded for; resume to start a fresh one, and check the host';
  return 'see `belay embedder` and `belay doctor` for the embedder\'s own state';
}

// A failure no resume can fix: the store's model is not the one in use (ADR 0034 decision 2).
// The same test fixFor makes: E_MODEL_CHANGED, or any error whose cause is canary.
const isFatal = (e) => !!e && (e.code === 'E_MODEL_CHANGED' || !!(e.detail && e.detail.cause === 'canary'));

// Loads the model in the store owner (this process), canary included, and times it. `core.owner` is the in-process
// owner `becomeOwner()` established. Resolves { ok: true, warm_ms, ... } or { ok: false, code, message, cause, fix }.
async function warmEmbedder(core, { retry = false, timeoutMs = WARM_TIMEOUT_MS } = {}) {
  const owner = core && core.owner;
  if (!owner || typeof owner.getEmbedder !== 'function') {
    return { ok: false, code: 'E_INTERNAL', message: 'this process is not the store owner, so it has no embedder to warm', cause: null, fix: fixFor('E_INTERNAL') };
  }
  const t0 = Date.now();
  try {
    // `retry` is a resume after a failure: the owner's failed load is sticky, so it is discarded (memory.warm's
    // retry, ADR 0034 decision 2) before the load is attempted again.
    // A cold-cache warm-up gets the longest wait memory.warm allows (600 s), since nothing else is waiting yet.
    if (core.memory && typeof core.memory.warm === 'function') await core.memory.warm({ wait: true, timeout_ms: timeoutMs, ...(retry ? { reload: true } : {}) });
    else await owner.getEmbedder();
  } catch (e) {
    const code = (e && e.code) || 'E_INTERNAL';
    return {
      ok: false, code, message: (e && e.message) || String(e),
      cause: (e && e.detail && e.detail.cause) || null, warm_ms: Date.now() - t0,
      fix: fixFor(code, e && e.detail && e.detail.cause, e && e.detail && (e.detail.phase || e.detail.op_phase)),
    };
  }
  const info = owner.embedInfo || {};
  return { ok: true, warm_ms: Date.now() - t0, load_ms: info.load_ms === undefined ? null : info.load_ms, model: info.model || null, pid: info.pid || null };
}

// `pauseRun(why)` is the run pause control's own pause (src/run/run-pause.cjs), never a second mechanism; `why`
// becomes the caller's role there, so the run row and every worker park carry one `paused_by`.
// onFailure is the owner's onEmbedderFailure hook: { caller, by, call, error, worker_id? }; worker_id names the worker a
// run-manager call (memory.embedQuery at a spawn) is for, so paused_by names the call and the worker that hit the failure.
// ADR 0034 amendment 1: `mode` is required (pause loudly), keyword (record, rank by keywords) or off (record, memory off); the old
// names stop and continue are accepted. The mode can change while the run is paused: `setMode` is the operator's choice at a resume
// (`belay resume --embedder keyword|off`). Under `off` the first failure turns the run's memory off (`memoryOff()`), which the owner
// enforces: no memory index and no memory writes.
function createEmbedderGuard({ mode: initialMode, pauseRun, stopRun }) {
  let mode = normalizeMode(initialMode) || 'required';
  let off = false;
  const events = [];
  let fatalReason = null;
  const pending = new Set();
  function onFailure({ caller, by, call, error, worker_id: workerId }) {
    if (!isEmbedderFailure(error)) return undefined;
    const worker = workerId || (caller && caller.worker_id) || by || (caller && caller.role) || null;
    const ev = {
      at: Date.now(), worker, call, code: error.code || null, cause: error.detail.cause || null,
      message: error.message || String(error), action: mode === 'required' ? 'pause' : mode === 'off' ? 'off' : 'continue', pause: null,
    };
    events.push(ev);
    if (mode === 'off') off = true;
    if (mode !== 'required') return undefined;
    if (isFatal(error)) {
      // Resuming can never succeed, so under `stop` the run ends, with the error and why, through the existing stop.
      ev.action = 'stop';
      const stopWhy = `ended by an embedder failure that cannot be fixed inside a run: ${ev.code}: ${ev.message}; ${fixFor(ev.code, ev.cause)}; stdin closed`;
      if (!fatalReason) fatalReason = stopWhy;
      const sp = Promise.resolve()
        .then(() => stopRun(stopWhy))
        .then(() => { ev.stop = { ok: true }; }, (e) => { ev.stop = { ok: false, error: (e && e.message) || String(e) }; });
      pending.add(sp);
      sp.then(() => pending.delete(sp));
      return sp;
    }
    // Every failure asks for the pause. The run pause is idempotent (a paused run answers already: true; one in
    // flight is shared), so a burst is one pause, a pause the run refused is retried by the next failure, and a
    // failure after a resume pauses again.
    const cause = ev.cause ? `, ${ev.cause}` : '';
    const why = `embedder-failure (${worker}, ${call}, ${ev.code}${cause})`;
    const p = Promise.resolve()
      .then(() => pauseRun(why))
      .then((r) => { ev.pause = { ok: true, already: !!(r && r.already) }; },
        (e) => { ev.pause = { ok: false, error: (e && e.message) || String(e) }; });
    pending.add(p);
    p.then(() => pending.delete(p));
    return p;
  }
  // A warm-up that failed under keyword or off: the run starts in that mode, and the failure is an event like any other.
  function noteWarmFailure(warm) {
    const ev = { at: Date.now(), worker: null, call: 'warm-up', code: warm.code || null, cause: warm.cause || null, message: warm.message || '', action: mode === 'off' ? 'off' : 'continue', pause: null };
    events.push(ev);
    if (mode === 'off') off = true;
    return ev;
  }
  function setMode(m) {
    const n = normalizeMode(m);
    if (n === null) throw new Error(`on_embedder_failure must be one of ${ON_FAILURE.join(', ')}`);
    mode = n;
    if (n === 'off') off = true; // choosing off at a resume turns memory off at once
    return n;
  }
  return { onFailure, noteWarmFailure, setMode, mode: () => mode, memoryOff: () => off, fatal: () => fatalReason, events: () => events.map((e) => ({ ...e })), settled: () => Promise.all([...pending]).then(() => undefined) };
}

module.exports = { ON_FAILURE, isFatal, isEmbedderFailure, warmEmbedder, createEmbedderGuard, fixFor };
