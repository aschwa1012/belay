'use strict';
// A run id whose first life is still going is not ours to take over. The core refuses the attach too (E_RUN_LIVE); asking
// before anything is spawned or cleared keeps the live run's files and orchestrator untouched.
const { pidAlive } = require('../core/lock.cjs');

// The run row when it is unended, its adapter answers and it is not this process's own; else null (no row, unreadable: the attach decides).
async function liveRunRow(core) {
  try {
    const got = await core.run.get();
    const r = got && got.run;
    if (r && r.ended_at == null && Number(r.adapter_pid) !== process.pid && pidAlive(r.adapter_pid)) return r;
  } catch { /* no run row yet */ }
  return null;
}

function liveRunMessage(runId, row) {
  return `run ${runId} is still live (adapter pid ${row.adapter_pid}, epoch ${row.epoch}); stop it first or choose another run id`;
}

module.exports = { liveRunRow, liveRunMessage };
