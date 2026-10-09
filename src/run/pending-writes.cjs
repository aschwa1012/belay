'use strict';
// The orchestrator's stdin writes not yet answered: moved out of orchestrator.cjs (the 500-line rule)
// with the wake-correlation fix, which added a second way to answer one.
//
// A write is answered by whichever arrives first:
//   - a turn end whose `answers_write` names it (5b-2, correlated by the order of `system/init`);
//   - the substrate's own `command_lifecycle` event, state `completed`, for the `uuid` the write
//     carried.
// The second exists because Claude Code folds a message that arrives during a running turn into
// that turn: one `system/init`, one `result`, both writes consumed. Correlated by init order alone,
// the folded write was never answered and held an idle run open until the expiry below (a 103 s hang measured
// in a probe). `command_lifecycle` reports each write by the uuid the harness gave it, whether
// it ran as its own turn or was folded, so no write is matched by its content.

// 5b fix round, finding 2, moved verbatim in behaviour: an entry older than `mcp_tool_timeout_ms` is
// given up on, named in `state.wakesExpired` (never counted as answered), stops blocking close, and
// stamps its own wake record `expired: true`, so `wakes[]` always says what became of it. With the
// lifecycle answer in place this is a backstop for a binary that does not emit the event.
function expireStale(state, nowMs, timeoutMs) {
  if (!state.pendingWrites.length) return;
  const cutoff = nowMs - timeoutMs;
  state.pendingWrites = state.pendingWrites.filter((p) => {
    if (p.at_ms > cutoff) return true;
    state.wakesExpired.push({ worker_id: p.worker_id, written_at_ms: p.at_ms, waited_ms: nowMs - p.at_ms });
    if (p.wakeRecord) p.wakeRecord.expired = true;
    return false;
  });
}

// The worker ids named by the writes still pending, after pruning any that aged out. The prompt's
// own entry carries no worker id and never appears here.
function awaitingIds(state, nowMs, timeoutMs) {
  expireStale(state, nowMs, timeoutMs);
  const seen = new Set();
  for (const p of state.pendingWrites) if (p.worker_id) seen.add(p.worker_id);
  return [...seen];
}

// Remove the entry for write `index`, stamping its wake record with when and by what it was
// answered. Returns false when no entry is pending for that index (already answered the other way,
// or expired), which is not an error: both answers arrive for most writes.
function answer(state, index, nowMs, by) {
  const i = state.pendingWrites.findIndex((p) => p.index === index);
  if (i === -1) return false;
  const [entry] = state.pendingWrites.splice(i, 1);
  if (entry.wakeRecord) { entry.wakeRecord.answered_at_ms = nowMs; entry.wakeRecord.answered_by = by; }
  return true;
}

module.exports = { expireStale, awaitingIds, answer };
