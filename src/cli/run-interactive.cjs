'use strict';
// run-interactive.cjs — the interactive-only helpers of `belay run` (ADR 0037), split out of cmd-run.cjs to
// keep that file under its line budget. Mode selection and its refusals, the console object the close can
// see, the mode-aware clean-exit test, the embedder-failure handling an interactive run has (no run pause
// exists in wave 1, so a failure that would pause stops), and the fast close's deadline. Nothing here
// touches the store or a process.

const { TIMED_OUT } = require('../run/orchestrator-interactive.cjs');

const INTERACTIVE_MARKER = '<!-- belay-mode: interactive -->';
const INTERACTIVE_PROMPT = 'src/run/prompts/orchestrator-interactive.md';
const MODES = ['headless', 'interactive'];
const MAX_INTERACTIVE_MCP_TOOL_TIMEOUT_MS = 120000; // decision 8: at 120 s an interactive session backgrounds a running call
const DEFAULT_SURFACE_MS = 15000;
const FAST_CLOSE_ENDED_BY = 'console closed (fast close)';
const FAST_RESERVE_MS = 1300; // decision 6: the kills and the worker close are cut this long before the 3500 ms budget ends
const END_RESERVE_MS = 600; // the review count, run.end and run.get are cut here, which leaves >= 500 ms for the owner shutdown and run.json
const SHUTDOWN_RESERVE_MS = 200; // the owner shutdown is cut here: only the run.json write is left (the shutdown gets END - SHUTDOWN = 400 ms, the two together 600)
const PAUSE_NOTE = 'pause unavailable interactively; stopped instead';

// The refusal path never got far enough to know any of this about a process it never spawned.
function emptyOrchestratorBlock() {
  return {
    pid: null, session_id: null, model: null, turns: null, externally_triggered_turns: null,
    exit_code: null, exit_signal: null, argv_hash: null, ready_ms: null, later_inits: null,
    killed_after_close: null, usage: null,
    surface: null, instructions: null, // the filled block carries both (ADR 0024, S2 fix round F4)
  };
}

// `--interactive` is the one flag this command takes beyond --effort; what is left is the spec path.
function takeFlag(argv) {
  const rest = [];
  let interactive = false;
  for (const a of argv) { if (a === '--interactive') interactive = true; else rest.push(a); }
  return { rest, interactive };
}

// Spec keys `mode`, `interactive_surface_ms` and `fullscreen`; `{ error }` or `{ fields }`.
function parseModeKeys(spec) {
  const mode = spec.mode === undefined ? 'headless' : spec.mode;
  if (!MODES.includes(mode)) return { error: `mode must be one of ${MODES.join(', ')}; got ${JSON.stringify(mode)}` };
  // A number only: Number(true) is 1 and Number('5') is 5, and neither is an integer the operator wrote.
  const posInt = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
  const ms = spec.interactive_surface_ms === undefined ? DEFAULT_SURFACE_MS : spec.interactive_surface_ms;
  if (!posInt(ms)) return { error: 'interactive_surface_ms must be a positive integer' };
  // `fullscreen` (interactive only, default true): CLAUDE_CODE_NO_FLICKER=1, or 0, in the orchestrator's own env.
  if (spec.fullscreen !== undefined && typeof spec.fullscreen !== 'boolean') return { error: 'fullscreen must be true or false' };
  return { fields: { mode, interactive_surface_ms: ms, fullscreen: spec.fullscreen === undefined ? true : spec.fullscreen, fullscreen_set: spec.fullscreen !== undefined } };
}

// The marker is a line of its own, never a substring of prose that quotes it.
const hasMarker = (text) => String(text).split(/\r?\n/).some((l) => l.trim() === INTERACTIVE_MARKER);

// Decisions 4 and 8: refused before the data dir exists or a process starts. Null for a headless run.
function refusal(mode, parsed) {
  if (mode !== 'interactive') {
    return parsed.fullscreen_set ? 'fullscreen is an interactive key: a headless orchestrator has no screen; drop it or run with --interactive' : null;
  }
  if (parsed.timeout_ms > 0) {
    return `an interactive run takes no timeout_ms: nothing in an interactive run enforces a run timeout, and the prompt must not promise one; got ${parsed.timeout_ms} (ADR 0037)`;
  }
  if (parsed.mcp_tool_timeout_ms > MAX_INTERACTIVE_MCP_TOOL_TIMEOUT_MS) {
    return `an interactive run needs mcp_tool_timeout_ms of at most ${MAX_INTERACTIVE_MCP_TOOL_TIMEOUT_MS}: at 120 s an interactive session moves a running call to the background whatever the variable says (ADR 0037 decision 8); got ${parsed.mcp_tool_timeout_ms}`;
  }
  if (!hasMarker(parsed.promptText)) {
    return `an interactive run needs an interactive prompt: ${parsed.promptFile} lacks the line ${INTERACTIVE_MARKER}; start from ${INTERACTIVE_PROMPT} (ADR 0037 decision 4)`;
  }
  return null;
}

// Where the operator-facing preamble goes: stdout unless --json owns it, then stderr.
const printer = (ctx) => (ctx.emit || ((t) => process.stderr.write(t)));

// ADR 0037 decision 6: with a SIGHUP recorded, the close is the fast one and `ended_by` says so. Idempotent;
// called after the loop returns, again once the close has run, and once more before the receipt, since a SIGHUP
// may arrive during any of them. An earlier failure cause (a gate failure, a refused attach, a stop) is chained,
// never overwritten: `<cause>; then console closed (fast close)`.
function applyConsole(partial, ce) {
  // The receipt's console events are the ones recorded so far, including any that arrived during the close.
  if (partial && ce && partial.orchestrator && partial.orchestrator.interactive) partial.orchestrator.interactive.console_events = ce.events.slice();
  if (!partial || !ce || !ce.hupSeen() || partial.fast_close) return;
  partial.fast_close = true;
  partial.ended_by = partial.primary_cause ? `${partial.primary_cause}; then ${FAST_CLOSE_ENDED_BY}` : FAST_CLOSE_ENDED_BY;
}

// Headless: the stdin-close rule ended the run. Interactive: claude exited 0 with a proven (or not-reached)
// surface, no fast close and a completed close (decision 6, L2).
function endedCleanly(mode, partial, closed = true) {
  if (!partial) return false;
  if (mode === 'interactive') return partial.interactive_clean === true && partial.fast_close !== true && !!closed;
  return /stdin closed/.test(partial.ended_by);
}

// Awaits `p`. Headless (no console): plain. Interactive with a SIGHUP recorded: cut at the fast close's budget less
// `reserve`; then `onLate(message)` is told and `fallback` returned (the work may still be running behind it).
async function within(ce, p, what, fallback, onLate, reserve = FAST_RESERVE_MS) {
  if (!ce) return p;
  const v = await ce.bound(p, reserve);
  if (v !== TIMED_OUT) return v;
  onLate(`fast close deadline passed during ${what}`);
  return fallback;
}

// The fast close's view of the console for the worker close (ADR 0039): the budget, and the SIGHUP's snapshot.
const fastOf = (ce) => (ce ? { requested: ce.hupSeen, leftMs: () => ce.leftMs(FAST_RESERVE_MS), snapshot: ce.snapshot, snapshotPending: ce.snapshotPending } : null);

// The run's one worker close: `run()` is called by the CLI after the loop, and by the loop itself at a fast close,
// before the gate collect (ce.setEarlyClose); both get the same promise. `enabled()` false: no close at all (null).
function onceClose(ce, run, enabled) {
  let p = null;
  const get = () => { if (!p && enabled()) p = Promise.resolve().then(run); return p || Promise.resolve(null); }; // a disabled call is not remembered
  if (ce) ce.setEarlyClose(() => (enabled() ? get() : null), FAST_RESERVE_MS);
  return get;
}

// The close's last records, in one place so cmd-run.cjs stays under its line budget: the review-round count (ADR 0031
// decision 6), run.end, then run.get. Each is bounded by the fast close's budget when there is one (F7); a cut count
// says so and is not "never attached". Failures come back as `errors` ({ what, msg }) for the caller to chain.
async function endRun({ core, ce, runId, exitReason, usage, reviewRounds, countReviewRounds, late }) {
  const out = { reviewRounds, endedRow: null, gotRun: null, errors: [] };
  const err = (what, e) => out.errors.push({ what, msg: (e && e.message) || String(e) });
  out.reviewRounds = await within(ce, countReviewRounds(core, runId), 'the review-round count', { value: null, reason: 'not counted: fast-close budget' }, late, END_RESERVE_MS);
  try { out.endedRow = await within(ce, core.run.end({ exit_reason: exitReason, usage }), 'run.end', null, late, END_RESERVE_MS); } catch (e) { err('run.end', e); }
  if (out.endedRow) {
    try { out.gotRun = await within(ce, core.run.get(), 'run.get', null, late, END_RESERVE_MS); } catch (e) { err('run.get', e); }
  }
  return out;
}

// ADR 0034 in an interactive run. Wave 1 has no run pause, so a failure that asks for a pause stops the run, by the
// existing stop (claude's exact pid), and the receipt says so. One stop serves a burst; a refused one is retried.
function interactiveEmbedder(stopRun) {
  let p = null;
  return {
    pauseRun: (why) => {
      if (!p) { p = Promise.resolve().then(() => stopRun(`${why}: ${PAUSE_NOTE}; stdin closed`)); p.catch(() => { p = null; }); }
      return p.then(() => ({ already: false }));
    },
    // The guard records a pause; here it was a stop. Rewritten so the receipt never claims a pause.
    // A stop still in flight when the fast close cut the wait has neither result: it is recorded as requested, not confirmed.
    annotate: (events) => events.map((e) => {
      if (e.pause) return { ...e, action: 'stop', pause: null, stop: e.pause.ok ? { ok: true } : { ok: false, error: e.pause.error }, note: PAUSE_NOTE };
      if ((e.action === 'pause' || e.action === 'stop') && !e.stop) return { ...e, action: 'stop', pause: null, stop: null, stop_pending: true, note: PAUSE_NOTE };
      return e;
    }),
  };
}

// ADR 0034: the warm-up's load time, and every embedder failure the run met with what was done about it.
function embedderLines(receipt) {
  const out = [];
  const em = receipt.embedder;
  if (em && em.ok && em.skipped) out.push(`embedder: warm-up skipped (${em.skipped})`);
  else if (em && em.ok) out.push(`embedder: warmed in ${em.warm_ms} ms (model load ${em.load_ms === null ? 'unrecorded' : `${em.load_ms} ms`})`);
  else if (em) out.push(`embedder: warm-up FAILED, ${em.code}: ${em.message}; fix: ${em.fix}`);
  for (const f of receipt.embedder_failures || []) {
    const ended = f.note ? `${f.note}: run ended` : 'run ended (cannot be fixed inside a run)'; // `note`: an interactive run's pause became a stop
    let p;
    if (f.stop && f.stop.ok) p = ended;
    else if (f.stop && (f.note || receipt.mode === 'interactive') && /already exited/.test(String(f.stop.error))) p = 'nothing left to stop: claude had already exited'; // the run was over; the stop had no target
    else if (f.stop) p = `run NOT ended: ${f.stop.error}`;
    else if (f.stop_pending) p = 'stop requested, not confirmed: the fast close cut the wait'; // F8: this run did not "continue"
    else if (f.pause) p = f.pause.ok ? 'run paused' : `run NOT paused: ${f.pause.error}`;
    else p = 'run continued';
    out.push(`embedder failure: ${f.worker}, ${f.call}, ${f.code}${f.cause ? ` (${f.cause})` : ''}; ${p}`);
  }
  return out;
}

// Interactive exit code: a failure under `stop` is never a clean exit, whether or not the stop landed.
const embedderUnsafe = (mode, levers, events) => mode === 'interactive' && levers.on_embedder_failure === 'required' && events.length > 0;

module.exports = {
  INTERACTIVE_MARKER, INTERACTIVE_PROMPT, FAST_CLOSE_ENDED_BY, FAST_RESERVE_MS, END_RESERVE_MS, SHUTDOWN_RESERVE_MS, PAUSE_NOTE, endRun, emptyOrchestratorBlock, takeFlag, parseModeKeys,
  refusal, printer, applyConsole, endedCleanly, within, interactiveEmbedder, embedderUnsafe, hasMarker, embedderLines, fastOf, onceClose,
};
