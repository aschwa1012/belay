'use strict';
// wait.cjs — build step 6c, design item 2; rewritten by build
// step 6e-4 (ADR 0023 amendment 2 item 5) for the park design: a settled worker answers its settled state,
// which for a parked worker is `paused` (established by the exit event and the park); a turn ending while
// a park is under way is reported `paused` too, never `turn_failed`. The live-paused special cases (an
// already-finished path reading a separate "was this turn the pause's own" flag) are gone with the design
// they belonged to — a paused worker is always settled, so the first check below already answers it.

const W = require('./worker.cjs');
const P = require('./process.cjs');
const { fail } = require('./errors.cjs');
const EV = require('./wait-eval.cjs'); // gap 9: a later wait holds for a release evaluation in flight

const now = () => Date.now();
// ADR 0058: messages queued during a compaction that a pause, park or relaunch dropped are named in every answer about the worker.
const dropped = (w) => (w.queuedDropped && w.queuedDropped.length ? { queued_dropped: w.queuedDropped } : {});
// The previous process's terminal row a relaunch overtook (exit.cjs lifeWrite): its exit facts, on the answers about this life only.
const priorRow = (w) => (w.droppedRow && w.droppedRow.launch === w.launches ? { previous_row_dropped: w.droppedRow } : {});

function createWait({ workers, get, core = null }) {
  // ADR 0015 §1. Blocks until one of the named workers (or any worker this manager launched)
  // finishes a turn or dies, or the timeout passes. It is the same shape as `spawn`'s wait for the ready
  // event, pointed at the next event instead: a tool call that has not returned holds the orchestrator's
  // turn open, which is the one thing a headless session cannot otherwise do while a worker works.
  // Everything it returns is derived — the event, what established it, the exit code or the checkpoint —
  // never a row's claim. A timeout is a result (`timed_out: true`), not an error, because the caller's
  // harness has its own tool timeout and this one has to come back under it.
  return async function wait({ worker_ids = null, timeout_ms = 110000 } = {}) {
    const t0 = now();
    const ids = Array.isArray(worker_ids) && worker_ids.length ? worker_ids : [...workers.keys()];
    if (!ids.length) fail('E_ARGS', 'wait needs a worker, and this run manager has launched none');
    const ws = ids.map(get);
    const requested = Math.max(1, Number(timeout_ms) || 110000);
    // ADR 0029 decision 5: the adapter inherits the client's tool timeout (MCP_TOOL_TIMEOUT, read at call
    // time); a wait longer than that fails at the client, so it is capped at that value less 10,000 ms (at
    // least 1,000 ms) and the answer says so. Absent, empty, non-numeric or non-positive: unchanged.
    const envTmo = /^\d+$/.test(String(process.env.MCP_TOOL_TIMEOUT || '').trim()) ? Number(String(process.env.MCP_TOOL_TIMEOUT).trim()) : 0;
    const limit = envTmo > 0 ? Math.max(1000, envTmo - 10000) : Infinity;
    const ms = Math.min(requested, limit);
    const capNote = ms < requested
      ? { timeout_capped: { requested_ms: requested, used_ms: ms, by: `MCP_TOOL_TIMEOUT ${envTmo} ms less a 10,000 ms margin (ADR 0029)` } }
      : null;
    // The state settle() wrote once, fixed at the death; w.state is the fallback for a record adopt()
    // built and never ran settle() on (invariant 4: no affirmative dead this adapter never established).
    // 6e-5 item 2 (review 1/2 notes, wait.cjs:33/:34): `w.parkRequested`, not `w.paused` — it is set
    // synchronously at the park's own acceptance, well before settle() ever runs, so this never reads
    // 'unknown at null' for a wait that raced ahead of doPause's own settled-record write.
    const settledOf = (w) => ({
      worker_id: w.id, event: w.settledState != null ? w.settledState : w.state,
      established_by: w.settledState === 'paused'
        ? `${w.deathEstablishedBy}; parked by ${w.parkRequested ? w.parkRequested.by : 'unknown'} at ${w.parkRequested ? w.parkRequested.at : null}`
        : w.deathEstablishedBy,
      exit_code: w.exitCode, exit_signal: w.exitSignal, turn: w.turns, ...dropped(w),
    });
    // build step 6e-4: `v.paused` is onTurnEnd's own `!!w.parkRequested` at the turn's own end (worker.cjs);
    // a paused worker never reaches here through the already-finished path below, since it is always
    // settled by the time anyone can ask (a live worker between turns is simply not paused any more).
    const turnOf = (w, v) => {
      const paused = !!(v && v.paused);
      return {
        worker_id: w.id, event: paused ? 'paused' : (v && v.failed ? 'turn_failed' : 'turn_end'),
        established_by: paused
          ? 'result event on the worker stream after the pause interrupted the turn; the worker was then parked'
          : 'result event on the worker stream',
        turn: w.turns,
        checkpoint_id: (v && v.checkpoint_id) || w.lastCheckpointId, is_error: !!(v && v.is_error),
        usage: (v && v.usage) || w.lastTurnUsage || null, ...dropped(w), ...priorRow(w), ...require('./release-eval.cjs').evalOf(w), // ADR 0058: evaluated once it lands, evaluating while it runs
      };
    };
    // ADR 0058, the idle-workers amendment (proposed): every answer names the workers this manager launched that sit idle with no task.
    const idleOf = async () => { const v = await require('./idle-remind.cjs').idleRecords(core, workers.values()); return v.length ? { idle_without_task: v } : {}; };
    const done = async (r) => ({ ...r, waited_ms: now() - t0, timed_out: false, watched: ids, ...capNote, ...(await idleOf()) });
    // build step 6e-6 item 4 (carried item 4, wait.cjs:37): once clearParkForStop or checkNotStale
    // (pause.cjs) has found this record's own park belongs to a row another adapter now holds, every wait
    // answers `stale` at once, naming the row's own state and the adapter that now holds it — never the
    // old `paused ... parked by unknown at null`, which read `w.parkRequested` after it had already been
    // cleared by the very same discovery.
    const staleOf = (w) => ({
      worker_id: w.id, event: 'stale',
      established_by: `row state ${w.staleSince.row_state}, held by adapter ${w.staleSince.adapter_pid}`,
      exit_code: w.exitCode, exit_signal: w.exitSignal, turn: w.turns,
    });
    // Anything already finished answers at once: a settled worker (a parked one always is), or one whose
    // last turn ended and that has not been given another message since (`message` clears `turnEnded`).
    // One rule for both paths (build 12 w2-flakes): a death the pid poll established before the child's exit
    // event arrived has no code yet, and the event can trail the poll by seconds under load
    // (w2-flakes/exit-lag-32.txt). The code is the receipt's most useful field, so wait for the event inside
    // what is left of this call's own budget. A relaunch resolves the awaited promise (worker.cjs attach),
    // an adopted record has none: both return at once with what the record has.
    // Only a death established by a pid check can be waiting on an exit event; a spawn-error death (ENOENT
    // emits error and close, never exit) has none coming and answers at once (review 2 R2-B1).
    const withCode = (w) => (W.deathByPidCheck(w)
      ? W.awaitExitCode(w, Math.max(0, ms - (now() - t0))) : undefined);
    // ADR 0048: a restart whose relaunch is still under way (it returned early over MCP) has not settled. Until it launches, the
    // record is still the OLD life, whose stop would otherwise be answered as if it were this worker's end. So a worker with a
    // restart in flight is skipped by the already-finished checks and watched through its relaunch instead; the call answers
    // whichever comes first, a worker that has already finished or any relaunch (a failed one is the answer, naming its worker).
    const failedOf = (w, e) => ({ worker_id: w.id, event: 'restart_failed', established_by: `the relaunch failed: ${(e && e.message) || e}`, error_code: (e && e.code) || null, exit_code: w.exitCode, exit_signal: w.exitSignal, turn: w.turns });
    const finishedOf = (w) => (w.staleSince ? { ...staleOf(w), already: true } : w.settled ? { ...settledOf(w), already: true } : w.turnEnded ? { ...turnOf(w, null), already: true } : null);
    // Gap 9 (ADR 0058's evaluation at release): a turn that already ended with its hand-back still being evaluated is not answered at
    // once with `evaluating` again; the wait holds, within its own bound, until that evaluation ends, and answers with its result.
    const evaluating = [];
    for (const w of ws) {
      if (w.restartInFlight) continue;
      if (w.staleSince) return done({ ...staleOf(w), already: true });
      if (w.settled) { if (w.exitCode == null && w.exitSignal == null) await withCode(w); return done({ ...settledOf(w), already: true }); }
      if (w.turnEnded && EV.evaluatingOf(w)) { evaluating.push(w); continue; }
      if (w.turnEnded) return done({ ...turnOf(w, null), already: true });
    }
    // The hold ended. A stop that cancelled the evaluation has not settled yet: answer as the stop will (its settled state), never as
    // a finished turn. Any other cancel is named in the answer, so a caller can tell a cancelled evaluation from one that found nothing.
    const afterHold = (w, ev) => {
      if (w.stopRequested && !w.settled) return watch(w);
      const r = finishedOf(w);
      if (!r) return watch(w);
      return ev && ev.cancelled && r.event === 'turn_end' ? { ...r, evaluation: 'cancelled' } : r;
    };
    const never = new Promise(() => {});
    // build step 6e-6 item 2 (`settle`, worker.cjs): `waitTurn` now also resolves on the worker's own
    // exit (`v.exited`), for `restart`'s own first-turn wait; here that shape is routed through
    // `settledOf`, exactly as `waitExit`'s own resolution is, so a worker that dies mid-turn (no
    // `turn_end` event ever reached) still answers its settled state (`dead`, `stopped`, `paused`…),
    // never a manufactured `turn_end` this stream never produced.
    const watch = (w) => (w.restartInFlight
      ? w.restartInFlight.then(() => finishedOf(w) || watch(w), (e) => failedOf(w, e))
      : Promise.race([
        W.waitTurn(w, ms).then((v) => (v ? (v.exited ? { ...settledOf(w) } : { ...turnOf(w, v) }) : never)),
        W.waitExit(w, ms).then((v) => (v ? { ...settledOf(w) } : never)),
      ]));
    const winner = await Promise.race([
      ...ws.filter((w) => !evaluating.includes(w)).map(watch),
      // The worker stays watched through the hold: its death, stop or park, and a turn begun or ended meanwhile, answer as they would
      // without it. Once the evaluation ends the worker is looked at again, so a turn begun during the hold is not answered as the old one.
      ...evaluating.map((w) => { const ev = w.evaluation; return Promise.race([watch(w), EV.evaluationEnded(w).then(() => afterHold(w, ev))]); }),
      new Promise((res) => { const t = setTimeout(() => res(null), ms); if (t.unref) t.unref(); }),
    ]);
    if (winner && winner.event !== 'restart_failed' && 'exit_code' in winner && winner.exit_code == null && winner.exit_signal == null) {
      const w = ws.find((x) => x.id === winner.worker_id);
      if (w) { await withCode(w); return done({ ...settledOf(w) }); }
    }
    if (winner) return done(winner);
    // Only what is still in flight: a cancelled evaluation, or one that ended without an answer, is not listed with empty tasks.
    const stillEvaluating = evaluating.map((w) => ({ worker_id: w.id, turn: w.turns, tasks: EV.evaluatingOf(w) })).filter((e) => e.tasks);
    return {
      worker_id: null, event: null, timed_out: true, waited_ms: now() - t0, watched: ids,
      ...(stillEvaluating.length ? { still_evaluating: stillEvaluating } : {}),
      busy: ws.filter((w) => !w.settled && !w.turnEnded).map((w) => ({
        worker_id: w.id, state: w.state, pid_alive: w.pid ? P.pidAlive(w.pid) : false,
        last_event_age_ms: w.lastEventAt ? now() - w.lastEventAt : null, turns: w.turns,
      })),
      ...capNote, ...(await idleOf()),
    };
  };
}

module.exports = { createWait };
