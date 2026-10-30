'use strict';
// One worker's in-memory record and everything that happens to it while it runs: the stream sink,
// the tool digest, the turn accounting, the waiters, and the transition to a settled row. The
// manager owns policy (when to spawn, message, stop, restart); this file owns what a live worker does.

const { POLL_EXIT_HOLD_MS, DEATH_GRACE_MS, holdForExitEvent, settleHeld } = require('./exit-hold.cjs');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const L = require('./launch.cjs');
const { createParser } = require('./parsers.cjs');
const { initFacts } = require('./ready.cjs');
const BG = require('./background.cjs'); // build step 6e-3: background-task tracking and its own control requests
const LC = require('./lifecycle.cjs'); // 6e-5: readLaunchOptions (design item 5)
const EX = require('./exit.cjs'); // 6f-2 design items 6 and 9: terminalState, noteStoppedWhileSettled, settle
const MC = require('./memory-capture.cjs'); // ADR 0041 decision 7: the turn's event buffer, lever-gated
const NC = require('./note-chances.cjs'); // the notes sink record: what a worker was shown, sent to the core at task end
const TR = require('./turn-record.cjs'); // 6i-2 fix round (item 3, should-fix): onTurnEnd's checkpoint/memory write, gated on shutdownFlags
const HL = require('./head-lookup.cjs'); // W2-3: base_sha at record creation, head_sha at settle (write-row.cjs)
const CP = require('./compaction.cjs'); // ADR 0007 decision 3: the compact_at_tokens lever (inert while ctx.compactAt is null)
const PI = require('./pid-identity.cjs'); // ADR 0039: pid_created, read once at spawn

const DIGEST_KEEP = 20;
const MEMORY_TEXT_MAX = 1200;
const STDERR_TAIL_MAX = 4000;
const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'];

const sha12 = (v) => crypto.createHash('sha256').update(JSON.stringify(v === undefined ? null : v)).digest('hex').slice(0, 12);
const now = () => Date.now();

function newWorkerRecord({ id, substrate, worktree, dataDir, taskId, model, allowedTools, permissionMode, sandbox, permissionPrompt = false, permitWaitMs = 600000, captureBase = true, effort = null, tools = null, maxBudgetUsd = null, nativeMemory = null, nativeMemoryAuth = null, trustRecord = false }) {
  const narrowed = L.narrowTools(tools); // ADR 0024: checked before the directory exists; null is the full list
  const dir = L.workerDir(dataDir, id);
  fs.mkdirSync(dir, { recursive: true });
  const w = {
    id, substrate, worktree: L.fwd(path.resolve(worktree)), dir, taskId: taskId || null,
    model: model || null, effort: effort || null, maxBudgetUsd, nativeMemory: nativeMemory == null ? null : trustRecord ? nativeMemory : require('./surface.cjs').checkNativeMemory(nativeMemory), nativeMemoryAuth, tools: narrowed, allowedTools: allowedTools || L.DEFAULT_ALLOWED_TOOLS,
    permissionMode: permissionMode || L.DEFAULT_PERMISSION_MODE, sandbox: sandbox || L.DEFAULT_CODEX_SANDBOX,
    // ADR 0021 decisions 3-4: what the last launch's system/init said it started with (noteInit); null
    // until a ready event carries it, always null for Codex.
    permissionModeEffective: null, claudeCodeVersion: null,
    permissionPrompt, permitWaitMs, // ADR 0020 decision 1: opt-in per spawn, carried across a restart
    streamPath: L.fwd(path.join(dir, 'stream.jsonl')), stderrPath: L.fwd(path.join(dir, 'stderr.txt')),
    parser: createParser(substrate), child: null, pid: null, sessionId: null, state: 'starting',
    startedAt: now(), readyAt: null, exitedAt: null, exitCode: null, exitSignal: null,
    turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, costBase: 0, lastEventAt: null, contextTokens: null,
    digest: [], filesTouched: new Set(), stderr: '', argvHash: null, lastAssistantText: '',
    lastCheckpointId: null, lastTurnUsage: null, turnEnded: false, stopRequested: false, settled: false,
    readyWaiters: [], turnWaiters: [], exitWaiters: [], queue: Promise.resolve(), launches: 0,
    fiveMinuteCacheWrites: 0, lastError: null, spawnError: null, deathEstablishedBy: null,
    // build step 6e-4: `op` is the per-worker operation slot (lifecycle.cjs). `parkRequested` ({ at, by,
    // resultsSeen }) is set the instant a park begins, through the paused row. `paused` ({ at, by,
    // interrupted, session_id }) is the settled park's own record for resume; `restartInFlight` (fix round
    // #2, manager.cjs:462) is a second concurrent restart's own shared promise.
    // build step 6e-6 item 4 (carried item 4, wait.cjs:37): `staleSince` ({ at, row_state, adapter_pid })
    // is set once clearParkForStop or checkNotStale (pause.cjs) finds this record's park belongs to a row
    // another adapter has since moved on from; it never clears itself, so every later read of this record
    // answers 'stale' rather than a park fact this adapter no longer holds.
    // build step 6i item 1: turns at a park's acceptance (pause.cjs step 1b), carried by rowOf below.
    // 6i-2 item 7 (R9, pause.cjs's isOwnActiveRow): `launchesAtPark` is `w.launches` as of the most recent
    // doPause, surviving a later launch() reset of parkRequested — clearParkForStop's own discriminator.
    op: null, parkRequested: null, paused: null, parkTurns: null, staleSince: null, restartInFlight: null, controlWaiters: new Map(), lastTurnEndAt: null, pendingTurnEnd: null, settledChild: null, launchesAtPark: null,
    bgTasks: new Map(), bgTaskWaiters: new Map(),
    // settle()'s one-time answer, cached since stopRequested/exitCode keep moving after it; stays null
    // for an adopt()ed record, which falls back to w.state (the row's own claim).
    settledState: null,
    // Build step W2-3 (S4a): the receipt facts. `initModel` is the model system/init reported (null until
    // a ready event), not the requested `model` above; `toolCalls` is uncapped, unlike the digest;
    // `baseSha` is the worktree's HEAD at record creation (async, written with the next row write) and
    // `headPromise` the settle-time HEAD (write-row.cjs), each null when git cannot answer.
    initModel: null, cacheReadTokens: 0, cacheCreationTokens: 0, toolCalls: 0, baseSha: null, baseError: null, basePromise: null, headSha: null, headError: null, headPromise: null, headRequested: false, lastRowHadBase: null, ctx: null,
  };
  // Kept on the record (build 12 a2): shutdown awaits it like headPromise, so no git child of ours still has the worktree as its cwd when the run ends.
  if (captureBase) w.basePromise = HL.lookupSha(w.worktree).then(({ sha, reason }) => { w.baseSha = sha; w.baseError = sha ? null : reason; if (w.ctx) require('./write-row.cjs').restateBase(w, w.ctx); });
  return w;
}

// Rebuild a record for a worker this process never spawned, from the row the store holds.
// Contract §5's restart and ADR 0009's A3 row both need it: after a session ends, the session or
// thread id, the worktree, the task and the last event are all in the store and none of them are in
// the next adapter's memory, so without this `restart` can only ever reach workers of its own
// session. The record is settled on arrival: whatever ran under that pid belonged to another
// adapter, this process is not its parent (invariant 1) and cannot see it exit.
async function adopt({ core, workerId, dataDir }) {
  const row = await core.worker.get({ worker_id: workerId }); // E_NOT_FOUND is the store's answer
  // 6e-5 item 5: the row has no column for model/allowed_tools/permission_prompt, so a cross-adapter
  // relaunch used to fall back to this build's defaults; argv.json/mcp.json name what actually ran.
  const launchOpts = LC.readLaunchOptions(L.workerDir(dataDir, row.id));
  // ADR 0024 amendment 4: the built-in tool list comes from the harness row, never from argv.json, which the worker can edit. The row wins
  // when the two disagree. A row with no record (written before the column) is trusted only when argv.json does not show a narrowed list;
  // if it does, the harness cannot tell a worker it narrowed from one the worker edited, so the adopt fails closed (a stop still goes through).
  const S = require('./surface.cjs');
  let rowTools = null; let toolsRefusal = null;
  if (row.substrate === 'claude-code') {
    if (row.tools != null) {
      try { rowTools = S.narrowTools(row.tools); } catch (e) { toolsRefusal = Object.assign(new Error(`worker ${row.id}: the row's tools record is not a valid built-in list; a launch is refused (${e.message})`), { code: 'E_ARGS', detail: { worker_id: row.id, reason: 'tools_record_invalid' } }); }
    } else if (launchOpts.tools != null) {
      toolsRefusal = Object.assign(new Error(`worker ${row.id} has no tools record on its row, and its argv.json names a narrowed list; the harness cannot tell it from an edited file, so a launch is refused (stop is still allowed)`), { code: 'E_ARGS', detail: { worker_id: row.id, reason: 'tools_record_missing' } });
    }
  }
  const w = newWorkerRecord({
    id: row.id, substrate: row.substrate, worktree: row.worktree, dataDir, taskId: row.task_id,
    model: row.model_requested || (row.model_requested === undefined ? launchOpts.model : null), allowedTools: launchOpts.allowedTools, tools: rowTools, maxBudgetUsd: row.max_budget_usd == null ? null : row.max_budget_usd, // ADR 0024 amendment 4: the cap and the model from the row, never argv.json (argv.json's model only for a row from before the column)
    nativeMemory: row.native_memory || null, nativeMemoryAuth: row.native_memory_auth || null, trustRecord: true, // ADR 0024 amendment 3: from the harness row, never the worker files; a stop always goes through, an unusable value is refused at the next launch
    permissionMode: row.permission_mode_requested || null, sandbox: null,
    permissionPrompt: launchOpts.permissionPrompt, permitWaitMs: launchOpts.permitWaitMs || 600000,
    effort: row.effort_requested || null, // ADR 0028 decision 2: a cross-adapter relaunch keeps the level
    captureBase: false, // W2-3: an adopted worker keeps the base_sha of its row
  });
  // W2-3: every receipt column comes from the row; head_sha is asked of git again if the adopted worker later settles (SF1).
  w.indexQueries = Array.isArray(row.memory_queries) ? row.memory_queries : [];
  w.initModel = row.model || null;
  w.cacheReadTokens = row.cache_read_tokens || 0;
  w.cacheCreationTokens = row.cache_creation_tokens || 0;
  w.toolCalls = row.tool_calls || 0;
  w.baseSha = row.base_sha || null;
  w.baseError = row.base_error || null;
  w.headSha = row.head_sha || null;
  w.lastWrittenSeq = Number.isInteger(row.seq) ? row.seq : null; // the guard's basis for a later restating write
  if (toolsRefusal) { w.toolsRefusal = toolsRefusal; w.toolsUnknown = true; } // never overwritten (forWorker sets adoptRefusal for other causes): checkLaunch throws the refusal on every launch, and rowOf writes no tools
  if (launchOpts.error) w.lastError = { where: 'adopt', ...launchOpts.error };
  w.sessionId = row.session_id || null;
  w.pid = Number.isInteger(row.pid) ? row.pid : null;
  PI.adoptFromRow(w, row);
  w.state = row.state;
  w.startedAt = row.started_at || w.startedAt;
  w.lastEventAt = row.last_event_at || null;
  w.turns = row.turns || 0;
  w.inputTokens = row.input_tokens || 0;
  w.outputTokens = row.output_tokens || 0;
  w.costUsd = row.cost_usd || 0;
  w.costBase = row.cost_base || 0; // reported cost of the lives before this session (a fresh session's total starts at zero)
  w.exitedAt = row.exited_at || null;
  w.exitCode = row.exit_code == null ? null : row.exit_code;
  w.exitSignal = row.exit_signal == null ? null : row.exit_signal;
  w.convoLost = require('./convo-marker.cjs').present(w.dir); // a replacement whose boundary receipt was never stored: its next launch shows every row
  w.settled = true;
  w.deathEstablishedBy = 'adopted from the store, not seen exit by this adapter';
  // build step 6e-4: a park is a row fact, not an adapter's memory, so it can be resumed by the next
  // adapter; the row names no `interrupted` fact, so an adopted record's own answer is always `false`.
  if (row.state === 'paused') {
    w.paused = { at: row.paused_at, by: row.paused_by, interrupted: false, session_id: row.session_id };
  }
  w.argvHash = row.argv_hash || null; // the row's own hash of them, not the options themselves (item 5)
  // The last checkpoint belongs to the task, not to the worker row, and restart reports it when a
  // relaunch produces no turn of its own.
  if (row.task_id && core.task && typeof core.task.get === 'function') {
    try {
      const t = await core.task.get({ task_id: row.task_id });
      w.lastCheckpointId = (t && t.last_checkpoint_id) || null;
    } catch (e) {
      w.lastError = { where: 'task.get', code: e && e.code, message: e && e.message };
    }
  }
  w.adopted = {
    from_run_id: row.run_id || null, state: row.state, pid: w.pid,
    pid_alive: !!row.pid_alive, argv_hash_before: row.argv_hash || null,
    last_checkpoint_id: w.lastCheckpointId, at: now(),
  };
  return w;
}

// The worker row of contract §2. `seq`, `written_at` and `written_by` belong to the core. `mid_turn`
// (5b) is the harness's own claim: 1 on a `starting`/`running` row written while a message is on this
// worker's stdin (or a Codex process launched with a prompt) and no `result` has landed since, 0
// otherwise. `death_established_by` carries what settle()/adopt() recorded, but only on a `stopped` or
// `dead` row — gating on `state` here (the one place every row passes through) keeps that true
// regardless of what `w.deathEstablishedBy` still holds from an earlier death (5b fix round).
function rowOf(w, state, { runId, adapterPid }) {
  w.lastRowAt = Date.now(); // refreshRow() below measures the age of the stored row from this
  // build step 6i item 1 (C2): a live row's park is over — reset the carry, so a later plain stop or the
  // next park never inherits a stale value; every other state carries whatever `w.parkTurns` holds.
  if (state === 'starting' || state === 'running') w.parkTurns = null;
  return {
    id: w.id, run_id: runId, substrate: w.substrate, pid: w.pid, session_id: w.sessionId,
    adapter_pid: adapterPid, argv_hash: w.argvHash, state, worktree: w.worktree, task_id: w.taskId,
    // An inherited started_at that is not a safe integer is left out, so the core keeps it rather than refusing this write (api.md: an inherited value is never checked).
    ...(Number.isSafeInteger(w.startedAt) ? { started_at: w.startedAt } : {}),
    exited_at: w.exitedAt, exit_code: w.exitCode, exit_signal: w.exitSignal,
    turns: w.turns, input_tokens: w.inputTokens, output_tokens: w.outputTokens, cost_usd: w.costUsd, cost_base: w.costBase || 0,
    last_event_at: w.lastEventAt,
    // ADR 0021 decision 3: set only by a launch this record made, so an adopted record claims nothing.
    permission_mode_requested: w.permissionModeEffective ? w.permissionMode : null,
    permission_mode_effective: w.permissionModeEffective, claude_code_version: w.claudeCodeVersion,
    effort_requested: w.effort || null, max_budget_usd: w.maxBudgetUsd == null ? null : w.maxBudgetUsd, model_requested: w.model || null, // ADR 0028 decision 3: the request, not the level the substrate used
    native_memory: w.nativeMemory || null, native_memory_auth: w.nativeMemoryAuth || null, // ADR 0024 amendment 3: the harness's record of the lever and of who opted in; a relaunch reads them here, and no write other than the spawn's own sets the second
    ...(w.substrate !== 'claude-code' ? { tools: null } : w.toolsUnknown ? {} : { tools: w.tools || require('./surface.cjs').CLAUDE_TOOLS }), // a refused adopt writes no tools: its row keeps whatever it had, never the six // ADR 0024 amendment 4: the built-in list this worker runs with, on the row; a relaunch reads it here and never from argv.json
    memory_queries: Array.isArray(w.indexQueries) && w.indexQueries.length ? w.indexQueries : null, // the orchestrator's index queries, kept for a relaunch
    // 6e-5 item 3: `paused` dropped — a parked worker has no process, so it is never mid-turn.
    mid_turn: (state === 'starting' || state === 'running') && !w.turnEnded ? 1 : 0,
    death_established_by: (state === 'stopped' || state === 'dead') ? w.deathEstablishedBy : null,
    // build step 6e-4: read from `w.parkRequested`, set synchronously at the very start of a park — the
    // settled `w.paused` this row's own write can be racing ahead of is not populated until afterward.
    paused_at: state === 'paused' && w.parkRequested ? w.parkRequested.at : null,
    paused_by: state === 'paused' && w.parkRequested ? w.parkRequested.by : null,
    park_turns: w.parkTurns == null ? null : w.parkTurns,
    ...PI.rowFields(w),
    ...receiptFields(w, state),
  };
}

// W2-3: the receipt columns. A fact this record does not know yet (no init seen, git not answered) is
// left out of the write rather than sent as null, so the core's merge keeps what an earlier row said.
// A live row never carries a head_sha: that is the settle-time fact of a life that has ended.
function receiptFields(w, state) {
  const f = { cache_read_tokens: w.cacheReadTokens, cache_creation_tokens: w.cacheCreationTokens, tool_calls: w.toolCalls };
  if (w.initModel != null) f.model = w.initModel;
  if (w.baseSha != null) { f.base_sha = w.baseSha; f.base_error = null; }
  else if (w.baseError != null) f.base_error = w.baseError;
  if (state === 'starting' || state === 'running') { f.head_sha = null; f.head_error = null; }
  else if (w.headSha != null) { f.head_sha = w.headSha; f.head_error = null; }
  else if (w.headError != null) { f.head_sha = null; f.head_error = w.headError; }
  return f;
}

// A message (or, for Codex, a resume launch) starts a turn: the worker is mid-turn again from here
// until the next `result`. Queued on `w.queue` exactly as settle()'s own writes are, so a caller that
// awaits this promise sees the row land, or sees `w.lastError` set rather than an unhandled
// rejection — a rejected write here must not throw past `message`, which has already told its
// caller the bytes went to stdin. `send`, when given, runs synchronously here, before this queued
// write and before any await this function itself introduces: `message` (manager.cjs) has already
// checked the worker is alive, and 5b's own `await W.turnStarted(w, ctx)` opened a pipe-round-trip
// window in which that check could go stale (settle() nulls `w.child`) before the write it used to
// guard reached stdin. Running the caller's write here, before this function's own `await`, leaves
// no such window open (5b fix round, finding 4). Resolves to `{ sent }`, whatever `send()` returned
// (the queued write's own failure never rejects this — it lands in `w.lastError`, as above).
function turnStarted(w, ctx, send) {
  const sent = send ? send() : undefined;
  w.turnEnded = false;
  const p = w.queue.then(() => ctx.writeRow(w, 'running')).catch((e) => {
    w.lastError = { where: 'worker.write/turn-started', code: e && e.code, message: e && e.message };
  });
  w.queue = p;
  return p.then(() => ({ sent }));
}

// ADR 0026: the lease keepalive gates on the stored row's last_event_at, and the store only gets a row at
// turn start, turn end and exit. A worker streaming through one long turn would look silent after the
// lease's length, so while the row says `running` mid-turn, ingest re-writes it (same state, the fresh
// last_event_at) once the last write is older than this. Shortened by BELAY_ROW_REFRESH_MS for tests.
const refreshMs = () => {
  const n = Number(process.env.BELAY_ROW_REFRESH_MS);
  return process.env.BELAY_TEST_MODE === '1' && Number.isInteger(n) && n > 0 ? n : 60000; // the knob is test-only
};

function refreshRow(w, ctx) {
  if (w.refreshQueued || w.state !== 'running' || w.settled || w.turnEnded || w.parkRequested || w.stopRequested) return;
  if (Date.now() - (w.lastRowAt || 0) < refreshMs()) return;
  w.refreshQueued = true;
  w.queue = w.queue.then(() => {
    if (w.settled || w.state !== 'running' || w.turnEnded || w.parkRequested || w.stopRequested) return null;
    return ctx.writeRow(w, 'running', { refresh: true });
  }).catch((e) => {
    w.lastError = { where: 'worker.write/refresh', code: e && e.code, message: e && e.message };
  }).then(() => { w.refreshQueued = false; });
}

function appendStream(w, lines) {
  if (!lines.length) return;
  try {
    fs.appendFileSync(w.streamPath, lines.join('\n') + '\n');
  } catch (e) {
    w.streamWriteError = String(e && e.message);
  }
}

function noteToolUse(w, e) {
  w.toolCalls += 1; // uncapped, unlike the digest below
  w.digest.push({ tool: e.tool, args_sha256_12: sha12(e.args), result_bytes: null, at: e.at });
  while (w.digest.length > DIGEST_KEEP) w.digest.shift();
  const f = e.args && (e.args.file_path || e.args.path || e.args.notebook_path);
  if (typeof f === 'string' && EDIT_TOOLS.includes(e.tool)) w.filesTouched.add(f);
}

function noteToolResult(w, e) {
  for (let i = w.digest.length - 1; i >= 0; i--) {
    if (w.digest[i].result_bytes === null && (w.digest[i].tool === e.tool || e.tool === null)) {
      w.digest[i].result_bytes = e.bytes;
      return;
    }
  }
}

// A turn ended. Measured on Claude Code 2.1.258 (tests/run/fixtures/claude-stream.jsonl, two turns
// on one session): `result.usage` sums the assistant calls inside that one turn and is NOT
// cumulative across turns (turn 2's numbers are smaller than turn 1's); `num_turns` counts that
// turn's assistant iterations (2 then 1), not the session's turns; `total_cost_usd` IS cumulative
// (0.02246 then 0.02587, a delta the size of turn 2 alone). So tokens accumulate, the turn counter
// increments, and cost is set. Codex is one process per turn, so everything accumulates.
async function onTurnEnd(w, e, ctx) {
  const { writeRow } = ctx;
  if (CP.swallow(w, e, ctx)) { await CP.afterCompact(w, ctx, turnStarted); return; } // the harness's own /compact turn is not a worker turn
  const u = e.usage || {};
  w.turns += 1;
  const n = (x) => (typeof x === 'number' ? x : 0);
  if (w.substrate === 'codex') {
    // W2-3: Codex reports input_tokens as the total with cached_input_tokens a subset; the columns mean
    // the same on both substrates, so the subset moves to cache_read_tokens and leaves input_tokens.
    w.inputTokens += Math.max(0, n(u.input_tokens) - n(u.cached_input_tokens));
    w.cacheReadTokens += n(u.cached_input_tokens);
  } else {
    w.inputTokens += n(u.input_tokens);
    w.cacheReadTokens += n(u.cache_read_input_tokens);
    w.cacheCreationTokens += n(u.cache_creation_input_tokens);
  }
  w.outputTokens += n(u.output_tokens);
  if (w.substrate === 'claude-code') {
    if (typeof e.cost_usd === 'number') w.costUsd = (w.costBase || 0) + e.cost_usd; // the session's cumulative total, on top of what earlier sessions reported
    w.iterationsLastTurn = typeof e.num_turns === 'number' ? e.num_turns : null;
  }
  w.lastTurnUsage = e.usage;
  w.turnEnded = true;
  w.lastTurnEndAt = now(); // the pause's cache-deadline receipt's own basis
  // build step 6e-4: every result subtype seen after the park's own interrupt is recorded, in order, so
  // doPause (pause.cjs) can tell whether the interrupt cut a turn off, without waiting on this turn.
  // 6e-5 item 3: counted by this result's own stream position (`e.at`) at or after the interrupt's write
  // time, never by when this queued write happens to run (a result that landed first but wrote late).
  const afterInterrupt = !!(w.parkRequested && e.at >= w.parkRequested.interruptAt);
  if (afterInterrupt) w.parkRequested.resultsSeen.push(e.subtype);

  // 6i-2 fix round (item 3, should-fix, worker.cjs:229-247 at the start): moved whole into turn-record.cjs
  // — checked there against ctx.shutdownFlags before either core call, so a turn_end parsed after
  // shutdown() elects no store owner through these two direct writes (probe-late-turn).
  const checkpointId = await TR.recordTurn(w, e, ctx, MEMORY_TEXT_MAX, DIGEST_KEEP);
  // build step 6e-4: a turn ending after the interrupt while a park is under way is reported paused.
  w.pendingTurnEnd = null; await require('./release-eval.cjs').notePending(w, ctx); // ADR 0058: the answer names a hand-back to evaluate // fix round, worker.cjs:317: this turn's own resolution is happening now; settle() may resolve turnWaiters via exit again for whatever comes next
  for (const r of w.turnWaiters.splice(0)) {
    r({ usage: e.usage, checkpoint_id: checkpointId, is_error: e.is_error, paused: afterInterrupt, subtype: e.subtype });
  }
  // 6e-5 item 3: no row is written here while a park is under way — the exit handler's own write is the
  // only one a park ever produces, so the store never claims a non-live state for a still-live process.
  // Nor while a stop is under way: a turn ending after doStop's `stopping` row must not restate `running` over it
  // (the stop's terminal row carries this turn's facts), exactly as refreshRow already holds off for a stop.
  if (!w.parkRequested && !w.stopRequested) {
    try {
      await writeRow(w, w.substrate === 'codex' ? 'idle' : 'running');
    } catch (err) {
      w.lastError = { where: 'worker.write', code: err && err.code, message: err && err.message };
    }
  }
  // Review 3, finding F: the turn's memory write goes on the worker's own queue only now, after the
  // waiters and the row, and is not awaited (turn-record.cjs queueMemory).
  TR.queueMemory(w, e, ctx, MEMORY_TEXT_MAX, checkpointId); require('./release-eval.cjs').startRelease(w, ctx); // ADR 0058: a hand-back's evaluation, detached
  await CP.afterTurn(w, e, ctx, turnStarted); // between turns only; never awaits turnStarted (see compaction.cjs)
}

// The state settle() writes for a dead worker, whether a later stop must fix the settled state up, and
// settle() itself — moved verbatim into exit.cjs (design item 9) to keep this file under its own line
// budget; re-exported below under the same names every caller (manager.cjs, this file) already uses.
const { terminalState, noteStoppedWhileSettled, settle } = EX;

function attach(w, child, ctx) {
  PI.registerSpawn(w, child, ctx.dataDir); // before anything else is touched: a refusal leaves the record as it was
  w.launchFailed = false; // a new process is a new launch: the last one's failure no longer blocks its `running` row
  w.settledChild = null; // reset per launch; see the exit handler below
  w.ctx = ctx; w.headPromise = null; w.headSha = null; w.headError = null; w.headRequested = false; // W2-3: head_sha belongs to the life that is starting; captured again at its settle
  w.child = child;
  w.pid = child.pid;
  PI.noteSpawn(w, child);
  CP.onAttach(w, ctx);
  // The parser this child's bytes belong to, captured now: a relaunch installs a fresh parser on
  // the record, and a late chunk or a flush from the previous child must not be fed into it.
  const parser = w.parser;
  const ingest = ({ lines, events }) => {
    appendStream(w, lines);
    for (const e of events) {
      w.lastEventAt = e.at;
      CP.note(w, e, ctx);
      MC.onEvent(w, e, ctx.memoryLevers); // ADR 0041 decision 7
      NC.onEvent(w, e, ctx);
      if (e.kind === 'ready') {
        w.sessionId = e.session_id || w.sessionId;
        if (e.model) w.initModel = e.model; // W2-3: what init reported, never the requested string
        if (!e.repeat && !w.readyAt) w.readyAt = e.at;
        for (const r of w.readyWaiters.splice(0)) r(e);
      } else if (e.kind === 'bg_task') BG.noteBgTask(w, e); // ADR 0023 amendment 1 decision 1
      else if (e.kind === 'tool_use') noteToolUse(w, e);
      else if (e.kind === 'tool_result') noteToolResult(w, e);
      else if (e.kind === 'assistant_text') {
        w.lastAssistantText = e.text;
        if (e.context_tokens != null) w.contextTokens = e.context_tokens;
        if (e.five_minute_cache_write) w.fiveMinuteCacheWrites += 1;
      } else if (e.kind === 'turn_end') { // fix round, worker.cjs:317: pendingTurnEnd, cleared by onTurnEnd (settle() reads it)
        w.pendingTurnEnd = e; w.queue = w.queue.then(() => onTurnEnd(w, e, ctx)).catch(() => {});
      } else if (e.kind === 'turn_failed') {
        w.lastError = { where: 'turn', detail: e.error };
        for (const r of w.turnWaiters.splice(0)) r({ usage: null, failed: true });
      } else if (e.kind === 'control_response') {
        // build step 6e, ADR 0023 decision 1: resolves the pause that sent this request, if any.
        const r = w.controlWaiters.get(e.request_id);
        if (r) { w.controlWaiters.delete(e.request_id); r(e); }
      }
    }
    if (events.length) refreshRow(w, ctx);
  };
  child.stdout.on('data', (d) => ingest(parser.pushChunk(d)));
  // A worker killed mid-line leaves a partial line in the parser's buffer and a partial multi-byte
  // sequence in its decoder. Both are output the worker really produced, so they are flushed into
  // stream.jsonl at end of stream rather than dropped: a `result` line cut short by a kill is the
  // one line a reader most wants to see.
  child.stdout.on('end', () => ingest(parser.flush()));
  child.stderr.on('data', (d) => {
    w.stderr = (w.stderr + d.toString('utf8')).slice(-STDERR_TAIL_MAX);
    try {
      fs.appendFileSync(w.stderrPath, d);
    } catch { /* the in-memory tail is the receipt of last resort */ }
  });
  child.on('error', (e) => {
    w.spawnError = String(e && e.message);
    settle(w, null, null, 'spawn-error', ctx);
    if (w.noteExitEvent) w.noteExitEvent(null); // no exit event follows an error that precedes any exit
  });
  // Fix round, blocking finding (pause.cjs:50): a write-after-end this process still attempts on a
  // closing stdin (invariant 1's parent must not crash) is recorded here, never thrown.
  if (child.stdin) child.stdin.on('error', (e) => { w.lastError = { where: 'stdin', code: e && e.code, message: e && e.message }; });
  // The exit event is the only channel that carries the exit code, so it is separately awaitable:
  // a pid check can beat it to the death by a few milliseconds and has no code to report.
  // A relaunch replaces this promise; the previous child's exit is gated off below, so resolve the old one
  // here or whoever awaits it (wait.cjs, awaitExitCode) holds a known death for its whole budget.
  if (w.noteExitEvent) w.noteExitEvent(null);
  w.exitEventSeen = new Promise((res) => { w.noteExitEvent = res; });
  child.on('exit', (code, signal) => {
    // build step 6i item 7a (C1, C6): a relaunch already attached its own child by now — this exit
    // belongs to the child a restart replaced, and settles nothing ((r1)'s load failure, Codex E_NO_READY).
    // `w.settledChild`: pid-poll's own settle already nulled `w.child`. 6i review: `noteExitEvent` gated too.
    if (w.child === child || w.settledChild === child) { settle(w, code, signal, 'exit-event', ctx); w.noteExitEvent({ code, signal }); }
  });
}

// The waits on a record's ready, turn and exit, and the bounded wait for an exit code: worker-waits.cjs.
const { waitReady, waitTurn, waitExit, awaitExitCode, deathByPidCheck, EXIT_CODE_WAIT_MS } = require('./worker-waits.cjs');

// ADR 0021 decisions 3 and 4, once per launch after the ready gate: what this launch's system/init
// said it started with. Returns the facts for the caller's receipt (ready.cjs initFacts).
function noteInit(w, ready) {
  const f = initFacts(w.permissionMode, ready);
  if (w.substrate === 'claude-code') {
    w.permissionModeEffective = f.permission_mode_effective;
    w.claudeCodeVersion = f.claude_code_version;
  }
  return f;
}

// manager.message for a Claude Code worker, before it writes: a live stdin, and no harness /compact in flight
// (E_BUSY, ADR 0007 decision 3: nothing is written or held, the caller retries after the compaction's turn ends).
function assertTakesMessage(w, fail, pidAlive, text = '') { // null: write now; a queue receipt during a harness /compact (ADR 0058); { flush }: write those first
  if (!w.child || !w.child.stdin || w.child.stdin.destroyed || !pidAlive(w.pid)) {
    fail('E_SUBSTRATE', 'claude-code worker has no live stdin to take a message', { worker_id: w.id, substrate: w.substrate, state: w.state });
  }
  return CP.queueIfCompacting(w, text, fail);
}

module.exports = {
  DIGEST_KEEP, MEMORY_TEXT_MAX, STDERR_TAIL_MAX,
  newWorkerRecord, adopt, rowOf, noteInit, attach, settle, terminalState, noteStoppedWhileSettled, onTurnEnd, turnStarted,
  noteToolUse, noteToolResult, appendStream, sha12,
  assertTakesMessage,
  waitReady, waitTurn, waitExit, awaitExitCode, deathByPidCheck, EXIT_CODE_WAIT_MS, POLL_EXIT_HOLD_MS, DEATH_GRACE_MS, holdForExitEvent, settleHeld,
};
