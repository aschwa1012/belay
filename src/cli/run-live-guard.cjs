'use strict';
// A run id whose adapter is still running is not ours to take over. The core refuses the attach too (E_RUN_LIVE); asking
// before anything is spawned or cleared keeps the live run's files and orchestrator untouched. A plain second `belay run` is
// already stopped by the owner election, so this catches an adapter left behind by a crash, and a pid that was reused (the
// recorded creation time tells those apart; see src/core/run-live.cjs).
const { adapterState, liveMessage } = require('../core/run-live.cjs');

// { row, assessment } when the run is unended, its adapter is not this process and is live or unverifiable; else null (no row,
// unreadable, a lapsed run: the attach decides).
async function liveRunRow(core, assess = adapterState) {
  try {
    const got = await core.run.get();
    const r = got && got.run;
    if (!r || r.ended_at != null || Number(r.adapter_pid) === process.pid) return null;
    const a = await assess(r);
    return a.state === 'dead' ? null : { row: r, assessment: a };
  } catch { /* no run row yet */ }
  return null;
}

function liveRunMessage(runId, hit) { return liveMessage(runId, hit.row, hit.assessment); }

module.exports = { liveRunRow, liveRunMessage };
