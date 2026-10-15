'use strict';
// pause.cjs — build step 6e-4, ADR 0023 amendment 2, closed
// by 6e-5. A pause parks the worker: it
// interrupts unconditionally, stops every background task seen running, snapshots and re-kills surviving
// descendants around the existing graceful stop, and writes the row `paused` from the exit handler. Resume
// relaunches through restart's own resume-or-replace path on the launch options the worker actually had
// (item 5). Both run through the one operation slot (lifecycle.cjs); a stale record defers to the row
// (item 6). Codex is docked; an adopted worker this adapter never spawned holds no stdin to interrupt.

const P = require('./process.cjs');
const BG = require('./background.cjs');
const L = require('./launch.cjs');
const { fail } = require('./errors.cjs');
const { CLAUDE_RESUME_WINDOW_MS } = require('./restart.cjs');
// 6i-2 fix round (item 7/R9): sendInterrupt moved out to make room for isOwnActiveRow's fix, below.
const { sendInterrupt } = require('./pause-interrupt.cjs');

const now = () => Date.now();
const INTERRUPT_TIMEOUT_MS = 5000;
const EXIT_TIMEOUT_MS = 10000;
// 6e-2 design item 7 (kept): wording B from the resume probe. A and B each continued 3 of 3 real drives
// outside any repository; the pre-registered rule keeps B on that tie.
const RESUME_LINE = 'I paused you a moment ago; that pause is what rejected your last tool call with '
  + '"The user doesn\'t want to proceed with this tool use". The pause is over. Please continue your '
  + 'task from where you left off, re-running that call if it is still needed.';
// ADR 0023 amendment 2 decision 2: the line for a park that found no turn running.
const PAUSE_OVER_LINE = 'I paused you a moment ago and the pause is over. Please continue your task from where you left off.';

// 6f-2 design item 7 (6e-6 review 2 should-fix, pause.cjs:105 and :78, the fix round's regression): every
// row this adapter's own manager ever writes (`rowOf`, whatever state — starting, running, stopping,
// stopped, dead, idle) carries `adapter_pid: ctx.adapterPid`, genuinely this adapter's own. The one
// exception is `forgotten`: `worker.forget` (methods-run.cjs) appends it by copying the *previous* row's
// fields wholesale, adapter_pid included, without this adapter (or any manager) writing it — so a
// forgotten row's adapter_pid names whoever held the worker before the forget, never a write this
// adapter made. `paused` is handled by the caller before this helper ever runs (still agrees outright).
// 6i-2 fix round (item 7/R9): a bare live-state list fixes (h16) but breaks park-3's (r4) second scenario
// — a resume whose 'starting' write commits but throws to its caller can settle in any terminal state
// (dead, not only stopped), genuinely this adapter's own write, indistinguishable from h16's planted
// row by state alone. `relaunchedSincePark` (w.launches grown since doPause's own snapshot, worker.cjs's
// `launchesAtPark`) is the discriminator: r4's w2 was relaunched (launch() ran) between its park and its
// stop, so any non-forgotten row of ours is trusted, exactly as before; h16's w1 was never relaunched, so
// only a row still in a live state of ours counts as active — a stopped row planted directly, bypassing
// this adapter's own writes, is not.
function isOwnActiveRow(row, adapterPid, relaunchedSincePark) {
  if (row.state === 'forgotten' || row.adapter_pid !== adapterPid) return false;
  if (relaunchedSincePark) return true;
  return row.state === 'starting' || row.state === 'running' || row.state === 'stopping' || row.state === 'paused';
}

function createPause({ core, forWorker, doStop, doRestart, runOp, adapterPid = process.pid, writeRow }) {
  // Refuses `message` and `restart` while a park is under way or complete (`w.parkRequested` is set the
  // instant a park begins, and stays set through a fully-paused row).
  function refuseIfPaused(w) {
    // 6e-6 item 4 (carried item 4, wait.cjs:37): a record already found stale refuses E_SUBSTRATE, not
    // E_PAUSED — the same wording `checkNotStale` uses; the worker runs under another adapter now.
    if (w.staleSince) {
      fail('E_SUBSTRATE', `worker ${w.id} was resumed by adapter ${w.staleSince.adapter_pid}; this adapter holds no process for it`,
        { worker_id: w.id, row_state: w.staleSince.row_state, adapter_pid: w.staleSince.adapter_pid });
    }
    // Fix round, should-fix finding: keyed on the in-memory facts alone, never on `w.state`, which a
    // stop of a paused worker clears them ahead of — reading it here raced a null `src` into a TypeError.
    const src = w.parkRequested || w.paused;
    if (src) {
      const advice = /embedder-failure [(]/.test(String(src.by)) ? ` ${require('../core/embedder-mode.cjs').pauseAdvice(w.run_id)}` : '';
      fail('E_PAUSED', `worker ${w.id} is paused (by ${src.by} at ${src.at}); resume it first${advice}`,
        { worker_id: w.id, paused_at: src.at, paused_by: src.by });
    } else if (w.state === 'paused') fail('E_PAUSED', `worker ${w.id} is paused; resume it first`, { worker_id: w.id }); // fix round #2, pause.cjs:81: a stale stop leaves w.state 'paused' after clearing parkRequested/paused
  }

  // 6e-5 item 6: the row, not memory, decides whether a record `pause`/`resume` believes parked still is;
  // stale is cleared and refused, naming the row's own state and the adapter that now holds it. 6e-6 item
  // 4: kept on the record (`w.staleSince`), so every later read (`wait`, `shutdown`, a second call) stales too.
  function checkNotStale(w, worker_id, row) {
    if (row.state === 'paused') return; // still agrees; not stale
    // build step 6i item 6 (C13): a *live* claim of ours only (starting/running/stopping) — stopped/dead/idle is history.
    if ((row.state === 'starting' || row.state === 'running' || row.state === 'stopping') && row.adapter_pid === adapterPid) return;
    w.paused = null;
    w.parkRequested = null;
    w.staleSince = { at: now(), row_state: row.state, adapter_pid: row.adapter_pid };
    fail('E_SUBSTRATE', `worker ${worker_id} was resumed by adapter ${row.adapter_pid}; this adapter holds no process for it`,
      { worker_id, row_state: row.state, adapter_pid: row.adapter_pid });
  }

  // Shared with manager.cjs's `stop`, which is never refused: a stale record's stop must still clear its
  // park state, but write nothing over a different adapter's row. Keyed on `w.state`, not `w.paused` —
  // an earlier stale `pause`/`resume` refusal already cleared `w.paused`, but never `w.state`, so this
  // still catches a second stop of the same stale record. Returns `{ stale, wasParked }`.
  // 6e-6 item 3 (carried item 2, manager.cjs:335/:351): `wasParked` (`doStop`'s `treatPidAsDead`, so a
  // park's dead-by-construction pid, reused or not, is never re-checked) is true only when this adapter
  // holds no live child for the worker. A resume whose 'starting' write fails, or lands before `w.state`
  // catches up, can leave `w.state` (even the row) reading 'paused' while a live child this adapter itself
  // spawned is attached (`w.child`, set the instant `launch`, manager.cjs, ran) — checked first, before the
  // row is ever read, so it is never mistaken for a park held no more, nor another adapter's resume. Only
  // once no live child of ours answers for the worker does the row decide; disagreement there is
  // staleness, named on the record (`w.staleSince`) for every later read.
  async function clearParkForStop(w, worker_id) {
    const wasPaused = w.state === 'paused';
    const hadChild = !!w.child;
    let stale = false;
    let row = null;
    if (wasPaused && !hadChild) {
      row = await core.worker.get({ worker_id });
      // 6i-2 fix round (item 7/R9): relaunched since the park's own snapshot (worker.cjs's launchesAtPark)
      // decides which breadth of isOwnActiveRow applies — see its own comment above.
      const relaunchedSincePark = w.launches > (w.launchesAtPark || 0);
      stale = row.state !== 'paused' && !isOwnActiveRow(row, adapterPid, relaunchedSincePark); // design item 7: own active write, never stale
    }
    w.parkRequested = null;
    w.paused = null;
    if (stale) w.staleSince = { at: now(), row_state: row.state, adapter_pid: row.adapter_pid };
    return { stale, wasParked: wasPaused && !hadChild };
  }

  function cacheDeadlineFor(w) {
    return {
      at: (w.lastTurnEndAt || w.readyAt || w.launchedAt) + CLAUDE_RESUME_WINDOW_MS,
      basis: 'the last turn end plus CLAUDE_RESUME_WINDOW_MS (55 min, src/run/restart.cjs)',
      provenance: 'a resume has been observed hitting the cache only up to 7 min idle (not yet measured on this host)', enforced: false,
    };
  }

  // ADR 0023 amendment 2 decision 1, steps 1-6. Runs inside the operation slot as 'pause': nothing else
  // touches this worker's stdin or process state while it runs, so no re-check against a concurrent
  // operation is needed here (only against the process ending on its own, which sendInterrupt/stopTasks
  // and doStop each guard for independently).
  async function doPause(w, by, interrupt_timeout_ms, exit_timeout_ms) {
    const worker_id = w.id;
    // Step 1: synchronous, before any await, so refuseIfPaused holds from this instant.
    w.parkRequested = { at: now(), by, resultsSeen: [] };
    // 6i-2 fix round (item 7/R9): this park's own launches snapshot, read back by clearParkForStop's
    // isOwnActiveRow discriminator even after a later launch() resets parkRequested to null.
    w.launchesAtPark = w.launches;

    // Step 1b (6f-2 fix round, blocking finding, orchestrator.cjs:291): a store-visible `stopping` row,
    // written before the interrupt/stop_task/childPids work below (693-1709 ms on this host) rather than
    // only once doStop's own write (step 4) is reached, so the run's idle close can hold on this park from
    // its acceptance, not only once that work has finished. The pid is confirmed alive by `pause()`'s own
    // checks just above; doStop (manager.cjs) skips its own `stopping` write when this one has landed, and
    // writes it itself only if this one failed (a failed write here is swallowed, reopening the window).
    w.parkTurns = w.turns; // 6i item 1 (C2): this park's own turns, carried by rowOf so wake.cjs unmasks up to it.
    try { await writeRow(w, 'stopping'); } catch { /* the definitive write is doStop's own, below */ }

    // Step 2: the interrupt and every running background task's stop_task, one bound, starting now.
    // 6e-5 item 3 (review 2, pause.cjs:114): `interruptAt`, set synchronously, lets onTurnEnd (worker.cjs)
    // tell a result that truly landed after the interrupt from one whose queued write merely ran late.
    w.parkRequested.interruptAt = now();
    const [interrupt, background_tasks] = await Promise.all([
      sendInterrupt(w, interrupt_timeout_ms),
      BG.stopTasks(w, { boundMs: interrupt_timeout_ms }),
    ]);

    // Step 3: the descendants a graceful close is about to orphan, before it runs.
    // ADR 0039: each carries its creation time, taken now, and is verified again before any kill below.
    const descendantTargets = await P.descendantTargets(w.pid).catch(() => []);
    const descendants_before_close = descendantTargets.map((d) => d.pid);

    // Step 4: the existing graceful stop, its own exact-pid kill fallback. Direct, not the slot: this
    // call already holds it as 'pause' (no self-deadlock).
    const stopReceipt = await doStop(w, 'graceful', exit_timeout_ms);

    // Step 5: any snapshot descendant still alive after the exit, killed by exact pid.
    const afterExit = await P.killMany(descendantTargets).catch(() => []);
    const killed_after_exit = afterExit.filter((k) => k.killed).map((k) => k.pid);
    const refused_after_exit = afterExit.filter((k) => k.refused);

    // Step 6: the exit handler's own write (settle -> terminalState -> 'paused') is queued on w.queue;
    // wait it out, then read the row it produced.
    await w.queue;
    const row = await core.worker.get({ worker_id });

    const results_after_interrupt = w.parkRequested.resultsSeen;
    const interrupted = results_after_interrupt.includes('error_during_execution');
    const paused_at = w.parkRequested.at;
    w.paused = { at: paused_at, by, interrupted, session_id: w.sessionId };

    return {
      worker_id, paused: true, already: false, paused_at, paused_by: by, interrupted,
      interrupt, results_after_interrupt,
      background_tasks,
      exit: { graceful: stopReceipt.graceful, killed: stopReceipt.killed, exit_code: stopReceipt.exit_code, exit_signal: stopReceipt.exit_signal, ms_after_close: stopReceipt.ms_to_exit },
      descendants: { before_close: descendants_before_close, killed_after_exit, refused_after_exit, kills: afterExit.filter((k) => k.killed || k.refused) },
      session_id: w.sessionId, cache_deadline: cacheDeadlineFor(w), row,
    };
  }

  async function pause({ worker_id, by, interrupt_timeout_ms = INTERRUPT_TIMEOUT_MS, exit_timeout_ms = EXIT_TIMEOUT_MS }) {
    if (typeof by !== 'string' || !by) fail('E_ARGS', 'pause needs by as a non-empty string naming who is pausing', { worker_id });
    if (!Number.isInteger(interrupt_timeout_ms) || interrupt_timeout_ms < 1 || interrupt_timeout_ms > 30000) {
      fail('E_ARGS', 'pause needs interrupt_timeout_ms as an integer between 1 and 30000', { worker_id, interrupt_timeout_ms });
    }
    if (!Number.isInteger(exit_timeout_ms) || exit_timeout_ms < 1 || exit_timeout_ms > 30000) {
      fail('E_ARGS', 'pause needs exit_timeout_ms as an integer between 1 and 30000', { worker_id, exit_timeout_ms });
    }
    const w = await forWorker(worker_id);
    // The refusal ladder and the already-paused answer both run inside the slot: a genuinely in-flight
    // pause is shared by lifecycle.cjs's own name match before either ever runs (never re-refused).
    return runOp(w, 'pause', async () => {
      if (w.paused) {
        const row = await core.worker.get({ worker_id }); // 6e-5 item 6: stale defers to the row below
        checkNotStale(w, worker_id, row);
        return {
          worker_id, paused: true, already: true, paused_at: w.paused.at, paused_by: w.paused.by,
          interrupted: w.paused.interrupted, session_id: w.paused.session_id, row,
        };
      }
      if (w.substrate === 'codex') {
        fail('E_SUBSTRATE', 'codex has no interrupt channel: a Codex turn is a process with stdin ignored; '
          + 'pause is docked for Codex (ADR 0023 decision 2); worker stop or worker kill end a Codex turn',
          { worker_id, substrate: w.substrate });
      }
      if (w.settled || !P.pidAlive(w.pid) || !w.child || !w.child.stdin || w.child.stdin.destroyed) {
        if (w.adopted && !w.launches) {
          fail('E_SUBSTRATE', `this adapter did not spawn worker ${worker_id}, so it holds no stdin to interrupt`, { worker_id, adopted: true });
        }
        fail('E_WORKER_NOT_LIVE', `worker ${worker_id} is not live, so it cannot be paused`, { worker_id, state: w.state, pid: w.pid });
      }
      if (w.stopRequested) {
        fail('E_ARGS', `worker ${worker_id} is stopping, and pause needs a worker that has finished starting and is not stopping`, { worker_id, state: 'stopping' });
      }
      if (!w.readyAt) {
        fail('E_ARGS', `worker ${worker_id} is starting, and pause needs a worker that has finished starting and is not stopping`, { worker_id, state: 'starting' });
      }
      return doPause(w, by, interrupt_timeout_ms, exit_timeout_ms);
    }, {});
  }

  // ADR 0023 amendment 2 decision 2: relaunch through restart's own resume-or-replace path, under two
  // internal options doRestart (manager.cjs) takes: an overridden first message, and awaitFirstTurn:false
  // so the slot frees the instant the relaunch's `running` row lands, not at the resumed turn's own end.
  async function doResume(w, by, text) {
    const p = w.paused; // set by doPause, or by adopt() from the row (interrupted always false there)
    const paused_at = p ? p.at : null;
    const paused_by = p ? p.by : null;
    const interrupted = !!(p && p.interrupted);
    const paused_for_ms = paused_at != null ? now() - paused_at : null;
    let resume_line_error = null;
    let sentBody = ''; // the actual first message sent, captured for text_bytes below

    const restartRes = await doRestart(w, {
      firstTextOverride: async (branch) => {
        if (branch !== 'resume') return undefined; // the replace branch uses restart's own replace text
        let body = interrupted ? RESUME_LINE : PAUSE_OVER_LINE;
        if (w.taskId) {
          try {
            const rl = await core.continuity.resumeLine({ task_id: w.taskId });
            if (rl && rl.text) body += '\n\n' + rl.text;
          } catch (e) {
            resume_line_error = { code: e && e.code, message: e && e.message };
          }
        }
        return body;
      },
      appendMessage: text,
      awaitFirstTurn: false,
      onFirstText: (t) => { sentBody = t; },
      // Fix round, should-fix finding: a park's own pid is dead by construction (the exit is observed
      // before the row is written); treating it as a still-alive orphan risks killing a bystander that
      // reused the pid across a long park, on this same-adapter or a cross-adapter resume alike.
      skipDeadPidKill: true,
    });

    return {
      ...restartRes, resumed: true, resumed_by: by, paused_at, paused_by, paused_for_ms, interrupted,
      text_bytes: Buffer.byteLength(sentBody, 'utf8'), resume_line_error,
      // build step 6e-5 design item 5: names what the relaunch actually used — `adopt` (worker.cjs) now
      // restores the row-less model, allowed tools and permission-prompt opt-in from the worker's own
      // argv.json/mcp.json, even across adapters, so this is no longer this build's bare default.
      model: w.model || L.DEFAULT_CLAUDE_MODEL, permission_prompt: !!w.permissionPrompt,
      effort: w.effort || null, // ADR 0028: the level the relaunch was given (S6b SF3)
    };
  }

  async function resume({ worker_id, by, message: text = null }) {
    if (typeof by !== 'string' || !by) fail('E_ARGS', 'resume needs by as a non-empty string naming who is resuming', { worker_id });
    if (text !== null && (typeof text !== 'string' || !text)) fail('E_ARGS', 'resume needs message to be null or a non-empty string', { worker_id });
    const w = await forWorker(worker_id); // adopts a parked worker from the store when this adapter never saw it
    return runOp(w, 'resume', async () => {
      if (w.state !== 'paused') fail('E_ARGS', `worker ${worker_id} is not paused (state ${w.state})`, { worker_id, state: w.state });
      // design item 6: the row, not memory, decides — checked fresh every call, so a second resume of a
      // stale record (whose earlier refusal already cleared `w.paused` but never `w.state`) is refused again.
      checkNotStale(w, worker_id, await core.worker.get({ worker_id }));
      return doResume(w, by, text);
    }, {});
  }

  return { pause, resume, refuseIfPaused, clearParkForStop };
}

module.exports = { createPause, INTERRUPT_TIMEOUT_MS, EXIT_TIMEOUT_MS, RESUME_LINE, PAUSE_OVER_LINE };
