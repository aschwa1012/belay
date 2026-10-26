'use strict';
// RunManager: the orchestrator adapter's half of the surface (contract §5), parent process of every
// worker (invariant 1). Per-worker mechanics live in worker.cjs; this file is the methods and policy.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const L = require('./launch.cjs');
const { createParser } = require('./parsers.cjs');
const P = require('./process.cjs');
const PI = require('./pid-identity.cjs'); // ADR 0039
const W = require('./worker.cjs');
const { createDoStop } = require('./do-stop.cjs'); // the stop sequence of one worker
const { createMessage } = require('./message.cjs'); // worker_message: stdin for Claude Code, a resume process for Codex
const { verifyReady } = require('./ready.cjs');
const { rotateWireLog } = require('./wire-log.cjs');
const S = require('./surface.cjs'); // ADR 0024, S2 fix round F4: the surface fields spawn/restart/resume return
const I = require('./instructions.cjs'); // ADR 0024 amendment 1: the spawn-time CLAUDE.md copy
const { fail } = require('./errors.cjs');
const { checkWorkerId, checkIdFree, validateSpawnArgs, checkMemoryQueries, discardUnstarted } = require('./spawn-args.cjs');
const AD = require('./agent-defaults.cjs'); // the config's per-agent-type model and effort defaults
const TP = require('./tool-policy.cjs'); // ADR 0054 decision 4: a worker type's tool list
const MP = require('./memory-preface.cjs'); // ADR 0042: the first-message preface and the memory hooks
const NM = require('./native-memory.cjs'); const NR = require('./note-review.cjs'); // NM: ADR 0024 amendment 3, the native_memory guards // wave 4: the notes' review (the reviewer's brief, the short review job)
// build step 6c: `wait`, `decideBranch`, `restartFirstText` and the resume-window constants moved
// verbatim into their own files (the 500-line rule); re-exported under the same names below.
const { createWait } = require('./wait.cjs');
const SENT = require('./sent-log.cjs'); // ADR 0042 decision 4: the record of what is written to a worker's stdin
const { decideBranch, restartFirstText, holdForLaunch, leaseField, leaseNote, CLAUDE_RESUME_WINDOW_MS, CODEX_RESUME_WINDOW_MS } = require('./restart.cjs');
// build step 6e-4: pause and resume (the park design, ADR 0023 amendment 2), and the one per-worker
// operation slot pause, resume, restart and stop all share.
const { createPause, INTERRUPT_TIMEOUT_MS, EXIT_TIMEOUT_MS } = require('./pause.cjs');
const LC = require('./lifecycle.cjs');
// build step 6i-2 design item 3 (R4): writeRow moved verbatim here to keep this file under its own
// 500-line budget once the closed-flag fix (shutdownFlags below) landed.
const { createWriteRow } = require('./write-row.cjs');
const { createStartFail } = require('./start-fail.cjs');
// A park's own worst case, the longest one started during a restart's first turn takes to settle (`restart`).
const PARK_SETTLE_WAIT_MS = INTERRUPT_TIMEOUT_MS + EXIT_TIMEOUT_MS;
const LIST = require('./list.cjs');
const { EARLY, createBudget } = require('./restart-budget.cjs');
const RG = require('./relaunch-guard.cjs'); // ADR 0026 amendment 2: a death during a relaunch keeps its lease
const { waitTurnOrLanded } = require('./turn-wait.cjs'); // a turn that ended before the wait began is answered

const { POLL_MS } = require('./exit-hold.cjs');
const now = () => Date.now();

// `memoryLevers`: the run's levers when the caller holds the run row (ADR 0041); `worktree`: the run's (ADR 0043).
function createRunManager({ core, dataDir, runId, paths = {}, compactAtTokens = null, memoryLevers = null, worktree = null, agentDefaults = null, stopIdleOnDone = false, permissionPrompt = false }) {
  if (!core) fail('E_ARGS', 'createRunManager needs a core');
  if (!dataDir) fail('E_ARGS', 'createRunManager needs a dataDir');
  if (!runId) fail('E_ARGS', 'createRunManager needs a runId');

  // `paths` is optional and unknown keys are ignored (contract §1); `mcpBinary` defaults to
  // src/mcp/belay-mcp.cjs, the rest to the host binaries, all overridable so tests can substitute fakes.
  const root = L.fwd(path.resolve(dataDir));
  const exeFor = (s) => (s === 'codex' ? paths.codexExe || L.codexExe() : paths.claudeExe || L.claudeExe());
  const mcpSource = paths.mcpBinary || paths.mcpServer || null;
  const mcpPath = mcpSource ? L.fwd(path.resolve(mcpSource)) : L.mcpServerPath();
  const settingsSource = paths.userSettings || null; // ~/.claude/settings.json unless overridden

  const workers = new Map();
  const pendingIds = new Set(); // ids reserved by a spawn still asking its task (ADR 0030)
  const adopting = new Map(); // forWorker's adopt (below) coalesces per id: concurrent callers share one `w`
  let poll = null;
  // build step 6i-2 design item 3 (R4): flipped by shutdown() once every worker has been asked to stop
  // (lifecycle.cjs), so a write still queued behind it (the exit-code fill-in a late channel queues,
  // exit.cjs) elects no store owner in this process — write-row.cjs checks it first, before core.
  const shutdownFlags = { closed: false, ownerGone: false, paired: new Set() };

  // 6i-2 fix round (item 3, should-fix): `shutdownFlags` carried on ctx itself, so worker.cjs's onTurnEnd
  // (through turn-record.cjs) can gate its own checkpoint/memory write on it exactly as writeRow does.
  const ctx = { core, runId, dataDir: root, adapterPid: paths.adapterPid || process.pid, writeRow: null, shutdownFlags, compactAt: compactAtTokens, memoryLevers, worktree, stopIdleOnDone: stopIdleOnDone === true, permissionPrompt: permissionPrompt === true }; // stopIdleOnDone: ADR 0058; permissionPrompt: the run lever, the default of a Claude Code spawn's permission_prompt
  const writeRow = createWriteRow(ctx, shutdownFlags);
  ctx.writeRow = writeRow;
  ctx.message = (args) => message(args); // the memory jobs' reflection turn (ADR 0047); `message` is declared below
  const doStop = createDoStop({ ctx, writeRow });

  function get(workerId) {
    const w = workers.get(workerId);
    if (!w) fail('E_NOT_FOUND', 'no worker with that id in this run manager', { worker_id: workerId });
    return w;
  }

  const { failNoReady, guarded } = createStartFail({ core, writeRow }); // contract §5; ADR 0045 decision 2: every failed start settles its launch

  function startPoll() {
    if (poll) return;
    poll = setInterval(() => {
      for (const w of workers.values()) {
        // The exit event has not fired but the pid is gone: settle it on this poll (contract §5; 6i item 7b/C11).
        if (w.child && ['starting', 'running', 'stopping'].includes(w.state) && w.pid && !P.pidAlive(w.pid) && !W.holdForExitEvent(w)) {
          W.settle(w, w.exitCode, w.exitSignal, 'pid-poll', ctx); // after its bounded hold for the exit code
        }
        require('./late-handback.cjs').check(w, ctx); // ADR 0026 amendment 2: a dead worker's hand-back is still evaluated
      }
    }, POLL_MS);
    if (poll.unref) poll.unref();
  }

  // ------------------------------------------------------------------ launch

  function writeFilesFor(w) {
    // ADR 0047: one decision per worker, taken here with the adapter's argv and kept on the record, so the contract text
    // is only ever sent to an adapter that was launched with --notes (a levers read that failed means off, and is recorded).
    w.notesOn = !!(ctx.memoryLevers && ctx.memoryLevers.notes) && !NR.isJob(w.id); // a review job gets no notes contract
    const adapterLog = L.wireLogPath(w.dir); // every worker adapter logs here (build 12 A1)
    const { mcpJsonPath, settingsPath, plugins } = L.writeWorkerFiles({
      dir: w.dir, workerId: w.id, runId, dataDir: root, mcpPath, settingsPath: settingsSource, logPath: adapterLog,
      permit: w.permissionPrompt, permitWaitMs: w.permitWaitMs, cwd: w.worktree, compactAt: ctx.compactAt, // ADR 0024; ADR 0007 decision 3
      notes: w.notesOn, // ADR 0047
      nativeMemory: w.nativeMemory, // ADR 0024 amendment 3: eval-only, null by default
    });
    // ADR 0007 §6 hygiene never degrades quietly: an unreadable/unparseable user settings file would
    // disable nothing, so the launch fails instead (a file that just does not exist is not a failure).
    if (plugins.unreadable) fail('E_ARGS', plugins.error, { settings_path: plugins.path, worker_id: w.id });
    w.plugins = plugins;
    w.mcpJsonPath = mcpJsonPath;
    w.workerSettingsPath = settingsPath; w.settingsFingerprint = NM.fingerprint(settingsPath); // the bytes this manager wrote; launch() refuses a file that no longer matches
    // Codex's ADR 0001 §8 ready check reads the wire log (WR-5); a Claude Code adapter logs there too
    // (ADR 0026 §3's keepalive lines) but its ready check does not.
    w.adapterLogPath = adapterLog;
    w.adapterArgs = L.workerAdapterArgs({
      workerId: w.id, runId, dataDir: root, mcpPath, logPath: w.adapterLogPath, notes: w.notesOn,
    });
  }
  const launch = (w, o) => require('./bind-launch.cjs').launchBound({ core, runId, root, mcpPath, writeRow }, w, () => launchNow(w, o)); // ADR 0045: one launch of a worker at a time, its bind opened first
  async function launchNow(w, { resume = null, prompt = null } = {}) {
    try { NM.checkLaunch(w); } catch (e) { await NM.refuseLaunch(ctx, w, e, () => PI.pidLive(w)); } let args; // sync and first (Codex's check-then-spawn stays one tick); only a refusal awaits
    if (w.substrate === 'claude-code') {
      args = L.claudeLaunchArgv({
        workerId: w.id, mcpJsonPath: w.mcpJsonPath, settingsPath: w.workerSettingsPath,
        model: w.model || L.DEFAULT_CLAUDE_MODEL, allowedTools: w.allowedTools,
        permissionMode: w.permissionMode, resumeSessionId: resume,
        permissionPromptTool: w.permissionPrompt, appendSystemPromptFile: w.instructions && w.instructions.path,
        effort: w.effort, tools: w.tools, maxBudgetUsd: w.maxBudgetUsd, // ADR 0028 decision 2: every launch, fresh or resumed; ADR 0024: a narrowed list too
      });
    } else if (resume) {
      args = L.codexResumeArgv({ threadId: resume, adapterArgs: w.adapterArgs, prompt, model: w.model });
    } else {
      args = L.codexLaunchArgv({
        worktree: w.worktree, adapterArgs: w.adapterArgs, prompt, sandbox: w.sandbox, model: w.model, scratchDir: w.scratchDir,
      });
    }
    const { command, prefixArgs } = L.resolveExe(exeFor(w.substrate));
    const spec = { exe: command, args: [...prefixArgs, ...args], cwd: w.worktree };
    w.argvHash = L.writeArgvJson(w.dir, spec);
    w.settled = false; w.pidGoneAt = null; w.pidGonePid = null; // the exit-event hold is per launch
    w.settledState = null; // the last process's end; a restatement of this one's row must never carry it
    w.exitedAt = null;
    w.turnEnded = false;
    w.readyAt = null;
    w.parkRequested = null; w.paused = null; w.staleSince = null; w.bgTasks = new Map(); w.controlWaiters.clear(); w.pendingTurnEnd = null; // 6e-4/6e-6: fresh
    // The adapter log is shared across a worker's launches: rotate it if large (review B1), then remember
    // where it ended, so a previous process's tools/list never passes this one's ready check.
    if (w.adapterLogPath) rotateWireLog(w.adapterLogPath);
    w.adapterLogBytes = w.adapterLogPath ? (fs.statSync(w.adapterLogPath, { throwIfNoEntry: false }) || { size: 0 }).size : 0;
    w.parser = createParser(w.substrate, MP.parserOpts(ctx));
    const child = P.spawnWorker({
      // ADR 0016: `cwd` goes to `buildEnv` too, so `PWD` agrees with the real working directory. 6d:
      // MCP_TOOL_TIMEOUT is set only with permission_prompt, always outside permit_wait_ms's own bound.
      exe: spec.exe, args: spec.args, cwd: w.worktree,
      env: L.buildEnv(process.env, {
        substrate: w.substrate, cwd: w.worktree, workerId: w.id,
        mcpToolTimeoutMs: w.permissionPrompt ? w.permitWaitMs + 60000 : null,
      }),
      stdin: w.substrate === 'claude-code' ? 'pipe' : 'ignore',
    });
    w.launches += 1;
    w.launchedAt = now();
    try { W.attach(w, child, ctx); }
    catch (e) { if (e && e.teardown) await e.teardown; throw e; } // a register refusal ends the child and its helpers: the error waits for that
    startPoll();
    return spec;
  }

  function sendStdin(w, text, kind = 'message') {
    const line = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n';
    w.child.stdin.write(line);
    w.parser.noteStdinWrite();
    SENT.record(w, ctx, kind, text); // ADR 0042 decision 4: the user side of a bottle, only with memory.bottle on
    return Buffer.byteLength(text, 'utf8');
  }

  // Send the opening message for a launch. Claude Code takes it on stdin; Codex already has it in
  // argv, but the turn is still one the harness asked for, so the parser is told either way.
  function openWith(w, text, kind) {
    if (w.substrate === 'claude-code') sendStdin(w, text, kind);
    else w.parser.noteStdinWrite();
  }

  // ---------------------------------------------------------------- methods

  async function spawn(opts) {
    const {
      substrate, worktree, prompt, task_id = null, model: modelArg = null, allowed_tools = null,
      permission_mode = null, startup_timeout_ms = 60000, worker_id = null, sandbox = null,
      permission_prompt: permissionArg, permit_wait_ms = 600000, effort: effortArg = null, tools = null, agent_type = null, max_budget_usd = null, memory_queries = null, native_memory = null,
    } = opts || {};
    const permission_prompt = permissionArg !== undefined ? permissionArg : (ctx.permissionPrompt === true && substrate === 'claude-code'); // the run lever is the default; an explicit spawn argument wins
    checkWorkerId(worker_id); // before anything else: the id is a path component
    // ADR 0054 decision 4: the agent type's tool list, narrowed by allowed_tools, is the surface (`--tools`); an explicit harness
    // `tools` wins. Checked first: a refusal writes nothing. A Codex worker takes only the six (it has no list to narrow).
    if (agent_type !== null && !AD.WORKER_TYPES.includes(agent_type)) fail('E_ARGS', `spawn agent_type must be one of ${AD.WORKER_TYPES.join(', ')}`, { agent_type });
    const { tools: spawnTools, allowedTools } = TP.spawnSurface(agentDefaults, { substrate, agent_type, allowed_tools, tools, defaultAllowed: L.DEFAULT_ALLOWED_TOOLS });
    let model = modelArg; let effort = effortArg;
    let nativeMemory = MP.nativeMemory(ctx, substrate, worker_id, native_memory); if (nativeMemory && nativeMemory.then) nativeMemory = await nativeMemory; // sync unless the run's levers are still to be read (the worker record must exist in the same tick)
    let agent = null;
    if (agent_type !== null) {
      // The configured default fills only what the caller left out; an explicit model or effort always wins.
      agent = AD.forWorker(agentDefaults, { agent_type, model: modelArg, effort: effortArg, substrate });
      model = agent.model.value;
      effort = agent.effort.value;
    }
    validateSpawnArgs({ substrate, worktree, prompt, permission_prompt, permit_wait_ms, effort, worker_id, native_memory: nativeMemory });
    const indexQueries = checkMemoryQueries(memory_queries);

    const id = worker_id || crypto.randomUUID();
    if ([...workers.keys(), ...pendingIds].some((k) => k.toLowerCase() === id.toLowerCase())) fail('E_ARGS', 'a worker with that id already exists in this run (ids compare without case: NTFS gives W1 and w1 one directory). Choose another id: an id is used once per run, even by a spawn that failed', { worker_id: id });
    // ADR 0030 decision 4: ask the core whether the task can be assigned before anything is written, so a
    // refusal leaves no directory, no row, and the id free. Later refusals still take the write-dead path.
    // The id is reserved synchronously: the await below must not let a second spawn with it pass the check above.
    pendingIds.add(id);
    let w; const dirExisted = fs.existsSync(L.workerDir(root, id)); // a directory this spawn creates is its own to remove if it fails before any row exists
    try {
      if (worker_id) await checkIdFree(core, root, id, runId); // inside the reservation, so two spawns of one id cannot both pass
      if (task_id) await core.task.assign({ task_id, check_only: true, worker_id: id, worktree: typeof worktree === 'string' ? L.fwd(path.resolve(worktree)) : worktree });
      w = W.newWorkerRecord({
        id, substrate, worktree, dataDir: root, taskId: task_id, model,
        allowedTools, permissionMode: permission_mode, sandbox,
        permissionPrompt: permission_prompt, permitWaitMs: permit_wait_ms, effort, tools: spawnTools, maxBudgetUsd: max_budget_usd, nativeMemory,
      });
      w.indexQueries = indexQueries; // the orchestrator's situation lines for this worker's memory index (memory.embedQuery extra_texts)
      workers.set(id, w);
    } finally { pendingIds.delete(id); }
    try { await MP.spawnLevers(ctx, w); w.nativeMemoryAuth = await NM.authorize(core, runId, w.nativeMemory); } catch (e) { await discardUnstarted(workers, w, dirExisted); throw e; } // ADR 0047: the levers are known before the files are written; with the first-message index off the row keeps no situation lines
    try { writeFilesFor(w); } catch (e) { await discardUnstarted(workers, w, dirExisted); throw e; } // no row, nothing launched: leave no record and no directory, so a corrected retry with the same id is free
    const scratch = agent_type === 'reviewer' ? require('./review-scratch.cjs').ensure(root, id, runId) : null; // ADR 0054 amendment 1: outside every worktree
    w.scratchDir = scratch; // a Codex launch adds it as a writable root
    if (substrate === 'claude-code') w.instructions = I.snapshotInstructions(w.worktree, w.dir); // spawn only

    // The worker row comes first, with no pid yet: `task.assign` refuses a worker with no row, and the
    // resume line needs the lease it creates. Only `running` is pid-checked, so this is legitimate.
    let t0 = now();
    await writeRow(w, 'starting');
    let first;
    try {
      first = NR.isJob(w.id) ? prompt : (await MP.preface(w, ctx, prompt)) + prompt + (scratch ? require('./review-scratch.cjs').firstLine(scratch) : '') + require('./review-scratch.cjs').treeLine(w.review) + (w.handbackRule || '') + (await MP.contractTail(ctx, w)) + (await NR.reviewTail(ctx, w)); // the resume line, then the memory index, against the `starting` row (ADR 0007 §2, 0042 §2)
    } catch (e) {
      // The task refused the assignment (an open dependency, ADR 0013 §1; the operator's lease; no such
      // task). Nothing has launched, so the `starting` row is written `dead` before the refusal is handed
      // back unchanged (already names what would clear it, so it is not translated into E_NO_READY).
      w.launchFailed = true;
      await writeRow(w, 'dead');
      throw e;
    }
    // The index's embedding is the harness's wait, not the worker's: it counts neither toward the startup window nor in ready_ms
    // (Codex's verifyReady and the returned ready_ms run from here). Its own time is in the index_injected receipt.
    t0 += w.indexEmbedMs || 0;
    w.firstMessage = first;

    await launch(w, substrate === 'claude-code' ? {} : { prompt: first });
    return guarded(w, async () => {
      await writeRow(w, 'starting');
      openWith(w, first, 'task');

      const ready = await W.waitReady(w, startup_timeout_ms);
      if (!ready) {
        await failNoReady(w, 'the worker produced no ready event inside the startup window', { startup_timeout_ms });
      }
      const v = await verifyReady(w, ready, t0 + startup_timeout_ms);
      if (!v.ok) await failNoReady(w, v.reason, { startup_timeout_ms, session_id: w.sessionId });
      w.readyEvidence = v.evidence;
      const init = W.noteInit(w, ready); // ADR 0021 decisions 3 and 4

      const ready_ms = now() - t0;
      // `running` is a claim about a process, and a worker can die before this line. writeRow returns null
      // when the pid was gone or the core refused E_WORKER_NOT_LIVE; either way the row is `dead` and the
      // caller is owed E_NO_READY, never a `running` row the store never took.
      const written = await writeRow(w, 'running');
      if (!written) {
        await w.queue;
        // One exception: a Codex turn can finish before this line; a settled `idle` worker did start, so
        // the row to return is the store's own (`worker.get`'s pid_alive/last_event_age_ms dropped here).
        if (w.state === 'idle') {
          const { pid_alive, last_event_age_ms, ...row } = await core.worker.get({ worker_id: id });
          return { ...row, ready_ms, permission_mode_degraded: init.permission_mode_degraded, surface: S.surfaceFields(w.readyEvidence), instructions: I.instructionsFields(w.instructions), ...(agent ? { agent } : {}), ...(scratch ? { scratch } : {}), ...(w.review ? { review: w.review } : {}) };
        }
        await failNoReady(w, `the worker reached ready but its pid ${w.pid} was no longer alive when the running row would have been written`, { ready_ms });
      }
      return { ...written, ready_ms, permission_mode_degraded: init.permission_mode_degraded, surface: S.surfaceFields(w.readyEvidence), instructions: I.instructionsFields(w.instructions), ...(agent ? { agent } : {}), ...(scratch ? { scratch } : {}), ...(w.review ? { review: w.review } : {}) }; // scratch: a reviewer's folder (ADR 0054 amendment 1); agent: the model and effort used, each with its source
    });
  }

  // ADR 0023 amendment 2 decision 3: stop always wins, waiting out a pause, resume or restart in flight.
  // 6e-5/6e-6 (pause.cjs `clearParkForStop`): a stale park record is caught before any write, never overwritten.
  async function stop({ worker_id, mode = 'graceful', timeout_ms = 10000 }) {
    const w = await forWorker(worker_id);
    return LC.runOp(w, 'stop', async () => {
      const { stale, wasParked } = await PZ.clearParkForStop(w, worker_id); // wasParked: fix round #2, manager.cjs:351
      if (!stale) W.noteStoppedWhileSettled(w); // item 2 (wait.cjs:32): fixes the settled state too
      return doStop(w, mode, timeout_ms, { skipRowWrite: stale, treatPidAsDead: wasParked });
    }, { waitFor: ['pause', 'resume', 'restart'] });
  }

  // `workers` holds only what this process launched; an unknown id is looked up in the store rather
  // than refused (ADR 0009's A3 row), lazily, so touching no old id costs nothing and creates nothing.
  async function forWorker(workerId) {
    const known = workers.get(workerId);
    if (known) return known;
    if (adopting.has(workerId)) return adopting.get(workerId);
    const p = W.adopt({ core, workerId, dataDir: root }).then(async (w) => {
      workers.set(workerId, w); // no launch guard: a stop must always go through, and writeFilesFor below regenerates settings.json from the record
      await MP.levers(ctx, w, { receipt: true }); // ADR 0047: the argv written below carries the notes lever
      const denied = await NM.adoptDenied(w, runId, ctx.memoryLevers, core); // another run's native_memory is never written into this run's settings; the record stays, the relaunch is refused
      if (denied) { w.adoptRefusal = denied; const rec = w.nativeMemory; w.nativeMemory = null; try { writeFilesFor(w); } catch (e) { w.lastError = { where: 'adopt.settings', code: e && e.code, message: e && e.message }; } finally { w.nativeMemory = rec; } } // the refusal is set first and kept whatever the rewrite does: a stop still goes through, a launch never reaches the old settings
      else try { writeFilesFor(w); } catch (e) { if (w.nativeMemory == null) throw e; w.adoptRefusal = e; } // mcp.json, settings.json, the log path; with the lever on ANY failure here (a folder that cannot be made, a refused record) is kept for checkLaunch to throw on a launch, never on a stop
      if (w.substrate === 'claude-code') w.instructions = I.existingInstructions(w.dir); // never the worktree
      return w;
    });
    adopting.set(workerId, p);
    try { return await p; } finally { if (adopting.get(workerId) === p) adopting.delete(workerId); }
  }

  // Shared by `restart` and by `resume` (pause.cjs): `firstTextOverride(branch)` replaces
  // `restartFirstText`'s own text when given; `appendMessage` follows two newlines; `awaitFirstTurn: false`
  // returns once the relaunch's `running` row lands, before its first turn ends.
  async function doRestart(w, { firstTextOverride = null, appendMessage = null, awaitFirstTurn = true, first_turn_timeout_ms = 180000, onFirstText = null, skipDeadPidKill = false } = {}) {
    const worker_id = w.id;
    const old_pid = w.pid;
    RG.refuseIfRelaunching(w, 'restart'); // a Codex message's relaunch owns the window; this one waits its turn
    // ADR 0026 amendment 2 (proposed): from here until launch() has moved w.launches, a death of this worker keeps its lease.
    const { d, hold, firstText } = await RG.relaunching(w, writeRow, async () => {
      await w.queue; // the life before's rows land first (a death meanwhile keeps the lease: relaunch-guard.cjs)
      const d = decideBranch(w); const hold = await holdForLaunch(w, core); // the task's files are held for this run, or nothing is touched; a death-released lease is granted back or reported
      W.settleHeld(w, ctx, 'pid-check-on-restart'); await w.queue; // a held death gets its dead row, and every row of the life before lands, before the relaunch
      if (w.child && P.pidAlive(w.pid)) await doStop(w, 'graceful', 10000);
      // Fix round, should-fix finding: `skipDeadPidKill` (resume, pause.cjs) skips this branch — a park's own
      // pid is dead by construction, so treating it as a still-alive orphan risks killing a bystander that reused it.
      else if (!skipDeadPidKill && !w.child && PI.pidLive(w)) { // a record with no process by construction is never killed by its pid number
        const kr = await PI.killWorker(w); w.adoptedKill = kr.tree;
        if (!kr.refused) await P.waitPidGone(w.pid, { timeoutMs: 5000 });
      }
      w.stopRequested = false;

      const overridden = firstTextOverride ? await firstTextOverride(d.branch) : undefined;
      let firstText = overridden !== undefined ? overridden : await restartFirstText(w, d.branch, { core, ctx });
      firstText = (await MP.relaunch(w, ctx, firstText, { fresh: d.branch === 'replace', message: appendMessage })) + leaseNote(hold); // ADR 0042 decision 3: minus the rows already shown, only where that conversation still holds them
      if (d.branch === 'replace') {
        w.sessionId = null;
        w.parser = createParser(w.substrate, MP.parserOpts(ctx));
      }
      if (onFirstText) onFirstText(firstText);

      const resume = d.branch === 'resume' ? w.sessionId : null;
      await launch(w, w.substrate === 'claude-code' ? { resume } : { resume, prompt: firstText });
      return { d, hold, firstText };
    });
    let init;
    await guarded(w, async () => {
      await writeRow(w, 'starting');
      openWith(w, firstText, 'resume');

      const t0 = now();
      const ready = await W.waitReady(w, 60000);
      if (!ready) {
        await failNoReady(w, 'the relaunched worker produced no ready event inside the startup window', { branch: d.branch });
      }
      const v = await verifyReady(w, ready, t0 + 60000);
      if (!v.ok) await failNoReady(w, v.reason, { branch: d.branch });
      w.readyEvidence = v.evidence;
      init = W.noteInit(w, ready); // ADR 0021 decisions 3 and 4
      if (!(await writeRow(w, 'running')) && w.state !== 'idle') {
        await failNoReady(w, `the relaunched worker reached ready but its pid ${w.pid} was no longer alive when the running row would have been written`, { branch: d.branch });
      }
    }, { parkOnFailure: skipDeadPidKill }); // a failed resume goes back to parked (start-fail.cjs)
    const turn = awaitFirstTurn ? await W.waitTurn(w, first_turn_timeout_ms) : null;
    await w.queue;
    return {
      worker_id, branch: d.branch, reason: d.reason, old_pid, new_pid: w.pid,
      session_id: w.sessionId, checkpoint_id: (turn && turn.checkpoint_id) || w.lastCheckpointId,
      first_turn_usage: turn ? turn.usage : null, first_turn_timed_out: awaitFirstTurn ? turn === null : null,
      permission_mode_degraded: init.permission_mode_degraded, surface: S.surfaceFields(w.readyEvidence), instructions: I.instructionsFields(w.instructions), // F4
      worker: W.rowOf(w, w.state, ctx), first_turn_awaited: awaitFirstTurn, ...leaseField(hold),
    };
  }

  // No waitFor: a pause, resume or another restart in flight refuses this one E_BUSY; a fully paused
  // worker is refused E_PAUSED. 6e-5 item 4: the slot covers only the relaunch, up to its 'running' row,
  // so a `stop` during the first turn is never held behind it. 6e-6 item 1 (carried item 1, manager.cjs:460):
  // `w.restartInFlight` names only the relaunch, cleared the instant it settles — a second `restart`
  // arriving during it shares that promise; one after starts its own, so a `stop` during the first turn,
  // then a fresh `restart`, relaunches again rather than returning the first's receipt. Once the relaunch
  // has settled, each caller waits for its own first turn.
  // ADR 0048: over MCP the call must answer inside MCP_TOOL_TIMEOUT (120 s). `mcp_budget_ms` (set only by the MCP adapter, about
  // 100 s) is the total this call may spend, the stop, the relaunch and the first turn together. When the relaunch or the first
  // turn is not done by then the call is not held: it returns `first_turn_awaited: false`, status `not ready yet`, and the
  // relaunch carries on (the slot is released when it ends, and a failed one writes its own dead row), so the caller waits with
  // worker_wait as after a spawn. The CLI passes no budget and is unchanged.
  async function restart({ worker_id, first_turn_timeout_ms = 180000, mcp_budget_ms = null }) {
    const bud = createBudget(mcp_budget_ms);
    const { budgeted, left, within } = bud;
    const w = await forWorker(worker_id);
    const oldPid = w.pid;
    const earlyReceipt = () => ({
      worker_id, branch: null, reason: null, old_pid: oldPid, new_pid: w.pid === oldPid ? null : w.pid, session_id: w.sessionId, checkpoint_id: w.lastCheckpointId,
      first_turn_usage: null, first_turn_timed_out: null, first_turn_ended_by: null, worker: W.rowOf(w, w.state, ctx), first_turn_awaited: false,
      status: 'not ready yet', relaunch_in_flight: true, restart_path: 'early_return', elapsed_ms: bud.elapsed(),
    });
    let p = w.restartInFlight;
    if (!p) {
      RG.refuseIfRelaunching(w, 'restart'); // before runOp, which cancels an evaluation in flight: a refused restart has no effect (invariant 5)
      p = LC.runOp(w, 'restart', () => {
        PZ.refuseIfPaused(w);
        return doRestart(w, { first_turn_timeout_ms, awaitFirstTurn: false });
      }, {});
      w.restartInFlight = p;
      const clear = () => { if (w.restartInFlight === p) w.restartInFlight = null; };
      p.then(clear, clear);
    }
    const relaunched = await within(p);
    if (relaunched === EARLY) { p.catch(() => {}); return earlyReceipt(); }
    // 6e-6 item 2 (carried items 1 and 5): the wait also ends on the worker's own exit (`turn.exited`),
    // never the rest of `first_turn_timeout_ms`. A pause's own interrupt (`turn.paused`) lands well
    // before the park's exit and row write, waited out here too, so `worker` reads `paused`, not `running`.
    // A fast first turn can end while the relaunch still writes its `running` row: read, never waited out.
    const waitMs = budgeted ? Math.max(1, Math.min(first_turn_timeout_ms, left())) : first_turn_timeout_ms;
    const turn = await waitTurnOrLanded(w, waitMs);
    if (turn && turn.paused) await W.waitExit(w, PARK_SETTLE_WAIT_MS);
    await w.queue;
    const base = { ...relaunched, worker: W.rowOf(w, w.state, ctx), checkpoint_id: (turn && turn.checkpoint_id) || w.lastCheckpointId };
    if (turn === null && budgeted && waitMs < first_turn_timeout_ms) return { ...earlyReceipt(), ...{ relaunch_in_flight: false, branch: relaunched.branch, reason: relaunched.reason, new_pid: relaunched.new_pid, session_id: relaunched.session_id, checkpoint_id: base.checkpoint_id, worker: base.worker } };
    return {
      ...base,
      first_turn_usage: turn && !turn.exited ? turn.usage : null, first_turn_timed_out: turn === null,
      first_turn_ended_by: turn === null ? 'timeout' : (turn.exited ? 'exit' : 'turn'), first_turn_awaited: true, restart_path: 'awaited', elapsed_ms: bud.elapsed(),
    };
  }

  const wait = createWait({ workers, get, core }); // core: the leases behind idle_without_task (ADR 0058, the idle-workers amendment)
  // build step 6e-4 (ADR 0023 amendment 2): pause parks the worker; resume relaunches it through doRestart.
  const PZ = createPause({ core, forWorker, doStop, doRestart, runOp: LC.runOp, adapterPid: ctx.adapterPid, writeRow });
  const message = createMessage({ core, ctx, forWorker, refuseIfPaused: PZ.refuseIfPaused, sendStdin, launch, guarded, writeRow });

  const list = () => LIST.listWorkers(workers, core);

  // build step 6e-5 design item 1: moved into lifecycle.cjs, verbatim apart from the left_parked skip.
  // build step 6i-2 design item 3 (R4): `markClosed` flips shutdownFlags only once every worker has
  // been asked to stop and its queue drained (lifecycle.cjs's own ordering), never before.
  const shutdown = () => LC.shutdown(workers, {
    stop, core, clearPoll: () => { if (poll) { clearInterval(poll); poll = null; } },
    markClosed: () => { shutdownFlags.closed = true; }, markClosing: () => { shutdownFlags.closing = true; },
    markOwnerGone: () => { shutdownFlags.ownerGone = true; return shutdownFlags.paired; },
    beforeStop: (ms) => NR.drainVerdicts(ctx, ms),
    onDrained: () => MP.runEnd(ctx),
  });

  const manager = {
    spawn, message, stop, restart, list, shutdown,
    wait, pause: PZ.pause, resume: PZ.resume,
    ask: (args) => MP.ask(manager, ctx, args), // ADR 0043 decision 1
    // Read-only handles for tests and for the CLI's own views. Neither writes.
    _worker: (id) => workers.get(id),
    // The note-review brief for a verdict task assigned to this live worker (task_assign appends it, as a spawn does).
    reviewTail: ({ worker_id, task_id }) => { const w = workers.get(worker_id); return w ? NR.reviewTail(ctx, { id: w.id, taskId: task_id, set lastError(v) { w.lastError = v; } }) : ''; },
    _waitTurn: (id, ms) => waitTurnOrLanded(get(id), ms),
    _waitExit: (id, ms) => W.waitExit(get(id), ms),
    _killSurvivor: (id) => (workers.has(id) ? LC.killSurvivor(workers.get(id), null) : null), // a child by its live handle and exact pid (lifecycle.cjs)
    _closing: () => shutdownFlags.closing, _closed: () => shutdownFlags.closed, // flipped by shutdown once every worker is stopped (lifecycle.cjs)
    _flags: () => shutdownFlags, idleStop: (row) => require('./idle-stop.cjs').stopIfIdleDone(manager, ctx, row), // ADR 0058: the stop_idle_on_done lever
  };
  ctx.manager = manager; // the memory jobs spawn the review job through it
  return manager;
}

module.exports = { createRunManager, POLL_MS, CLAUDE_RESUME_WINDOW_MS, CODEX_RESUME_WINDOW_MS };
