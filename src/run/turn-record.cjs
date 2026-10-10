'use strict';
// turn-record.cjs — build step 6i-2 fix round (reviewer should-fix on item 3): onTurnEnd's own
// continuity.checkpoint and memory.store calls (moved here whole from worker.cjs:229-247, never
// compressed, to keep worker.cjs under its own 400-line budget) used to run unconditionally, so a
// turn_end parsed from a buffered stdout chunk after shutdown() had already called core.shutdownOwner()
// re-elected a real store owner inside this process through these two direct core calls (probe-late-turn,
// 2 of 2) — write-row.cjs's own closed-flag check (design item 3) never saw them, since neither goes
// through writeRow. Gated the same way: checked first, before any core call, and the drop is named on
// the record exactly as write-row.cjs names its own.

const MC = require('./memory-capture.cjs');

// Runs the turn's own checkpoint and memory write, or, once `ctx.shutdownFlags.closed` is set, neither —
// recording the drop instead. Returns the checkpoint id (or null), exactly as the inline block did.
// `memoryTextMax` and `digestKeep` are worker.cjs's own constants, passed in rather than duplicated.
async function recordTurn(w, e, ctx, memoryTextMax, digestKeep) {
  if (ctx.shutdownFlags && ctx.shutdownFlags.closed) {
    w.lastError = { where: 'after-shutdown', state: 'turn-record' };
    return null;
  }
  const { core } = ctx;
  void memoryTextMax; // the memory write is queueMemory's (below); kept in the signature for callers
  let checkpointId = null;
  // A checkpoint row belongs to a task: `continuity.checkpoint` refuses E_ARGS without a task_id.
  // A worker spawned with no task therefore gets no checkpoint, and the reason is recorded rather
  // than swallowed. Its turn text still reaches memory, so the turn is not lost.
  if (!w.taskId) {
    w.checkpointsSkipped = (w.checkpointsSkipped || 0) + 1;
    w.lastError = { where: 'continuity.checkpoint', code: 'E_ARGS', message: 'worker has no task_id, so there is no task to checkpoint against' };
  } else {
    try {
      const cp = await core.continuity.checkpoint({
        task_id: w.taskId, worker_id: w.id, turn: w.turns,
        files_touched: [...w.filesTouched], tool_digest: w.digest.slice(-digestKeep),
      });
      checkpointId = cp && cp.id;
      w.lastCheckpointId = checkpointId || w.lastCheckpointId;
    } catch (err) {
      w.lastError = { where: 'continuity.checkpoint', code: err && err.code, message: err && err.message };
    }
  }
  return checkpointId;
}

// Review 3, finding F: the turn's memory write (an embed, about 0.5 s with voyage and seconds on an
// owner's first turn) is off the turn path. onTurnEnd calls this AFTER the waiters are resolved and the
// worker row is written and does not await it. Writes are chained on the worker's own `memoryQueue`, so
// they stay in order; a write not yet started once shutdown has closed the flag is dropped and recorded.
// lifecycle.cjs's shutdown awaits every queue for at most 5,000 ms before it closes the core.
function queueMemory(w, e, ctx, memoryTextMax, checkpointId) {
  const text = (e.text || w.lastAssistantText || '').slice(0, memoryTextMax);
  const plan = MC.plan(w, e, ctx); // null with the capture and job levers off: then nothing below differs from base
  if ((!text && !plan) || (ctx.shutdownFlags && ctx.shutdownFlags.closed)) return;
  const turn = w.turns;
  const { core } = ctx;
  w.memoryQueue = (w.memoryQueue || Promise.resolve()).then(async () => {
    if (ctx.shutdownFlags && ctx.shutdownFlags.closed) { w.lastError = { where: 'after-shutdown', state: 'turn-memory' }; return; }
    let turnRowId = null;
    if (text) {
      try {
        // With a memory lever on, the row names the worker it is about (the adapter writes it as the
        // orchestrator). With every lever off it is the base row, byte for byte.
        const row = await core.memory.store({
          text, type: 'turn', ...(plan ? { worker_id: w.id } : {}),
          tags: [w.taskId, w.id, 'turn:' + turn].filter(Boolean),
          provenance: checkpointId ? 'checkpoint:' + checkpointId : 'worker:' + w.id,
        });
        turnRowId = (row && row.id) || null;
      } catch (err) {
        w.lastError = { where: 'memory.store', code: err && err.code, message: err && err.message };
      }
    }
    if (plan) await MC.finish(w, e, ctx, plan, { checkpointId, turnRowId }); // the observation, then the jobs (ADR 0041 decisions 3, 7)
  });
}

module.exports = { recordTurn, queueMemory };
