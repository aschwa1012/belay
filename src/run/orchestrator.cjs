'use strict';
// orchestrator.cjs — build step 5a, amended by 5a-2,
// 5a-3, 5a-4, 5b, 5b-2, 5b-3 and 5b-4. Owns
// the headless orchestrator child: writes its files, spawns it, parses its stdout, verifies it became
// ready, tracks idle/busy against the store, wakes it when a worker of this run finishes a turn or
// dies, holds its stdin open while one is mid-turn or a wake is unanswered, and closes it (or kills
// the child on a timeout, SIGINT, the close-grace deadline, or a `belay stop`) when it should end.
// The one export is `runOrchestrator`; everything else here is private to it.
// 5a-2: an `error` path for a spawn failure; one poll chain guarded against a second `turn_end` in
// the same stdout chunk; holds recorded as moments, not one row per tick; a `polls` count; a failed
// store read holds rather than closing stdin (fail-closed); the ready gate engages synchronously so
// a same-chunk second init can never re-run it; `close_grace_ms` bounds the stdin-close wait, named
// by `orchestrator.killed_after_close`.
// 5b closes ADR 0015's "a worker's death does not wake anyone" and the first-turn-only mid-turn
// rule: the poll chain runs the run's whole life, reads every worker state, diffs the store's rows
// against the previous baseline (`src/run/wake.cjs`, pure) and writes a wake to stdin for every turn
// end or death, idle or mid-turn alike. Mid-turn is the store's own `mid_turn` column (`worker.cjs`'s
// `rowOf`), not a turns heuristic. 5b fix round: `orchestrator_idle_at_write` reads `state.idle` at
// the write itself, not a stale pre-read snapshot; `expireStalePendingWrites` bounds an unanswered
// write's hold on stdin by `mcp_tool_timeout_ms` without marking it answered.
//
// 5b-2: a wake (or the prompt) is unanswered from its stdin write until a turn end whose own
// `answers_write` names that exact write's index — never merely "the next" turn end, the pre-5b-2
// rule this header and `awaitingWakeIds` below still described until now.
// `parsers.cjs` correlates a turn to a write by the order of `system/init`; a match stamps that
// write's wake record `answered_at_ms`, and `answers_write: null` counts as externally triggered.
// `expireStalePendingWrites` stamps a given-up entry `expired: true`, so every record in `wakes[]`
// ends with exactly one of `answered_at_ms`, `expired`, or neither. The wake-correlation fix adds a
// second answer, the substrate's `command_lifecycle` `completed` for the uuid each write now carries,
// because a write folded into a running turn gets no init of its own (pending-writes.cjs).
// 5b-4 (the death-wake race): the manager's detector settles a death 15 ms to 1,000 ms after the
// process actually dies (its `exit` event, or its 1,000 ms pid poll; a poll-found death waits up to
// POLL_EXIT_HOLD_MS more for the exit event's code, so the grace is exit-hold.cjs's DEATH_GRACE_MS). A poll landing inside that
// window used to see a dead pid on a non-terminal row and, by the 5a rule below, close stdin before
// the detector's `dead` row arrived — the death never announced. `diffWorkers` now derives
// `pending_deaths` for such a row; the idle close (`pollOnce`) holds on one up to `DEATH_GRACE_MS`.
//
// 6f, ADR 0023 amendment 3: the run pause, its own state in `run-hold.cjs` — this file gains only the calls into it.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const L = require('./launch.cjs');
const P = require('./process.cjs');
const { createParser } = require('./parsers.cjs');
const { verifyClaudeReady, initFacts } = require('./ready.cjs');
const I = require('./instructions.cjs'); // ADR 0024 amendment 1
const S = require('./surface.cjs');// ADR 0024, S2 fix round F4: the surface fields the run result carries
const { buildOrchestratorBlock } = require('./orchestrator-block.cjs'); // F4: moved out to keep this file at or under 500 lines
const { createExitTracking } = require('./orchestrator-exit.cjs'); // fix round 2: moved out for the same reason
const { diffWorkers, wakeText, isMidTurn, createHoldRecorder } = require('./wake.cjs');
const PW = require('./pending-writes.cjs');
const { createUsage } = require('./orchestrator-usage.cjs'); // W2-3 (S4b): the orchestrator's own token and cost receipt
const { createRunHold } = require('./run-hold.cjs');

const fwd = (p) => String(p).split('\\').join('/');

// 5b-4: what it bounds is exit-hold.cjs's: the detector's landing, pid-poll exit-event hold included. Not a spec key.
const { DEATH_GRACE_MS, ORPHAN_GRACE_MS } = require('./exit-hold.cjs');
// Tests only: each new hold moment as a JSON line, so a test acts on what a poll saw rather than guessing when it ran.
const HOLDS_FILE = process.env.BELAY_TEST_MODE === '1' ? (process.env.BELAY_TEST_HOLDS_FILE || null) : null;

// spec: { worktree, promptText, orchestratorDir, model, allowedTools, startupTimeoutMs, timeoutMs,
//         mcpToolTimeoutMs, pollMs, closeGraceMs }. onAttached({ pid }) performs run.attach as the
// CLI's operator identity, in-process: by the time this function is called the CLI has already
// elected itself the store owner (5a-2, `core.becomeOwner()`), so the write can no longer land on
// another owner. It is called once, between the spawn and the prompt going onto stdin, exactly as
// TASK.md's step 5 fixes. `stopControl` (build step 5c, may be undefined) is handed the one hook a
// `belay stop` needs: the child's pid, a derived-facts view of whether it has exited, and a way to
// end it the same way the stdin-close rule does.
async function runOrchestrator({ core, runId, dataDir, spec, onAttached, stopControl }) {
  const t0 = Date.now();
  const {
    worktree, promptText, orchestratorDir, model, allowedTools,
    startupTimeoutMs, timeoutMs, mcpToolTimeoutMs, pollMs, closeGraceMs, effort = null, compactAtTokens = null,
  } = spec;

  const mcpPath = L.mcpServerPath();
  const bind = await require('./bind-launch.cjs').bindOrchestrator(core, runId); // ADR 0045 decision 2: the owner is this process's own, so the bind is in process
  const written = L.writeOrchestratorFiles({
    dir: orchestratorDir, runId, dataDir, mcpPath, settingsPath: L.userSettingsPath(), cwd: worktree, // ADR 0024
    compactAt: compactAtTokens, agentDefaults: spec.agentDefaults || null, bind, // ADR 0007 decision 3
  });
  fs.writeFileSync(path.join(written.dir, 'prompt.txt'), promptText);

  const instructions = I.snapshotInstructions(worktree, written.dir); // ADR 0024 amendment 1: at spawn
  const argv = L.orchestratorLaunchArgv({
    mcpJsonPath: written.mcpJsonPath, settingsPath: written.settingsPath, model, allowedTools,
    appendSystemPromptFile: instructions.path, effort, // ADR 0028 decision 5
  });
  const { command, prefixArgs } = L.resolveExe(L.claudeExe());
  const fullArgs = [...prefixArgs, ...argv];
  const argvHash = L.writeArgvJson(written.dir, { exe: command, args: fullArgs, cwd: worktree });

  const env = L.buildEnv(process.env, { substrate: 'claude-code', cwd: worktree });
  env.MCP_TOOL_TIMEOUT = String(mcpToolTimeoutMs);

  const child = P.spawnWorker({ exe: command, args: fullArgs, cwd: worktree, env, stdin: 'pipe' });

  const state = {
    sessionId: null, turns: 0, externallyTriggeredTurns: 0,
    readyVerified: false, readyGateStarted: false, readyMs: null, idle: false, laterInits: 0, surface: null, instructions: I.instructionsFields(instructions),
    holds: [], polls: 0, endedBy: null, finishing: false, boundStarted: false,
    killedAfterClose: false, exitCode: null, exitSignal: null,
    // 5b: wakes written (and suppressed) this run, the per-worker turn/state baseline diffWorkers
    // compares against, and the FIFO of what each stdin write was for (null for the prompt, a
    // worker id for a wake), keyed by the parser's write index and removed by its own `answers_write`.
    // 5b fix round (review 2 finding 2): `wakesExpired` names a pendingWrites entry this run gave up
    // waiting on — see `expireStalePendingWrites` below.
    wakes: [], wakesSuppressed: [], wakesExpired: [], baseline: {}, pendingWrites: [],
  };

  const streamFd = fs.openSync(path.join(written.dir, 'stream.jsonl'), 'a');
  const stderrFd = fs.openSync(path.join(written.dir, 'stderr.txt'), 'a');
  const parser = createParser('claude-code');
  const usage = createUsage();

  let pollHandle = null;
  let pollInFlight = false; // 5a-2: at most one store read at a time, guard not a queue
  const holdRecorder = createHoldRecorder(); // wake.cjs (design item 9): moved out of this file
  const noteWatcher = require('./note-wake.cjs').createNoteWatcher({ core, runId, enabled: !!spec.notes }); // wave 4: a refuted note wakes the orchestrator (notes runs only)
  let readyTimer = null;
  let sigintHandler = null;

  // A15 fix round: forwards writeStdinLine's 3rd arg (the wake record) — dropping it left a held
  // wake resume() redelivers permanently unanswered/unexpired (a15 drive 2026-09-25T22-35-24Z).
  // 6f-2 design item 9: the timeout clock (armTimeout/clearTimeoutClock/getTimeoutRemaining, `6f, amendment
  // 3 decision 2`) moved wholesale into run-hold.cjs to keep this file under its own line budget; `hold`
  // now owns it, `onDeadline` the one callback it needs back (function declarations hoist, so this call
  // may name `closeThenKillOnDeadline` ahead of its own textual declaration below).
  const hold = createRunHold({
    child, getIdle: () => state.idle, onDeadline: (reason) => closeThenKillOnDeadline(reason),
    writeStdinLine: (text, id, rec) => writeStdinLine(text, id, rec), wakeText, pushWake: (rec) => state.wakes.push(rec),
    // 6f-2 design item 5 (run-hold.cjs:133): every record's `at_ms` counts from this run's own t0, like
    // every entry in `wakes[]` already does — never the wall clock.
    nowMs: () => Date.now() - t0,
  });

  function clearTimers() {
    if (pollHandle) { clearTimeout(pollHandle); pollHandle = null; }
    if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
    hold.clearTimeoutClock();
    if (sigintHandler) { process.off('SIGINT', sigintHandler); sigintHandler = null; }
  }

  async function killChild() {
    // ADR 0039: the handle first. A child whose exit was already observed is never killed by its pid.
    if (child.exitCode === null && child.signalCode === null && P.pidAlive(child.pid)) {
      const r = await P.killProcess(child).catch(() => null);
      state.kill = r ? { signalled_at: r.signalled_at || null, snapshot_ms: Number.isFinite(r.snapshot_ms) ? r.snapshot_ms : null } : null; // ADR 0048 decision 7: a test measures from the signal
    }
  }

  // Closes stdin (idempotent — every caller of this function may have already closed it) and bounds
  // whatever happens next: wait up to close_grace_ms for the child to exit on its own, then kill it
  // tree-first. Used by step 9's timeout/interrupt path AND by the ordinary "no worker mid-turn, no
  // wake unanswered" close (`pollOnce`, below): an orchestrator that does not exit when its stdin closes must
  // not make `belay run` permanent, so the same bound applies regardless of which rule closed stdin.
  // `reason` is recorded only the first time — whichever rule got here first owns `ended_by` — but the
  // wait-then-kill bound always runs exactly once (`state.boundStarted` guards that), even when stdin
  // was already closed and `state.finishing` was already set by another rule. `killed_after_close`
  // (5a-2) names whether the bound had to act: a run whose orchestrator ignored its closed stdin
  // returns a non-zero exit code even though `ended_by` is still the stdin rule's sentence.
  async function closeThenKillOnDeadline(reason) {
    if (!state.finishing) {
      state.finishing = true;
      state.endedBy = reason;
    }
    try { if (child.stdin && !child.stdin.destroyed) child.stdin.end(); } catch { /* already gone */ }
    if (state.boundStarted) return;
    state.boundStarted = true;
    const gone = await P.waitPidGone(child.pid, { timeoutMs: closeGraceMs, intervalMs: 100 });
    if (gone === null) { state.killedAfterClose = true; await killChild(); }
  }

  // 5c: `belay stop`'s facts, set by a second 'exit' listener after the one that finalises state.
  // Moved out to orchestrator-exit.cjs (fix round 2, line budget); `getExitFacts` replaces reading the
  // bare `exitFacts` variable directly below.
  const { noteExit, stopForControl, getExitFacts } = createExitTracking({ child, state, t0, closeThenKillOnDeadline });

  async function abortForReadyFailure(reason) {
    if (state.finishing) return;
    state.finishing = true;
    state.endedBy = reason;
    await killChild();
  }

  // A moment, not a tick (5a-2, 5b-4, 6f design item 1, 6f-2 design item 1): `holdRecorder` (wake.cjs)
  // does the actual work now, keeping this file under its own line budget; `live` is 6f-2's own addition.
  function recordHold(turn, busy, awaiting, establishedBy, pendingDeaths, parked, live) {
    const n = state.holds.length;
    holdRecorder.record(state.holds, Date.now() - t0, turn, busy, awaiting, establishedBy, pendingDeaths, parked, live);
    if (HOLDS_FILE && state.holds.length > n) { try { fs.appendFileSync(HOLDS_FILE, JSON.stringify(state.holds[n]) + '\n'); } catch { /* best effort */ } }
  }

  // The unanswered-write bookkeeping, its two answers and its expiry at `mcp_tool_timeout_ms` (the
  // bound ADR 0015 §1 gives every orchestrator tool call) live in pending-writes.cjs.
  const expireStalePendingWrites = () => PW.expireStale(state, Date.now() - t0, mcpToolTimeoutMs);
  const awaitingWakeIds = () => PW.awaitingIds(state, Date.now() - t0, mcpToolTimeoutMs);

  // Writes one line to the child's stdin in the shape both the prompt and a wake take, and records
  // what was written on the FIFO, keyed by the parser's own write index (5b-2: the parser correlates
  // a turn to this exact write by the order of `system/init`, not by FIFO position), so a later turn
  // end can tell what it answered. `forWorkerId` is null for the prompt itself; `wakeRecord` is the
  // exact object pushed to `state.wakes` for a worker's wake, so a later match can stamp it directly.
  function writeStdinLine(text, forWorkerId, wakeRecord) {
    try {
      // The uuid is what the substrate's `command_lifecycle` events name this write by (pending-writes.cjs).
      const uuid = crypto.randomUUID();
      const line = JSON.stringify({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n';
      child.stdin.write(line);
      const index = parser.noteStdinWrite(uuid);
      state.pendingWrites.push({ index, worker_id: forWorkerId, at_ms: Date.now() - t0, wakeRecord: wakeRecord || null });
      return true;
    } catch { return false; } // the child died before it could take this write; the exit handler settles the run
  }

  // One wake event from diffWorkers: render its text, write it to stdin (unless the run is already
  // finishing, in which case it is suppressed and named why), and record it either way. No worker
  // output ever reaches `text` — `wakeText` carries only the id, the turn and the exit facts.
  // `orchestrator_idle_at_write` reads `state.idle` HERE, at the instant of the write (5b TASK.md
  // design item 4's own words) — not a pre-read snapshot, which a store round trip can leave stale
  // for as long as the read took (5b fix round, finding 3: probe-idle.cjs measured a 1,498 ms gap).
  function writeWake(ev) {
    if (state.finishing) {
      state.wakesSuppressed.push({ ...ev, reason: 'stdin already closed when this event was found' });
      return;
    }
    const text = wakeText(ev);
    const rec = {
      at_ms: Date.now() - t0, worker_id: ev.worker_id, event: ev.event, turn: ev.turn,
      bytes: Buffer.byteLength(text, 'utf8'), orchestrator_idle_at_write: state.idle,
      established_by: ev.event === 'note_refuted' || ev.event === 'scrub_alarm' ? `${ev.event} receipt seq ${ev.seq}` : `worker.list row seq ${ev.seq} for the run`,
    };
    if (ev.event === 'death') {
      rec.exit_code = ev.exit_code; rec.exit_signal = ev.exit_signal; rec.death_established_by = ev.death_established_by;
    }
    if (ev.event === 'paused') rec.paused_by = ev.paused_by;
    if (ev.turns_skipped) rec.turns_skipped = ev.turns_skipped;
    if (hold.holdWake(rec)) return; // 6f design item 2: held while paused, never suppressed
    writeStdinLine(text, ev.worker_id, rec);
    state.wakes.push(rec);
  }

  // 5b: one poll chain for the run's whole life, from the moment the ready check begins until the
  // run is finishing — not only while the orchestrator is idle, because a worker can finish a turn
  // or die while the orchestrator is still mid-turn on its own, and that wake must still reach stdin
  // the moment it is found (ADR 0015's evidence: a wake is cheaper precisely because it does not
  // wait for an idle moment). Started synchronously from the `ready` event itself (`handleEvent`,
  // below), after the synchronous `verifyClaudeReady` check has already run (S2 fix round 3), so that a worker's turn
  // ending inside the orchestrator's own first stdout chunk — ready and its own first turn end can
  // arrive in the very same chunk — is still caught by a read that began before that chunk's later
  // events set the orchestrator busy or idle. 5a-2's guards still hold: at most one store read in
  // flight, and a failed read does not fail open. Every state is read (not just starting/running) so
  // a death is seen. The stdin-close decision is made only while idle (the freshest `state.idle`, not
  // the snapshot): no worker of this run mid-turn (the store's own `mid_turn` column, every turn, not
  // only the first), no wake still unanswered, and (5b-4) no non-terminal row whose pid just died
  // still inside its detector grace.
  async function pollOnce() {
    if (state.finishing || pollInFlight) return;
    pollInFlight = true;
    const turnAtCall = state.turns;
    let list = null;
    let failReason = null;
    try { list = await core.worker.list({}); }
    catch (e) { failReason = (e && (e.code || e.message)) || String(e); }
    state.polls += 1;
    pollInFlight = false;
    if (state.finishing) return; // the run ended while this read was in flight

    if (failReason !== null) {
      if (state.idle) recordHold(turnAtCall, null, awaitingWakeIds(), `worker.list failed: ${failReason}`);
      pollHandle = setTimeout(pollOnce, pollMs);
      return;
    }

    const rows = list.workers || [];
    const nowMs = Date.now() - t0;
    const { events, next, pending_deaths } = diffWorkers({
      prev: state.baseline, rows, runId, nowMs, graceMs: DEATH_GRACE_MS,
      orphanGraceMs: ORPHAN_GRACE_MS, adapterAlive: (pid) => !!pid && P.pidAlive(pid), sinceAt: t0,
    });
    state.baseline = next;
    for (const ev of events.filter((e) => !require('./job-prefixes.cjs').isJobId(String(e.worker_id))).concat(await noteWatcher.poll())) writeWake(ev);
    if (state.finishing) return; // a wake's own write may have found the child already gone

    if (state.idle) {
      const busy = rows.filter((w) => w.run_id === runId && isMidTurn(w)).map((w) => w.id);
      const awaiting = awaitingWakeIds(); // also prunes state.pendingWrites of anything past its expiry
      const pendingIds = pending_deaths.map((p) => p.worker_id);
      // 6f design item 1: a `paused` row holds the close exactly as a mid-turn worker does.
      const parked = rows.filter((w) => w.run_id === runId && w.state === 'paused').map((w) => w.id);
      // 6f-2 design item 1 (blocking, orchestrator.cjs:308): a worker mid-park holds the close too. Its
      // row reads `stopping` with a live pid — not mid-turn (`busy`), not yet `paused` (`parked`), and
      // not a pending death (the pid is alive) — the one gap review 2 found. An ordinary idle `running`
      // or `starting` worker (pid alive, no turn owed) is deliberately NOT held here: the idle-close rule
      // ends the run regardless of a live, merely-idle worker process, by design.
      const live = rows.filter((w) => w.run_id === runId && w.state === 'stopping' && w.pid_alive === true).map((w) => w.id);
      // 6f design item 5: the resume line carries no worker id, so awaitingWakeIds() alone never named
      // it; an idle orchestrator right after resume could otherwise close under that very write before
      // the resumed turn starts. Any write still unanswered, worker-tagged or not, holds the close.
      if (hold.isPaused()) { // 6f design item 2: never closed by the idle rule while paused
        recordHold(turnAtCall, busy, awaiting, 'run paused', pendingIds, parked, live);
      } else if (busy.length === 0 && state.pendingWrites.length === 0 && pendingIds.length === 0 && parked.length === 0 && live.length === 0) {
        closeThenKillOnDeadline('orchestrator ended a turn with no worker mid-turn; stdin closed');
        return;
      } else if (pendingIds.length) {
        recordHold(turnAtCall, busy, awaiting, "worker.list; pid dead, awaiting the detector's row", pendingIds, parked, live);
      } else {
        recordHold(turnAtCall, busy, awaiting, 'worker.list', pendingIds, parked, live);
      }
    }
    pollHandle = setTimeout(pollOnce, pollMs);
  }

  function handleEvent(ev) {
    // ADR 0008 §5: a repeat init for a session already seen is not a restart (a cross-session turn,
    // or step 5b's own wake, both land as a second system/init in the same or a later stdout chunk).
    // 5a-2: the gate is engaged synchronously — `state.readyGateStarted` flips the instant the first
    // ready event is seen — rather than waiting on `state.readyVerified`, which only flips inside a
    // `.then`, at least one microtask after this synchronous event dispatch. Gating on the verified
    // flag alone left a window: a second init in the SAME chunk, carrying a DIFFERENT session id (so
    // not a mere repeat), could re-run the gate before the first check had a chance to land, and kill
    // an already-ready run on the second init's own mcp_servers. Every ready event past the first —
    // repeat or not — is counted rather than acted on.
    if (ev.kind === 'ready') usage.onInit(ev);
    if (ev.kind === 'ready' && !state.finishing) {
      if (ev.repeat || state.readyGateStarted) {
        state.laterInits += 1;
        return;
      }
      state.readyGateStarted = true;
      state.sessionId = ev.session_id; state.init = initFacts(L.DEFAULT_PERMISSION_MODE, ev); // ADR 0021
      // S2 fix round 3 (review 2 should-fix): fix round 2 called checkSurface alone, ahead of the
      // version and mcp_servers checks, so a belay connection failure — whose real init lists no
      // mcp__belay__* tools at all, same as a worker's — was reported as "no mcp__belay__* tool is
      // listed" instead of the true cause. verifyClaudeReady (ready.cjs) is the whole Claude Code
      // branch of the gate, entirely synchronous, in its own fixed order (version, then mcp_servers,
      // then surface), called right here before the poll chain starts. There is no async gate left for
      // the Claude Code orchestrator: verifyReady's own `.then`/`.catch` are gone (nothing else used
      // them), and a turn ending before this line can no longer race it, because there is nothing left
      // to race — the whole check has already run by the time `pollOnce` is reached.
      const gate = verifyClaudeReady({ substrate: 'claude-code', tools: S.ORCHESTRATOR_TOOLS }, ev); // ADR 0054 decision 1: held to its list, which has no Bash
      if (!gate.ok) {
        abortForReadyFailure(`the orchestrator's ready check failed (ADR 0001 §8): ${gate.reason}`);
        return;
      }
      state.readyVerified = true;
      state.readyMs = Date.now() - t0;
      state.surface = S.surfaceFields(gate.evidence); // F4
      if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
      // 5b: the life-long poll chain starts here, synchronously: the ready event and the orchestrator's
      // own first turn end can arrive in the same stdout chunk, processed in the same synchronous pass
      // over its events, so a poll that only started after this handler returns would already find the
      // orchestrator idle. Starting it here means its first read begins before that turn end (later in
      // this same chunk) can set the orchestrator busy or idle.
      pollOnce();
      return;
    }
    if (ev.kind === 'control_response') { hold.onControlResponse(ev); return; } // 6f amendment 3 decision 4.3
    if (ev.kind === 'turn_end') {
      state.turns += 1; usage.onTurnEnd(ev);
      hold.onTurnEnd(ev); // 6f: lets an in-flight run-pause interrupt see the turn it ended

      // 5b-2: the parser now names exactly which write this turn answers, by the order of
      // `system/init` (parsers.cjs header) — `answers_write` — so the FIFO is keyed by that index,
      // not shifted blindly. `answers_write === null` is an uncorrelated (externally triggered) turn
      // and removes nothing; a real match removes that one entry and, when it named a wake, stamps
      // that wake's own record with when it was answered.
      if (ev.answers_write == null) state.externallyTriggeredTurns += 1;
      else PW.answer(state, ev.answers_write, Date.now() - t0, 'init-order');
      state.idle = true;
      // 5a-3: forget the previous idle period's busy set at every turn end, so a hold recorded there
      // is recorded again here even when the busy set is unchanged — a moment is scoped to one turn's
      // idle period, not to the whole run (ADR 0015's evidence table counts a hold at each turn end).
      holdRecorder.reset();
      if (pollHandle) { clearTimeout(pollHandle); pollHandle = null; }
      pollOnce();
      return;
    }
    // A write the substrate reports completed, or (ADR 0023 decision 8) cancelled by an interrupt.
    if (ev.kind === 'write_done') {
      PW.answer(state, ev.answers_write, Date.now() - t0, ev.state === 'cancelled' ? 'command_lifecycle_cancelled' : 'command_lifecycle');
      return;
    }
    if (ev.kind === 'assistant_text' || ev.kind === 'tool_use') {
      // 5b: the poll chain now runs the run's whole life, not only while idle, so going busy again
      // no longer cancels it — a worker's wake still has to reach stdin while the orchestrator works.
      state.idle = false;
    }
  }

  child.stdout.on('data', (chunk) => {
    const { lines, events } = parser.pushChunk(chunk);
    for (const l of lines) { try { fs.writeSync(streamFd, l + '\n'); } catch { /* fd may be closing */ } }
    for (const ev of events) handleEvent(ev);
  });
  child.stderr.on('data', (chunk) => { try { fs.writeSync(stderrFd, chunk); } catch { /* closing */ } });

  function orchestratorBlock() {
    return buildOrchestratorBlock({ child, state, model, argvHash, initFacts, usage: usage.snapshot() });
  }

  return new Promise((resolve) => {
    let settled = false;
    function settle() {
      if (settled) return;
      settled = true;
      clearTimers();
      try { fs.closeSync(streamFd); } catch { /* already closed */ }
      try { fs.closeSync(stderrFd); } catch { /* already closed */ }
      expireStalePendingWrites();
      resolve({
        orchestrator: orchestratorBlock(), ended_by: state.endedBy, holds: state.holds, polls: state.polls,
        wakes: state.wakes, wakes_suppressed: state.wakesSuppressed, wakes_expired: state.wakesExpired,
        wakes_held: hold.wakesHeld, pauses: hold.pauses, // 6f design item 2
      });
    }

    // 5a-2: a spawn failure (the exe missing, a stale BELAY_CLAUDE_EXE) used to crash the whole
    // process with Node's unhandled-'error' dump, outside the promise belay.cjs catches, bypassing
    // even the dispatcher's own `belay run: <detail>` line. Settling directly here, without waiting
    // for an 'exit' event that will never come for a process that never started, and telling
    // `spawnedOk` below not to attempt `run.attach` for a child that was never really there.
    const spawnedOk = new Promise((res) => {
      child.once('spawn', () => res(true));
      child.once('error', (e) => {
        state.finishing = true;
        state.endedBy = `the orchestrator could not be spawned: ${e && e.message}`;
        state.exitCode = null;
        state.exitSignal = null;
        settle();
        res(false);
      });
    });

    child.once('exit', (code, signal) => {
      // Set first, unconditionally: a child that exits before onAttached or the ready timer have
      // even run must stop every later continuation below from mutating a receipt already resolved.
      state.finishing = true;
      state.exitCode = code;
      state.exitSignal = signal;
      if (!state.endedBy) {
        state.endedBy = state.readyVerified
          ? 'the orchestrator exited on its own before any close condition was reached'
          : 'the orchestrator exited before a ready event verified the belay MCP server (ADR 0001 §8)';
      }
      settle();
    });
    child.once('exit', noteExit); // after the listener above: state is already settled by the time this runs

    (async () => {
      if (!(await spawnedOk)) return; // the 'error' listener above has already settled the run
      if (state.finishing) return; // the child already exited while the spawn confirmation was in flight

      // 5c item 4: a `belay stop` arriving earlier gets 'before-spawn'. 6f: `pause`/`resume`/`isPaused` join the hook.
      if (stopControl) {
        try {
          stopControl.attach({
            pid: child.pid, exited: getExitFacts, stop: stopForControl,
            pause: (by) => hold.pause(by), resume: (by, line) => hold.resume(by, line), isPaused: () => hold.isPaused(),
            // 6f-2: lets a run pause/resume refuse a run that is finishing for any reason (run-pause.cjs:50)
            finishing: () => state.finishing, endedBy: () => state.endedBy,
          });
        } catch (e) { // ADR 0045 decision 4: the hook records the orchestrator in the spawn register; one no owner can recognise must not run
          if (state.finishing) return;
          state.finishing = true; state.endedBy = `the orchestrator could not be recorded, so it was ended before its first prompt: ${(e && e.message) || e}`;
          await killChild(); return;
        }
      }

      let attached;
      try { attached = await onAttached({ pid: child.pid }); }
      catch (e) { attached = { ok: false, error: (e && e.message) || String(e) }; }
      if (!attached || attached.ok !== true) {
        if (state.finishing) return; // already ending (e.g. the child died first)
        state.finishing = true;
        state.endedBy = `the run's attach write failed after this process became the store owner: ${(attached && attached.error) || 'attach refused'}`;
        await killChild();
        return; // the exit handler above resolves once the child actually exits
      }
      if (state.finishing) return; // the child already exited while attach was in flight

      readyTimer = setTimeout(() => {
        if (!state.readyVerified) {
          abortForReadyFailure(`no ready event arrived within startup_timeout_ms (${startupTimeoutMs} ms)`);
        }
      }, startupTimeoutMs);
      if (timeoutMs > 0) hold.armTimeout(timeoutMs);
      sigintHandler = () => { closeThenKillOnDeadline('interrupted'); };
      process.on('SIGINT', sigintHandler);

      writeStdinLine(promptText, null); // the child died before it could take the prompt; the exit handler settles this
    })();
  });
}

module.exports = { runOrchestrator, fwd };
