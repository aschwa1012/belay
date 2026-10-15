'use strict';
// orchestrator-interactive.cjs — ADR 0037 decisions 1 to 3, 5 to 7 and 9, and amendment 1 item 1.
// The interactive loop: claude runs on the operator's own console (stdio 'inherit', no stdin of ours, no
// stream), so there is no turn count, no wake and no idle-close rule. This process holds the rope: it
// writes the per-run files, spawns claude by the exe resolution headless uses, records console events
// without acting on them, watches the surface gate, and returns the same result block `runOrchestrator`
// does. The close itself (run-close, run.end, owner shutdown, run.json) stays in cmd-run.cjs.
//
// Modules written beside this one are required lazily (never at module top) and are injectable:
//   deps.argv(opts)            default: launch.cjs's orchestratorInteractiveArgv
//   deps.createGate(opts)      default: interactive-surface.cjs's createInteractiveGate (the new contract:
//                              { debugFile, projectsDir, cwd, sessionId, requested, spawnedAt, surfaceMs, settleMs }
//                              -> { debug, session, firstMessage, current(), finalize(), stop() })
//   deps.sessionFilePath(opts) legacy, optional: only passed on to a gate that still wants `sessionFile`
//   deps.killPid / deps.pidAlive   the kill mechanics (default process.cjs), a test seam; no tree kill is used

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const L = require('./launch.cjs');
const P = require('./process.cjs');
const I = require('./instructions.cjs');
const { MIN_CLAUDE_CODE_VERSION } = require('./ready.cjs');

const fwd = (p) => String(p).split('\\').join('/');
const CONSOLE_SIGNALS = ['SIGINT', 'SIGBREAK', 'SIGHUP'];
const GATE_COLLECT_MS = 2500; // how long this loop waits for the gate's halves once it has told the gate to stop
const STOP_KILL_WAIT_MS = 5000; // the exit event after the stop's kill; a lost event must not hold the stop
const STOP_SUFFIX = /; stdin closed$/;
const SNAPSHOT_FRESH_MS = 250; // ADR 0039: a SIGHUP-time snapshot is reused only while it is this young; an older one proves nothing about now
const FAST_CLOSE_BUDGET_MS = 3500; // decision 6: from a recorded SIGHUP the whole remaining close fits in this
const TIMED_OUT = Symbol('fast close deadline');
const PLUGIN_CHECK_MS = 5000; // how often the live copy is re-hashed while claude runs (amendment 5 decision 4)
const EXIT_WAIT_RESERVE_MS = 1800; // after a SIGHUP, the wait for claude's exit is cut this long before the 3500 ms budget ends
const COLLECT_RESERVE_MS = 1300; // after a SIGHUP, the gate collect ends this long before the budget does (the CLI's FAST_RESERVE_MS)
const FAST_UNDECIDED = 'undecided: the console closed and the fast close ended the gate collect after the worker kills';

// Console events (decision 6): the handlers only record. Created by cmd-run so that the close, which runs
// after the loop returns, can see a SIGHUP that arrives during it; disposed there once run.json is written.
function makeConsole() {
  const events = [];
  let hupSeen = false;
  let hupAt = null;
  let hupSnapshot = null; let hupSnapshotAt = 0; let snapDone = true; let snapStartedAt = 0;
  // ADR 0039 follow-up: the run's worker close, registered by cmd-run. A fast close starts it inside the loop, before
  // the gate collect, so the kills get the budget; the CLI awaits the same promise after the loop. Started once.
  let earlyClose = null; let earlyReserve = COLLECT_RESERVE_MS; let early = null;
  const startSnap = () => { snapDone = false; hupSnapshotAt = 0; snapStartedAt = Date.now(); hupSnapshot = P.processSnapshot().then((m) => { hupSnapshotAt = Date.now(); snapDone = true; return m; }); };
  let resolveHup = () => {};
  const whenHup = new Promise((r) => { resolveHup = r; });
  const t0 = Date.now();
  const handlers = [];
  function install() {
    if (handlers.length) return;
    for (const sig of CONSOLE_SIGNALS) {
      const h = () => {
        events.push({ signal: sig, at: new Date().toISOString(), at_ms: Date.now() - t0 });
        if (sig === 'SIGHUP' && !hupSeen) { hupSeen = true; hupAt = Date.now(); startSnap(); resolveHup(true); } // ADR 0039: the identity read for the fast close's kills starts now, not after the orchestrator has closed
      };
      process.on(sig, h);
      handlers.push([sig, h]);
    }
  }
  function dispose() {
    for (const [sig, h] of handlers.splice(0)) process.off(sig, h);
  }
  // Time left in the fast close's budget, less `reserve` kept for the steps after it; Infinity before a SIGHUP.
  const leftMs = (reserve = 0) => (hupAt === null ? Infinity : Math.max(0, hupAt + FAST_CLOSE_BUDGET_MS - reserve - Date.now()));
  // Races `p` against that budget: resolves TIMED_OUT once a SIGHUP is recorded and the budget is spent.
  function bound(p, reserve = 0) {
    let timer = null;
    let done = false;
    const cut = whenHup.then(() => new Promise((r) => { if (!done) timer = setTimeout(() => r(TIMED_OUT), leftMs(reserve)); }));
    return Promise.race([Promise.resolve(p), cut]).finally(() => { done = true; clearTimeout(timer); });
  }
  const setEarlyClose = (fn, reserve = COLLECT_RESERVE_MS) => { earlyClose = fn; earlyReserve = reserve; };
  const startEarlyClose = () => { if (!early && earlyClose) early = Promise.resolve().then(earlyClose); return early; };
  return { events, install, dispose, setEarlyClose, startEarlyClose, earlyStarted: () => !!early, earlyReserve: () => earlyReserve, hupSeen: () => hupSeen, hupAt: () => hupAt, whenHup, leftMs, bound, snapshot: (since = 0) => { if (!hupSnapshot || snapStartedAt < since || (snapDone && Date.now() - hupSnapshotAt >= SNAPSHOT_FRESH_MS)) startSnap(); return hupSnapshot; },
    // In flight, or taken within 250 ms: usable for the kills, unless it started before `since` (the last signal this
    // process sent: it may show a process that has died since). refreshSnapshot starts a new one once the old is stale.
    snapshotPending: (since = 0) => snapStartedAt >= since && (!snapDone || (!!hupSnapshot && Date.now() - hupSnapshotAt < SNAPSHOT_FRESH_MS)), refreshSnapshot: () => { if (hupSnapshot && snapDone && Date.now() - hupSnapshotAt >= SNAPSHOT_FRESH_MS) startSnap(); } };
}

// The one system prompt file (decision 3): the spawn-time CLAUDE.md copy, then the run's prompt.
function writeSystemPrompt(dir, instructions, promptText) {
  const parts = [];
  if (instructions && instructions.path) parts.push(fs.readFileSync(instructions.path, 'utf8'));
  parts.push(promptText);
  const file = fwd(path.join(dir, 'system-prompt.md'));
  fs.writeFileSync(file, parts.join('\n\n'));
  return file;
}

// ADR 0037 wave 2: the launch marker src/cli/agents-derive.cjs `modeOf` reads. Written right after the launcher's own
// run.attach (so `epoch` is the row's at that attach), interactive runs only. A failed write is recorded, never thrown.
function writeRunStart(dir, runId, attachRow, startedAt) {
  const file = fwd(path.join(dir, 'run-start.json'));
  try {
    const epoch = attachRow && Number.isInteger(attachRow.epoch) ? attachRow.epoch : null;
    if (epoch === null) throw new Error('the attach returned no epoch');
    fs.writeFileSync(file, `${JSON.stringify({ run_id: runId, epoch, mode: 'interactive', started_at: startedAt, launcher_pid: process.pid })}\n`);
    return { path: file, written: true, error: null };
  } catch (e) { return { path: file, written: false, error: (e && e.message) || String(e) }; }
}

const pick = (o, ...keys) => { for (const k of keys) if (o && o[k] !== undefined) return o[k]; return null; };

// What the launch actually got, read from the gate's facts (session file first, then the debug file).
function actualFacts(results) {
  const sf = (results.session && results.session.facts) || {};
  const df = (results.debug && results.debug.facts) || {};
  const both = (...k) => { const v = pick(sf, ...k); return v === null ? pick(df, ...k) : v; };
  return {
    permission_mode: both('permission_mode', 'permissionMode'),
    version: both('version', 'claude_code_version'),
    effort: both('effort'),
    model: both('model'),
  };
}

// A gate's snapshot ({ debug, session }) filled into `results` where a half has not settled: a stop keeps the
// facts learned so far, and they are never dropped. A settled half is kept; its facts are completed.
function mergeSnapshot(results, snap) {
  if (!snap || typeof snap !== 'object') return;
  for (const name of ['debug', 'session']) {
    const s = snap[name];
    if (!s || typeof s !== 'object') continue;
    const r = results[name];
    if (!r) results[name] = s;
    else if (r.ok === null || r.ok === undefined) results[name] = { ...s, ...r, ok: r.ok === undefined ? s.ok : r.ok, facts: { ...(s.facts || {}), ...(r.facts || {}) } };
    else results[name] = { ...r, facts: { ...(s.facts || {}), ...(r.facts || {}) } };
  }
}

// spec: { worktree, promptText, orchestratorDir, model, allowedTools, effort, mcpToolTimeoutMs,
//         interactiveSurfaceMs, permissionMode?, compactAtTokens }.
// `console` is cmd-run's makeConsole() object; `print` writes to the operator before the handover only.
async function runInteractiveOrchestrator({ core, runId, dataDir, spec, onAttached, stopControl, console: consoleEvents, print = () => {}, deps = {}, wakeHeld = null, wakeRelease = null }) {
  const t0 = Date.now();
  const {
    worktree, promptText, orchestratorDir, model, allowedTools, effort = null, mcpToolTimeoutMs,
    interactiveSurfaceMs = 15000, fullscreen = true, permissionMode = L.DEFAULT_PERMISSION_MODE, compactAtTokens = null, pollMs = 1000,
  } = spec;
  const ce = consoleEvents || makeConsole();
  const setT = deps.setTimeout || setTimeout;
  const clearT = deps.clearTimeout || clearTimeout;
  // Waits for `p` for at most `ms`, and clears its timer the moment `p` settles: a bare sleep() left a 5 s
  // timer alive after the stop and held belay open for it (D3).
  const raceTimer = (p, ms) => {
    let h;
    return Promise.race([p, new Promise((r) => { h = setT(r, ms); })]).finally(() => clearT(h));
  };
  const killPid = deps.killPid || P.killPid;
  const pidAlive = deps.pidAlive || P.pidAlive;

  const written = L.writeOrchestratorFiles({
    dir: orchestratorDir, runId, dataDir, mcpPath: L.mcpServerPath(), settingsPath: L.userSettingsPath(), cwd: worktree, compactAt: compactAtTokens,
    knowledgeAgent: !!spec.knowledgeAgent, // ADR 0043 decision 1: --worktree only with the knowledge agent on
    agentDefaults: spec.agentDefaults || null,
  });
  fs.writeFileSync(path.join(written.dir, 'prompt.txt'), promptText);
  const instructions = I.snapshotInstructions(worktree, written.dir);
  const systemPromptFile = writeSystemPrompt(written.dir, instructions, promptText);
  const sessionId = crypto.randomUUID();
  const debugFile = fwd(path.join(written.dir, 'claude-debug.log'));
  // belay owns this file: a log left by an earlier run in the same orchestrator_dir is stale, not this launch's.
  fs.rmSync(debugFile, { force: true });

  const argvFn = deps.argv || L.orchestratorInteractiveArgv;
  if (typeof argvFn !== 'function') throw new Error('launch.cjs has no orchestratorInteractiveArgv (ADR 0037 decision 2) and none was injected');
  // ADR 0037 amendments 2 and 5: belay's own mod, copied at spawn, its run facts written into the copy from
  // this launcher's own values (invariant 3), hashed before the spawn, and passed as --plugin-dir.
  const PC = require('./plugin-copy.cjs');
  const wakeNonce = crypto.randomBytes(12).toString('hex'); // unpredictable wake pipe name (amendment 5); it rides in the hashed copy
  const plugin = PC.installPlugin({
    src: PC.modSourceDir(), dest: path.join(written.dir, 'plugin'),
    run: {
      role: 'orchestrator', run_id: runId, data_dir: fwd(dataDir), belay_cli: fwd(path.join(__dirname, '..', 'cli', 'belay.cjs')),
      node: fwd(process.execPath), orchestrator_dir: fwd(written.dir), wake_nonce: wakeNonce,
    },
  });
  const argv = argvFn({
    mcpJsonPath: written.mcpJsonPath, settingsPath: written.settingsPath, model, allowedTools, permissionMode,
    appendSystemPromptFile: systemPromptFile, effort, sessionId, debugFile, pluginDir: plugin.dir,
  });
  const { command, prefixArgs } = L.resolveExe(L.claudeExe());
  const fullArgs = [...prefixArgs, ...argv];
  const argvHash = L.writeArgvJson(written.dir, { exe: command, args: fullArgs, cwd: worktree });
  const env = L.buildEnv(process.env, { substrate: 'claude-code', cwd: worktree, mcpToolTimeoutMs });
  // `--setting-sources=` skips the path that turns fullscreen on, so it is forced here, for this session only (workers
  // are headless). An explicit CLAUDE_CODE_NO_FLICKER in belay's own environment wins.
  // buildEnv scrubs the variable (a worker must not inherit it from claude's env), so an explicit value is put back here.
  env.CLAUDE_CODE_NO_FLICKER = process.env.CLAUDE_CODE_NO_FLICKER !== undefined ? process.env.CLAUDE_CODE_NO_FLICKER : (fullscreen ? '1' : '0');
  const altScreen = /^(1|true)$/i.test(String(env.CLAUDE_CODE_NO_FLICKER));

  let surfaceModule = null;
  const surface = () => { surfaceModule = surfaceModule || require('./interactive-surface.cjs'); return surfaceModule; };
  const projectsDir = `${fwd(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'))}/projects`;
  let sessionFile = null; // only a gate of the old contract is handed one; the new gate locates the file by session id
  try {
    const sfp = deps.sessionFilePath || (typeof surface().sessionFilePath === 'function' ? surface().sessionFilePath : null);
    if (sfp) sessionFile = sfp({ cwd: worktree, sessionId, env });
  } catch { sessionFile = null; }
  const gateOpts = {
    debugFile, projectsDir, cwd: worktree, sessionId, sessionFile,
    requested: { model, permissionMode, effort, versionFloor: MIN_CLAUDE_CODE_VERSION, plugin: { name: plugin.name, dir: plugin.dir } },
    spawnedAt: Date.now(), surfaceMs: interactiveSurfaceMs, // settleMs: the gate's own default
  };

  // Everything printed is printed here, before the console is handed over, and never again while claude lives.
  print([
    `belay run ${runId} (interactive)`,
    'Type your first message once Claude Code opens; belay passes no prompt (ADR 0037 decision 3).',
    'If Claude Code asks whether to trust this folder, answer yes: declining ends the run (ADR 0037 decision 9).',
    '',
  ].join('\n'));

  ce.install();
  const state = { killedByUs: false, exitCode: null, exitSignal: null, exited: false, stopBy: null, gateFailure: null, attachFailure: null, spawnError: null, pluginUnreadable: false, pluginUnreadableLive: 0 };
  const results = { debug: null, session: null };
  let exitFacts = null;
  const exitWaiters = [];
  const markExit = () => { state.exited = true; for (const w of exitWaiters.splice(0)) w(); };
  // ADR 0037 amendment 5 decision 1: the wake publisher lives as long as claude does (stopped below, once
  // claude has exited). It is up, listening, before claude is spawned: a pipe that cannot be opened fails the
  // launch loudly, before the handover. Only a launch with a core to read has one. Its hold is the run pause's.
  let wakePub = null;
  let wakeFailure = null;
  if (core && core.worker && typeof core.worker.list === 'function') {
    try {
      const WP = require('./wake-pipe.cjs');
      wakePub = WP.startWakePublisher({ core, runId, pipeName: deps.wakePipeName || WP.wakePipeName(dataDir, runId, wakeNonce), pollMs, isHeld: wakeHeld || deps.wakeHeld || (() => false), onRelease: wakeRelease || deps.wakeRelease || null });
      await wakePub.listening;
    } catch (e) {
      wakeFailure = `the wake pipe could not be opened (${(e && (e.code || e.message)) || e})`;
      if (wakePub) { try { await wakePub.stop(); } catch { /* none */ } }
      wakePub = null;
    }
  }

  let child;
  let exitPromise;
  try {
    if (wakeFailure) throw new Error(wakeFailure);
    child = spawn(command, fullArgs, { cwd: worktree, env, stdio: 'inherit', windowsHide: false, detached: false, shell: false });
    exitPromise = new Promise((resolve) => {
      child.once('error', (e) => { // a spawn failure: no 'exit' follows
        state.spawnError = (e && e.message) || String(e);
        exitFacts = { pid: null, exit_code: null, exit_signal: null, killed_after_close: false, ms: Date.now() - t0 };
        markExit(); resolve();
      });
      child.once('exit', (code, signal) => {
        state.exitCode = code; state.exitSignal = signal;
        if (state.killedByUs) (deps.restoreTerminal || require('./term-restore.cjs').restoreTerminal)(deps.termOut || process.stdout, { altScreen }); // a killed claude never resets the terminal modes it set
        exitFacts = { pid: child.pid, exit_code: code, exit_signal: signal, killed_after_close: false, ms: Date.now() - t0 };
        markExit(); resolve();
      });
    });
  } catch (e) {
    state.spawnError = (e && e.message) || String(e);
    child = { pid: null };
    exitFacts = { pid: null, exit_code: null, exit_signal: null, killed_after_close: false, ms: 0 };
    markExit(); exitPromise = Promise.resolve();
  }
  const signalNote = () => (state.exitSignal ? `signal ${state.exitSignal}` : `code ${state.exitCode}`);

  // The gate's failure kill (a surface leak, a refused attach): claude by its exact pid, never its tree (the
  // console's other processes are not ours to take down, decision 7). The normal close then waits for the exit.
  async function killChild() {
    // ADR 0039: only while the exit has not been seen, and by the live handle; the receipt names the identity.
    if (!state.exited && child.pid != null && pidAlive(child.pid)) {
      state.killedByUs = true;
      try { noteKill(killPid(child, 'SIGKILL')); } catch { /* the exit event decides */ }
    }
  }
  const noteKill = (k) => { state.killIdentity = k ? (k.identity || { refused: k.refused || null, detail: k.detail || null }) : null; return k; };

  // The stop hook (decision 7): end claude by its exact pid, never its tree (the console's other processes are
  // not ours to take down). There is no stdin to close. The "ended by its pid" cause is set only if the kill was
  // delivered to a claude that was still running; otherwise claude had already exited on its own (L6).
  async function stopHook(reason) {
    if (!state.exited && child.pid != null && pidAlive(child.pid)) {
      state.killedByUs = true;
      const k = noteKill(killPid(child, 'SIGKILL'));
      if (k && k.signalled !== false && !state.stopBy) state.stopBy = String(reason).replace(STOP_SUFFIX, '; claude ended by its pid');
    }
    if (!state.exited) await raceTimer(new Promise((r) => exitWaiters.push(r)), STOP_KILL_WAIT_MS);
    return { ...exitFacts, ended_by: state.stopBy || `claude had already exited (${signalNote()})` };
  }

  let gate = null;
  let runStart = null;
  let firstMessageAt = null;
  const watched = [];
  function onGateFail(name, r) {
    if (!state.gateFailure) state.gateFailure = { check: name, failed: r.failed || null, detail: r.detail || null };
    if (!state.exited) killChild();
  }
  // A verdict finalize() reached after the stop hook ended claude does not displace the stop as the cause.
  // A stop's finalize decided only model, effort or a missing assistant reply: the stop is the cause, the gate is unsettled.
  const stopUndecided = (r) => !!(state.stopBy && r.finalized && ['model', 'effort', 'no_assistant_reply_before_exit'].includes(r.failed));
  const displacesStop = (r) => !(r && r.finalized && state.stopBy);
  function watch(name, p) {
    watched.push(Promise.resolve(p).then(
      (r) => { results[name] = r || null; if (r && r.ok === false && displacesStop(r)) onGateFail(name, r); },
      (e) => { results[name] = { ok: false, failed: 'gate threw', detail: (e && e.message) || String(e) }; onGateFail(name, results[name]); },
    ));
  }

  if (!state.spawnError) {
    if (stopControl) stopControl.attach({ pid: child.pid, exited: () => (state.exited ? { ...exitFacts, ended_by: state.stopBy || `claude had already exited (${signalNote()})` } : null), stop: stopHook });
    let attached;
    try { attached = await onAttached({ pid: child.pid }); } catch (e) { attached = { ok: false, error: (e && e.message) || String(e) }; }
    if (!attached || attached.ok !== true) {
      state.attachFailure = (attached && attached.error) || 'attach refused';
      await killChild();
    } else runStart = writeRunStart(written.dir, runId, attached.attach, Date.now());
    try {
      gate = (deps.createGate || ((o) => surface().createInteractiveGate(o)))(gateOpts);
      watch('debug', gate.debug);
      watch('session', gate.session);
      if (gate.firstMessage) watched.push(Promise.resolve(gate.firstMessage).then((v) => { firstMessageAt = v || null; }, () => null));
    } catch (e) {
      onGateFail('gate', { failed: 'the gate could not start', detail: (e && e.message) || String(e) });
    }
  }

  // ADR 0037 amendment 5 decision 4: the copy is re-hashed while claude runs. A changed file is a leak: claude is
  // killed by its exact pid through the same failure path as a surface leak, and the close names the files.
  // null means unreadable (a throw), which is a separate fact from "changed": the live check retries once, then records it.
  const pluginChanged = () => { try { return (deps.pluginChangedFiles || PC.changedFiles)(plugin.dir, plugin.perFile); } catch { return null; } };
  const pluginTimer = state.spawnError ? null : setInterval(() => {
    if (state.exited || state.gateFailure) return;
    let files = pluginChanged();
    if (files === null) files = pluginChanged();
    if (files === null) { state.pluginUnreadableLive += 1; return; }
    if (files.length) onGateFail('plugin', { failed: `plugin copy changed after spawn (${files.join(', ')})`, detail: null });
  }, deps.pluginCheckMs || PLUGIN_CHECK_MS);
  if (pluginTimer) pluginTimer.unref();

  // Decision 6: after a SIGHUP the console is closing, and a claude that does not follow must not hold the close past
  // its budget: the wait is cut, claude is ended by its exact pid, and the receipt says so.
  const waited = await ce.bound(exitPromise, EXIT_WAIT_RESERVE_MS);
  ce.refreshSnapshot(); // ADR 0039: the worker close that follows needs a young identity snapshot; start it now
  if (waited === TIMED_OUT && !state.exited) {
    if (child.pid != null && pidAlive(child.pid)) {
      let k = null;
      state.killedByUs = true;
      try { k = noteKill(killPid(child, 'SIGKILL')); } catch { k = null; }
      if (k && k.signalled !== false && !state.stopBy) state.stopBy = 'claude did not exit within the fast close budget; claude ended by its pid';
    }
    await raceTimer(exitPromise, 300);
  }
  // Fast close: claude is gone (or killed); the workers come next, with the budget reserved for them, and only then
  // the gate collect, in what is left. The kills' results are the CLI's to report; it awaits the same close.
  if (ce.hupSeen() && ce.startEarlyClose) {
    const e = ce.startEarlyClose();
    if (e) await ce.bound(e.catch(() => null), ce.earlyReserve());
  }
  if (wakePub) { try { await raceTimer(wakePub.stop(), 1000); } catch { /* the pipe is going away with this process */ } }
  clearInterval(pluginTimer);
  let pluginAtExit = null;
  try { pluginAtExit = (deps.pluginHash || ((d) => PC.hashPlugin(d).hash))(plugin.dir); } catch { pluginAtExit = null; }
  // The finalize check of the same rule: a copy whose hash is not the spawn-time one fails the run. A copy that cannot
  // be read is a different fact: the run fails (exit 1) with the gate unsettled, not "changed".
  if (pluginAtExit === null) state.pluginUnreadable = true;
  const pluginTouched = pluginAtExit !== null && pluginAtExit !== plugin.hash ? (pluginChanged() || []) : [];
  if (pluginAtExit !== null && pluginAtExit !== plugin.hash && !state.gateFailure) {
    state.gateFailure = { check: 'plugin', failed: `plugin copy changed after spawn (${pluginTouched.length ? pluginTouched.join(', ') : 'unknown files'})`, detail: null };
  }
  let stopResult = null;
  if (gate) {
    // claude is gone and both its files are final: decide every pending check now (finalize). stop() is for a
    // gate that already failed and had claude killed, and for a gate without finalize.
    try {
      if (!state.gateFailure && typeof gate.finalize === 'function') stopResult = gate.finalize();
      else if (typeof gate.stop === 'function') stopResult = gate.stop();
    } catch { /* the gate is done with */ }
  }
  let collectTimer;
  const collectMs = ce.hupSeen() ? Math.min(GATE_COLLECT_MS, ce.leftMs(ce.earlyReserve ? ce.earlyReserve() : COLLECT_RESERVE_MS)) : GATE_COLLECT_MS;
  let collectCut = false;
  await Promise.race([Promise.all(watched), new Promise((r) => { collectTimer = setTimeout(() => { collectCut = ce.hupSeen(); r(); }, collectMs); })]);
  clearTimeout(collectTimer);
  if (gate) {
    // The facts learned so far are never lost: the snapshot and the stop result fill any half that has not settled.
    let snap = null;
    try { snap = typeof gate.current === 'function' ? gate.current() : null; } catch { snap = null; }
    mergeSnapshot(results, snap);
    mergeSnapshot(results, stopResult && typeof stopResult === 'object' && typeof stopResult.then !== 'function' ? stopResult : null);
    // A half the fast close left undecided is unsettled, and says why; it is never read as passed or failed.
    if (collectCut) for (const name of ['debug', 'session']) { const h = results[name]; if (!h || h.ok === null || h.ok === undefined) results[name] = { ...(h || { facts: {} }), ok: null, undecided: FAST_UNDECIDED }; }
    for (const name of ['debug', 'session']) { // a half the snapshot shows failed, which the watcher did not see
      if (results[name] && results[name].ok === false && !state.gateFailure && displacesStop(results[name])) state.gateFailure = { check: name, failed: results[name].failed || null, detail: results[name].detail || null };
    }
  }

  // A gate with no first-message signal (the old contract) is taken to have reached it.
  const fmKnown = !!(gate && gate.firstMessage);
  const reached = fmKnown ? firstMessageAt !== null : true;
  const actual = actualFacts(results);
  const sfFact = (results.session && results.session.facts && results.session.facts.session_file) || (results.debug && results.debug.facts && results.debug.facts.session_file) || null;
  const sessionExists = !!(sfFact || (fmKnown && reached) || (results.session && results.session.ok === true) || (sessionFile && fs.existsSync(sessionFile)));
  const gateOk = !!(results.debug && results.debug.ok === true && results.session && results.session.ok === true);
  const notReached = fmKnown ? !reached : !sessionExists; // the session was never reached: nothing for the gate to have checked
  const primary = state.spawnError || state.attachFailure || state.gateFailure || state.stopBy;
  let endedBy;
  if (state.spawnError) endedBy = `claude could not be started: ${state.spawnError}`;
  else if (state.attachFailure) endedBy = `the run's attach write failed after this process became the store owner: ${state.attachFailure}`;
  else if (state.gateFailure) {
    const g = state.gateFailure;
    endedBy = g.check === 'plugin' ? String(g.failed) : `surface gate failed (${g.check}): ${g.failed || 'check failed'}${g.detail ? `: ${g.detail}` : ''}`;
  } else if (state.stopBy) endedBy = state.stopBy;
  else if (state.pluginUnreadable) endedBy = 'plugin copy unreadable at exit';
  else if (notReached) endedBy = state.exitCode === 0 ? 'operator quit before the first message' : `claude exited before the session started (${signalNote()})`;
  else if (!gateOk) {
    const st = (r) => (r ? String(r.ok) : 'not reported');
    endedBy = `claude exited (${signalNote()}); surface gate unsettled (debug: ${st(results.debug)}, session: ${st(results.session)})`;
  } else endedBy = `claude exited (${signalNote()})`;

  // Decision 6 and L2: clean only if the surface was proven. The one exception is a quit before the first message.
  const clean = !state.pluginUnreadable && !state.spawnError && !state.attachFailure && !state.gateFailure && !state.stopBy && state.exitCode === 0 && (gateOk || notReached);
  const block = {
    pid: child.pid == null ? null : child.pid, session_id: sessionId, model, turns: null, externally_triggered_turns: null,
    exit_code: state.exitCode, exit_signal: state.exitSignal, usage: null, argv_hash: argvHash, ready_ms: null, later_inits: null,
    killed_after_close: false, surface: null, instructions: I.instructionsFields(instructions),
    permission_mode_requested: permissionMode, permission_mode_effective: actual.permission_mode,
    permission_mode_degraded: actual.permission_mode ? actual.permission_mode !== permissionMode : null,
    claude_code_version: actual.version,
    interactive: {
      session_id: sessionId, debug_file: debugFile, session_file: sfFact || sessionFile || null, session_file_present: sessionExists,
      gate: {
        debug: results.debug, session: results.session, first_message_at: firstMessageAt,
        // never contradicts ended_by: a failure is 'failed'; a session never reached is 'not reached'
        status: state.gateFailure ? 'failed' : (notReached ? 'not reached' : (state.pluginUnreadable ? 'unsettled' : gateOk ? 'passed' : ([results.debug, results.session].some((x) => x && x.ok === false && !stopUndecided(x)) ? 'failed' : 'unsettled'))),
      },
      requested: { model, permission_mode: permissionMode, effort },
      run_start: runStart,
      actual,
      tools: { requested: toolsRequested(), verified: 'unverified' },
      plugin: { name: plugin.name, path: plugin.dir, hash_at_spawn: plugin.hash, files: plugin.files, hash_at_exit: pluginAtExit, unchanged: pluginAtExit === plugin.hash, unreadable: state.pluginUnreadable, unreadable_live_checks: state.pluginUnreadableLive, changed_files: pluginTouched },
      wake: wakePub ? wakePub.stats() : null,
      console_events: ce.events.slice(),
      kill_identity: state.killIdentity || null, // ADR 0039: how the kill's target was proved (handle), or the refusal
      exit_code: state.exitCode,
    },
  };
  return {
    ended_by: endedBy, holds: [], polls: 0, wakes: [], wakes_suppressed: [], wakes_expired: [], wakes_held: [], pauses: [],
    interactive_clean: clean, primary_cause: primary ? endedBy : null, orchestrator: block,
  };
}

// The `--tools` value the launch passed (ADR 0024); recorded as requested, never as verified.
function toolsRequested() { return require('./surface.cjs').CLAUDE_TOOLS.slice(); }

module.exports = { runInteractiveOrchestrator, makeConsole, TIMED_OUT, FAST_CLOSE_BUDGET_MS };
