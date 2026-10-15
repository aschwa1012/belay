'use strict';
// cmd-run.cjs — CLI slice, mode W + becomes owner and control server. The contract is in
// src/cli/belay.cjs: run(ctx) -> { code, text, json }, never printing, never calling process.exit.
//
// Build step 5a spawns the headless orchestrator and holds its stdin; 5a-2 fixes the election,
// becomeOwner() before any write. 5a-3 closes what 5a-2
// left open: becomeOwner() held no referenced handle (a retry could empty the loop and exit 0 having
// written nothing); its rejection fell through with no receipt; a run.end/run.get/shutdownOwner
// failure after a clean loop return was silently discarded. Owns arg/spec parsing, data-dir
// resolution, opening the core, electing, calling src/run/orchestrator.cjs's loop, then ending the
// run and shutting the owner down. Never writes to the orchestrator's stdin itself.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const C = require('./config.cjs');
const L = require('../run/launch.cjs');
const { runOrchestrator } = require('../run/orchestrator.cjs');
const { runInteractiveOrchestrator, makeConsole } = require('../run/orchestrator-interactive.cjs');
const RI = require('./run-interactive.cjs'); // ADR 0037: interactive mode's CLI helpers
const { createStopControl } = require('../run/stop.cjs');
const { createRunPauseControl } = require('../run/run-pause.cjs');
const { callWorkerAdapter, pauseBoundMs, resumeBoundMs } = require('./adapter-pipe.cjs');
const { closeRunWorkers, workersClosedBlock } = require('./run-close.cjs');
const { warmEmbedder, createEmbedderGuard } = require('../run/embedder-guard.cjs');
const { RESUME_WARM_MS } = require('./embedder-bounds.cjs');
const { attachMemory, memoryText, substituteLevers, countReviewRounds } = require('./run-levers.cjs');

const fwd = (p) => String(p).split('\\').join('/');

// BELAY_FAKE_CORE (test-only): same confinement as src/mcp/belay-mcp.cjs's own use of it — resolved
// at module load, refused unless it names a fixture under this repo's tests/.
const REPO_TESTS = `${path.resolve(__dirname, '..', '..').split('\\').join('/')}/tests/`;
function resolveOpenCore() {
  const raw = process.env.BELAY_FAKE_CORE;
  if (!raw) return require('../core/index.cjs').openCore;
  const resolved = path.resolve(raw).split('\\').join('/');
  if (!resolved.startsWith(REPO_TESTS)) throw new Error(`BELAY_FAKE_CORE must name a fixture under ${REPO_TESTS}, got ${resolved}`);
  return require(resolved).openCore;
}
const openCore = resolveOpenCore();

function usageError(message) {
  return {
    code: 2,
    text: `belay run: ${message}\n\nusage: belay run <spec.json> [--interactive] [--effort <level>] [--data <dir>] [--json]\n`,
    json: { error: message },
  };
}

const { parseSpec } = require('./run-spec.cjs'); // the spec's keys and their checks
const { runCloseStages } = require('./run-close-stages.cjs'); // the scrubber and the archive reviewer, after the workers close and before run.end
const { memoryRunEnd } = require('./run-memory-end.cjs'); // ADR 0043 decision 2: the run-end memory jobs, after the adapter

// 5a-4 item 4: the two no-write paths (a refusal, an election failure) return before run.json is ever
// attempted, so the old unconditional last line told an operator to go read a receipt that was never
// written, in a directory that was never created. `receipt.receipt_path` is the path written, or
// `null`, and the line prints only when it is not.
function renderText(receipt) {
  const lines = [
    `run_id: ${receipt.run_id}`,
    `orchestrator pid ${receipt.orchestrator.pid}, session ${receipt.orchestrator.session_id}, ${receipt.orchestrator.turns} turn(s)`,
    `ended_by: ${receipt.ended_by}`,
    `exit_code: ${receipt.orchestrator.exit_code}`,
    `holds: ${receipt.holds.length}`,
    `polls: ${receipt.polls}`,
  ];
  if (receipt.mode === 'interactive') lines.splice(1, 0, `mode: ${receipt.mode}`); // the headless text is unchanged
  // 5c: named only when a `belay stop` actually ended this run — the operator's proof that the CLI
  // exit they are looking at was an intervention, not the orchestrator ending on its own.
  if (receipt.stop) lines.push(`stopped by: pid ${receipt.stop.caller_pid}`);
  // ADR 0029: named only when the run itself closed a worker row or killed a process.
  const wc = receipt.workers_closed;
  if (wc && (wc.killed.length || (wc.marked_dead || []).length)) {
    lines.push(`workers closed: ${wc.killed.length} killed, ${(wc.marked_dead || []).length} marked dead`);
  }
  if (receipt.mode === 'interactive' && wc && (wc.left_parked || []).length) lines.push(`left parked: ${wc.left_parked.join(', ')}`); // ADR 0023 amendment 5
  const pl = receipt.mode === 'interactive' && receipt.orchestrator && receipt.orchestrator.interactive && receipt.orchestrator.interactive.plugin;
  if (pl && pl.unreadable) lines.push('plugin copy unreadable at exit');
  else if (pl && pl.unchanged === false) lines.push(`plugin copy changed after spawn: ${(pl.changed_files || []).join(', ') || 'unreadable'}`); // ADR 0037 amendment 5 decision 4
  if (receipt.levers) {
    const rr = receipt.review_rounds === null ? `unknown (${receipt.review_rounds_reason})` : receipt.review_rounds;
    lines.push(`levers: max_fix_rounds ${receipt.levers.max_fix_rounds}, fix_cutoff ${receipt.levers.fix_cutoff}, on_embedder_failure ${receipt.levers.on_embedder_failure}${memoryText(receipt.levers)}; review_rounds: ${rr}`);
  }
  lines.push(...RI.embedderLines(receipt));
  if (receipt.receipt_path) lines.push(`receipt: ${receipt.receipt_path}`);
  lines.push('');
  return lines.join('\n');
}

// ADR 0034 decision 1. The one test-only skip: BELAY_TEST_SKIP_EMBEDDER_WARMUP=1, honoured only together with
// BELAY_TEST_MODE=1. BELAY_CLAUDE_EXE is a production override and never skips it.
function warmupSkipped() {
  if (process.env.BELAY_TEST_MODE === '1' && process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP === '1') return 'BELAY_TEST_SKIP_EMBEDDER_WARMUP is set under BELAY_TEST_MODE';
  return null;
}

const { emptyOrchestratorBlock } = RI; // moved whole to run-interactive.cjs for this file's line budget

// ADR 0028 decision 5: `--effort <level>` (or `--effort=<level>`) is the one flag this command takes
// beyond the dispatcher's own; what is left is the positional spec path.
function parseEffort(argv) {
  const rest = [];
  let effort = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--effort' || a.startsWith('--effort=')) {
      const v = a === '--effort' ? argv[i + 1] : a.slice('--effort='.length);
      if (a === '--effort') i += 1;
      if (v === undefined || !L.EFFORT_LEVELS.includes(v)) {
        return { error: `--effort must be one of ${L.EFFORT_LEVELS.join(', ')}; got ${v === undefined ? 'nothing' : JSON.stringify(v)}` };
      }
      effort = v;
      continue;
    }
    rest.push(a);
  }
  return { rest, effort };
}

async function run(ctx) {
  const eff = parseEffort(ctx.argv);
  if (eff.error) return usageError(eff.error);
  const fl = RI.takeFlag(eff.rest);
  if (fl.rest.length !== 1) {
    return usageError(`belay run needs exactly one argument, a path to a spec JSON file; got ${fl.rest.length}`);
  }
  const specPath = fwd(path.resolve(ctx.cwd, fl.rest[0]));
  const found = C.discover(ctx.cwd);
  const parsed = parseSpec(specPath, ctx.cwd, { found, effort: eff.effort });
  if (parsed.error) return usageError(parsed.error);
  eff.effort = parsed.effort; // --effort, else the config's agents.orchestrator.effort; parsed.agentSettings names which
  const mode = fl.interactive ? 'interactive' : parsed.mode; // ADR 0037 decision 1: the flag wins over the spec key
  const modeRefusal = RI.refusal(mode, parsed);
  if (modeRefusal) return usageError(modeRefusal);
  // ADR 0031: the counts say what the orchestrator was actually told; the receipt never claims a cap it was not.
  // An interactive run has no timeout (refused above), so its prompt is told none (L3).
  const sub = mode === 'interactive'
    ? substituteLevers(parsed.promptText, parsed.levers, 0, { mode: 'interactive' })
    : substituteLevers(parsed.promptText, parsed.levers, parsed.timeout_ms);
  parsed.promptText = sub.text;
  parsed.levers.substituted = sub.substituted;
  const ce = mode === 'interactive' ? makeConsole() : null; // decision 6: the close can see a SIGHUP that arrives during it
  require('../run/exe-discovery.cjs').exportConfigured(found, C.effective); // config claude_exe/codex_exe reach every child
  // The orchestrator is always Claude Code: a missing executable exits 1 (a host prerequisite, like the embedder) before any file is created.
  try { require('../run/exe-discovery.cjs').exeFor('claude'); } catch (e) { return { code: 1, text: `belay run: ${e.message}\n`, json: { error: e.message } }; }
  const dataDir = C.dataDirOf(found, ctx);
  const orchestratorDir = parsed.orchestratorDirRaw || fwd(path.join(os.tmpdir(), 'belay-run', parsed.runId));
  if (orchestratorDir === dataDir || orchestratorDir.startsWith(`${dataDir}/`)) {
    return usageError(`orchestrator_dir ${orchestratorDir} must not be inside the data dir ${dataDir} (api.md §1)`);
  }

  // Mode W: the data dir is created here, once every usage error above has already returned.
  fs.mkdirSync(dataDir, { recursive: true });

  const t0 = Date.now();
  // 5c design item 5: `stopControl` is a `let` bound only after openCore, so the arrow below is
  // late-bound — no owner exists until the election, and the election has not even started here, so
  // no control can arrive before `stopControl` is assigned two lines down.
  // 6f, ADR 0023 amendment 3 decision 4: `runPauseControl` (src/run/run-pause.cjs) joins it the same
  // way, registered as `run.pause`/`run.resume`. `hookBox` is the one `{ pid, exited, stop, pause,
  // resume }` object orchestrator.cjs attaches once the child is spawned; both controls need it, so
  // the `attach` handed to `runOrchestrator` (below) fans out to both instead of `stopControl` alone.
  let stopControl, runPauseControl, guard;
  const hookBox = {};
  const core = await openCore({
    dataDir, caller: { role: 'operator', run_id: parsed.runId, pid: process.pid },
    ownerOpts: {
      controls: {
        'run.stop': (params) => stopControl.handle(params),
        // ADR 0023 amendment 5: an interactive run registers them too; its pause parks the workers and leaves the session alone
        'run.pause': (params) => runPauseControl.pause(params), 'run.resume': (params) => runPauseControl.resume(params),
      },
      onEmbedderFailure: (ev) => guard.onFailure(ev),
      // read by memory.embedQuery and the owner's engine at each call, so the run manager knows what a failure means, and an
      // operator's choice at a resume (belay resume --embedder keyword|off) takes effect at once
      embedderMode: () => guard.mode(), memoryOff: () => guard.memoryOff(), runEnding: () => !!guard.fatal(),
    },
  });
  stopControl = createStopControl({
    runId: parsed.runId, core, closeGraceMs: parsed.close_grace_ms,
    pauseSettled: () => runPauseControl.settled(),
  });
  runPauseControl = createRunPauseControl({
    runId: parsed.runId, core, hook: hookBox, stopInFlight: () => stopControl.stopping(), interactive: !!ce,
    // ADR 0034 decision 2: resuming an embedder-failure pause re-attempts the load; a load that still fails keeps the run paused.
    // ADR 0034 amendment 1: the operator may choose at the resume (params.embedder): keyword or off. The choice sets the run's mode here
    // and the resume goes ahead without re-loading the model; with no choice the model is re-loaded, and a load that still fails keeps
    // the run paused.
    beforeResume: async (row, params) => {
      if (!/embedder-failure [(]/.test(row.paused_by || '')) return;
      const choice = params && params.embedder != null ? require('../core/embedder-mode.cjs').normalize(params.embedder) : null;
      if (params && params.embedder != null && (choice === null || choice === 'required')) {
        const e = new Error('run.resume embedder must be keyword or off (or leave it out to stay on required and re-load the model)');
        e.code = 'E_ARGS';
        throw e;
      }
      if (choice) { guard.setMode(choice); return; }
      const w = await warmEmbedder(core, { retry: true, timeoutMs: RESUME_WARM_MS });
      if (!w.ok) {
        const e = new Error(`the embedder still cannot load, so the run stays paused: ${w.code}: ${w.message}; fix: ${w.fix}`);
        e.code = w.code === 'E_INTERNAL' ? 'E_INTERNAL' : w.code;
        e.detail = { embedder: true, still_paused: true };
        throw e;
      }
    },
    pauseWorker: (workerId, caller, reason) => callWorkerAdapter(core, dataDir, {
      workerId, method: 'worker.pause', params: { worker_id: workerId, caller, ...(reason ? { reason } : {}) }, boundMs: pauseBoundMs(),
    }),
    resumeWorker: (workerId, caller) => callWorkerAdapter(core, dataDir, {
      workerId, method: 'worker.resume', params: { worker_id: workerId, caller }, boundMs: resumeBoundMs(),
    }),
  });
  const opCaller = { role: 'operator', run_id: parsed.runId, pid: process.pid };
  const stopRun = (why) => stopControl.handle({ run_id: parsed.runId, caller: opCaller }, why);
  guard = createEmbedderGuard({
    mode: parsed.levers.on_embedder_failure, stopRun, interactive: !!ce, // an interactive run is never ended by an embedder failure: it pauses (ADR 0034 amendment 2)
    pauseRun: (why) => runPauseControl.pause({ run_id: parsed.runId, caller: opCaller }, why),
  });
  if (ce && ctx.interactiveDeps && ctx.interactiveDeps.onGuard) ctx.interactiveDeps.onGuard(guard); // test seam
  const attachHook = { attach: (h) => { stopControl.attach(h); Object.assign(hookBox, h); } };

  // Step 2 (5a-2 design): elect before any write, any file under orchestrator_dir, or any process
  // spawned. A refusal here has made no write of any kind.
  //
  // 5a-3 item 1 (blocking): Client.connect's retry sleep is unref'd (src/core/client.cjs:17), and at
  // this point the process holds no other referenced handle. On a retry the event loop could empty
  // mid-`await` and the process would exit 0 having written nothing. This referenced no-op interval
  // spans the call so the process cannot exit while the election is still deciding.
  const electionKeepAlive = setInterval(() => {}, 1000);
  let became = null;
  let electionError = null;
  try { became = await core.becomeOwner(); }
  catch (e) { electionError = e; }
  finally { clearInterval(electionKeepAlive); }

  // 5a-3 item 2 (should-fix): a rejection here (the store itself unopenable, not a live-owner
  // refusal) used to fall through to belay.cjs's one-line catch with no receipt at all.
  const refusal = (endedBy, ownerPid, establishedBy) => ({
    run_id: parsed.runId, mode, data_dir: dataDir, spec_path: specPath, orchestrator_dir: orchestratorDir,
    orchestrator: emptyOrchestratorBlock(),
    store: { owner_pid: ownerPid, attach: null, ended: null, shutdown: null, established_by: establishedBy },
    ended_by: endedBy, holds: [], polls: 0, wakes: [], wakes_suppressed: [], wakes_expired: [],
    wakes_held: [], pauses: [], stop: null, workers_closed: null,
    levers: parsed.levers, agent_settings: parsed.agentSettings, embedder: null, embedder_failures: [], review_rounds: null, review_rounds_reason: 'the run never started', ms: Date.now() - t0, receipt_path: null,
  });
  if (electionError) {
    await core.close().catch(() => {});
    const endedBy = `the election failed: ${electionError.code || 'E_UNKNOWN'}: ${electionError.message || String(electionError)}`;
    const receipt = refusal(endedBy, null, endedBy);
    return { code: 1, text: renderText(receipt), json: receipt };
  }
  if (!became.owner) {
    await core.close();
    const endedBy = `this process did not become the store owner for the run, so it refuses to hold the orchestrator: pid ${became.pid} already holds it`;
    const receipt = refusal(endedBy, became.pid, became.established_by);
    return { code: 1, text: renderText(receipt), json: receipt };
  }

  // ADR 0034 decision 1: the model is loaded and its canary passed before the orchestrator or any worker exists,
  // so a run never starts on a host that cannot do what its memory tools promise. Nothing has been written.
  const skipped = warmupSkipped();
  const warm = skipped ? { ok: true, skipped } : await warmEmbedder(core);
  // ADR 0034 amendment 1: under required a warm-up that fails refuses the run (as before); under keyword or off the run starts in that
  // mode and the failure is recorded as the run's first embedder event.
  if (!warm.ok && guard.mode() !== 'required') {
    guard.noteWarmFailure(warm);
    warm.proceeded_as = guard.mode();
  }
  if (!warm.ok && guard.mode() === 'required') {
    let sd = null;
    try { sd = await core.shutdownOwner(); } catch (e) { sd = { error: (e && e.message) || String(e) }; }
    const endedBy = `the embedder could not be warmed, so the run did not start: ${warm.code}: ${warm.message}; fix: ${warm.fix}`;
    const receipt = refusal(endedBy, process.pid, 'embedder warm-up failed before any spawn');
    receipt.embedder = warm;
    receipt.store.shutdown = sd;
    return { code: 1, text: renderText(receipt), json: receipt };
  }

  // Step 5 (5a-2 design): run.attach is an in-process write by the owner; it cannot land on another
  // owner. `attachRow` stays null only if the write itself rejects.
  let attachRow = null;
  const RID = require('./run-identity.cjs').createRunIdentity(process.pid);
  async function onAttached({ pid }) {
    try {
      RID.watchOrchestrator(pid); // ADR 0039: run-identity.cjs; the attach never waits on a snapshot
      attachRow = await core.run.attach({ adapter_pid: process.pid, adapter_pid_created: await RID.ownNow(), orchestrator_pid: pid, orch_effort_requested: eff.effort, max_fix_rounds: parsed.levers.max_fix_rounds, project_dir: found.found ? found.dir : C.writeDirOf(ctx.cwd), ...attachMemory(parsed.levers) });
      return { ok: true, attach: attachRow };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }

  // Everything from here to shutdownOwner() runs inside a `finally`, unconditionally, and every step
  // is caught rather than left to propagate (5a-2's blocking fix): a throw becomes `crashedBy` and a
  // full receipt, exit 1. 5a-3 item 2 (should-fix): that left `crashedBy` discarded whenever the loop
  // itself returned cleanly — a run.end/run.get/shutdownOwner failure AFTER a clean run reported exit
  // 0 with the happy stdin-close sentence and no mention that a write failed. `postFailure` is that
  // case, chained onto `partial.ended_by` rather than replacing it, and it always forces exit 1.
  const chain = (prev, what, msg) => (prev ? `${prev}; then ${what}: ${msg}` : `${what}: ${msg}`);
  let partial = null;
  let crashedBy = null;
  let postFailure = null;
  let endedRow = null;
  let gotRun = null;
  let shutdown = null;
  let stopReceipt = null;
  let closed = null;
  let memoryEnd = null;
  let closeStages = null;
  let reviewRounds = { value: null, reason: 'the run was never attached, so no tasks were read' };
  // ADR 0039 follow-up: one worker close (ADR 0029); a fast close runs it inside the loop, before the gate collect.
  const workerClose = RI.onceClose(ce, () => ((ctx.interactiveDeps && ctx.interactiveDeps.closeRunWorkers) || closeRunWorkers)({ core, runId: parsed.runId, graceMs: parsed.close_grace_ms, fast: RI.fastOf(ce) }), () => !!attachRow);
  try {
    try {
      partial = await (ce ? runInteractiveOrchestrator : runOrchestrator)({
        core, runId: parsed.runId, dataDir,
        spec: {
          worktree: parsed.worktree, promptText: parsed.promptText, orchestratorDir,
          model: parsed.model, allowedTools: parsed.allowedTools, effort: eff.effort, agentDefaults: parsed.agentDefaults,
          startupTimeoutMs: parsed.startup_timeout_ms, timeoutMs: parsed.timeout_ms,
          mcpToolTimeoutMs: parsed.mcp_tool_timeout_ms, pollMs: parsed.poll_ms,
          closeGraceMs: parsed.close_grace_ms, compactAtTokens: parsed.levers.compact_at_tokens, // ADR 0007 decision 3
          interactiveSurfaceMs: parsed.interactive_surface_ms, fullscreen: parsed.fullscreen,
          knowledgeAgent: !!(parsed.levers.memory_levers && parsed.levers.memory_levers.knowledge_agent),
          notes: !!(parsed.levers.memory_levers && parsed.levers.memory_levers.notes), // wave 4: the refuted-note wake reads receipts only for a notes run
        },
        onAttached, stopControl: attachHook, console: ce, print: RI.printer(ctx), deps: ctx.interactiveDeps,
        wakeRelease: ce ? () => runPauseControl.takeResume() : undefined,
        wakeHeld: ce ? () => runPauseControl.isPaused() : undefined, // ADR 0037 amendment 5 decision 6: a run pause holds the wakes
      });
    } catch (e) {
      crashedBy = `belay run crashed before the orchestrator loop returned: ${(e && e.message) || String(e)}`;
    }

    // 5c design item 5: wait for any in-flight `belay stop`'s worker phase and flushed reply before
    // this process stops being the owner. Resolves at once (with null) when no stop was ever requested.
    // Decision 6 (L9): once a SIGHUP is recorded every wait below is cut to the time left, in this order:
    // the kills, run.end, the owner shutdown, run.json. Headless (no console) awaits plainly.
    const late = (m) => { postFailure = chain(postFailure, 'fast close', m); };
    stopReceipt = await RI.within(ce, stopControl.settled(), 'the stop', null, late);
    RI.applyConsole(partial, ce);
    await RI.within(ce, guard.settled(), "the embedder guard's pending stop", undefined, late); // ADR 0034: a failure's stop still in flight is part of the receipt

    // Step 9 (5a-2 design): run.end only when an attach landed a row; then run.get(), taking the
    // ended block from the row it returns. Each write is caught on its own.
    if (attachRow) {
      // ADR 0029 decisions 3 and 4: the orchestrator's adapter is waited for, and any worker still alive is
      // stopped by its exact pid, before run.end closes the rows. A failure here is named, never fatal to
      // the end itself; a pid still alive after its kill forces exit 1.
      const failClose = (msg) => {
        if (partial) postFailure = chain(postFailure, 'worker close', msg);
        else crashedBy = chain(crashedBy, 'worker close', msg);
      };
      try {
        closed = await RI.within(ce, workerClose(), "the run's worker close", null, failClose); // interactiveDeps.closeRunWorkers: the test seam
        if (closed && closed.errors.length) {
          failClose(`could not look at the run's workers, so none was waited for or stopped: ${closed.errors.join('; ')}`);
        }
        if (closed && closed.still_alive.length) {
          failClose(closed.still_alive.map((w) => `worker ${w.worker_id} pid ${w.pid} is still alive after its kill${w.manual ? ` (${w.manual})` : ''}`).join(', '));
        }
      } catch (e) { failClose((e && e.message) || String(e)); }
      RI.applyConsole(partial, ce); // a SIGHUP during the close
      // Ctrl-C (SIGINT, SIGBREAK on Windows) during the stages is a console close: no stage spawns, a running child is killed by its exact pid.
      let interrupted = false;
      const onInterrupt = () => { interrupted = true; };
      for (const sig of ['SIGINT', 'SIGBREAK']) process.on(sig, onInterrupt);
      try { closeStages = await runCloseStages({ core, runId: parsed.runId, levers: parsed.levers, dataDir, worktree: parsed.worktree, goal: parsed.promptText, ce, late, stages: ctx.closeStagesModule, deps: ctx.closeStagesDeps, log: (m) => RI.printer(ctx)(`${m}\n`), interrupted: () => interrupted });
        const survivors = [...['scrub', 'review'].map((k) => closeStages && closeStages[k] && closeStages[k].survivor), ...((closeStages && closeStages.survivors) || [])].filter(Boolean);
        if (survivors.length) failClose(`a run-close stage child (pid ${survivors.join(', ')}) is still alive after its kill`); } catch (e) { closeStages = { error: (e && e.message) || String(e) }; } finally { for (const sig of ['SIGINT', 'SIGBREAK']) process.off(sig, onInterrupt); } // never the run's failure
      const er = await RI.endRun({
        core, ce, runId: parsed.runId, exitReason: partial ? partial.ended_by : crashedBy, usage: partial ? partial.orchestrator.usage : null,
        reviewRounds, countReviewRounds, late,
      });
      ({ reviewRounds, endedRow, gotRun } = er);
      for (const x of er.errors) { // a failed write after a returned loop is chained, never the cause; without a loop it is the crash
        if (partial) postFailure = chain(postFailure, x.what, x.msg);
        else if (!crashedBy) crashedBy = `belay run crashed while ending the run: ${x.msg}`;
      }
      // The adapter has closed and run.end has settled the rows; this process still owns the store.
      memoryEnd = await memoryRunEnd({ core, runId: parsed.runId, levers: parsed.levers, ce, late: (m) => { postFailure = chain(postFailure, 'fast close', m); } });
    }
  } finally {
    // shutdownOwner() on every path this far, because becomeOwner's owner: true still stands.
    // owner.lock must be gone on every one of those. A failure here is named in store.shutdown.
    //
    // 5a-4 item 2: this used to also reach into the owner's undocumented internals directly and
    // release owner.lock itself when shutdownOwner() rejected — the only way api.md §1 and CLAUDE.md's
    // layout permit an owner to be stopped is this one call, so that guarantee now lives inside
    // Owner.stop() itself (src/core/owner.cjs, item 1): it finishes clearing timers, destroying
    // connections, closing the server and releasing the lock even when the store fails to close, and
    // rethrows only once all of that is done. Nothing else is needed here.
    try {
      shutdown = await RI.within(ce, core.shutdownOwner(), 'the owner shutdown', { error: 'cut by the fast close deadline' }, (m) => { postFailure = chain(postFailure, 'fast close', m); }, RI.SHUTDOWN_RESERVE_MS);
    } catch (e) {
      const msg = (e && e.message) || String(e);
      shutdown = { error: msg };
      if (partial) postFailure = chain(postFailure, 'shutdownOwner', msg);
      else if (!crashedBy) crashedBy = `belay run crashed while shutting down the owner: ${msg}`;
    }
  }
  RI.applyConsole(partial, ce); // a SIGHUP during the owner shutdown still counts; the handlers stay until run.json is written

  const endedBlock = gotRun && gotRun.run
    ? { epoch: gotRun.run.epoch, ended_at: gotRun.run.ended_at, exit_reason: gotRun.run.exit_reason }
    : (endedRow ? { epoch: endedRow.epoch, ended_at: endedRow.ended_at, exit_reason: endedRow.exit_reason } : null);
  const storeBlock = {
    owner_pid: process.pid,
    attach: attachRow ? { epoch: attachRow.epoch, reattached: attachRow.reattached } : null,
    ended: endedBlock,
    shutdown,
  };
  const orchestratorBlock = partial ? partial.orchestrator : emptyOrchestratorBlock();
  const endedBy = partial
    ? (postFailure ? `${partial.ended_by}; then ${postFailure}` : partial.ended_by)
    : crashedBy;
  const holds = partial ? partial.holds : [];
  const polls = partial ? partial.polls : 0;
  const wakes = partial ? partial.wakes : [];
  const wakesSuppressed = partial ? partial.wakes_suppressed : [];
  const wakesExpired = partial ? partial.wakes_expired : []; // 5b fix round, finding 2
  // Fix round (6f finding 4): runOrchestrator already returns these (orchestrator.cjs's own `settle`);
  // this receipt was dropping them on the floor, losing what a run pause held and every pause's interrupt.
  const wakesHeld = partial ? partial.wakes_held : [];
  const pauses = partial ? partial.pauses : [];
  // Code 0 only when the run finished (no crash), the stdin-close rule ended it, the child's exit
  // code was 0, the close bound never had to kill it, and nothing after a clean return failed.
  const code = partial
    && !postFailure
    && RI.endedCleanly(mode, partial, closed)
    && partial.orchestrator.exit_code === 0
    && !partial.orchestrator.killed_after_close
    && !guard.fatal() ? 0 : 1; // ADR 0034: a run ended by an embedder failure it could not survive is never a clean exit

  // Index-query embeds that hit their bound (memory.embedQuery's `embed_bound` events): not failures of the model, so not in
  // embedder_failures, but a slow embedder the operator should see at run level.
  let embedBounds = null;
  try { embedBounds = ((await core.memory.events({ run_id: parsed.runId, kinds: ['embed_bound'], limit: 1000 })).events || []).map((e) => ({ at: e.written_at, worker_id: e.worker_id, task_id: e.task_id, detail: e.message })); } catch { /* the receipt still stands without it */ }
  const receiptPath = `${orchestratorDir}/run.json`;
  const receipt = {
    run_id: parsed.runId, mode, data_dir: dataDir, spec_path: specPath, orchestrator_dir: orchestratorDir,
    orchestrator: { ...orchestratorBlock, ...(await RID.orchestratorFacts()) }, store: storeBlock, orch_effort_requested: eff.effort, agent_settings: parsed.agentSettings, // ADR 0028 (SF3); ADR 0039 pid_created
    ended_by: endedBy, holds, polls, wakes, wakes_suppressed: wakesSuppressed, wakes_expired: wakesExpired,
    wakes_held: wakesHeld, pauses,
    stop: stopReceipt, ms: Date.now() - t0, receipt_path: null,
    levers: parsed.levers, on_embedder_failure_final: guard.mode(), memory_off: guard.memoryOff(), embedder: warm, embedder_failures: guard.events(), ...(embedBounds && embedBounds.length ? { embedder_bounds: embedBounds } : {}),
    review_rounds: reviewRounds.value, review_rounds_reason: reviewRounds.reason,
    workers_closed: closed ? workersClosedBlock(closed, endedRow ? (endedRow.workers_marked_dead || []) : null) : null,
    ...(closeStages ? { close_stages: closeStages } : {}), // only with notes on
    ...(memoryEnd ? { memory_run_end: memoryEnd } : {}), // only with a run-end memory lever on
  };
  try {
    fs.writeFileSync(receiptPath, `${JSON.stringify({ ...receipt, receipt_path: receiptPath }, null, 2)}\n`);
    receipt.receipt_path = receiptPath;
  } catch { /* the orchestrator dir may be gone in some edge case; the receipt still returns */ }
  if (ce) ce.dispose(); // after run.json (L8): a SIGHUP while it is written is still recorded, not fatal

  return { code, text: renderText(receipt), json: receipt };
}

module.exports = { run, emptyOrchestratorBlock, renderText };
