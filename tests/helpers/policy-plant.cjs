'use strict';
// policy-plant.cjs -- a live run's store with `steps` policy_step rows and two usage rows per step turn, written straight into a stopped
// store, for the budget gates that measure the step log at its size. Rows only; nothing here runs a policy.

const path = require('node:path');
const crypto = require('node:crypto');
const { openCore } = require('../../src/core/index.cjs');
const { Store } = require('../../src/core/store.cjs');

async function plantPolicyRun(dataDir, runId, steps = 500) {
  const o = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: runId, pid: process.pid }, embed: false });
  try {
    await o.run.attach({ adapter_pid: process.pid });
    await o.worker.write({ id: 'w1', substrate: 'claude-code', pid: process.pid, state: 'running' });
  } finally { await o.shutdownOwner(); await o.close(); }
  const s = new Store(path.join(dataDir, 'memory.db'), { stamp: true });
  try {
    const at = Date.now() - 3600000;
    s.tx(() => {
      const ins = s.p('INSERT INTO policy_step(run_id, task_id, step, trigger_table, trigger_id, trigger_seq, policy_rev, outcome, row_ref, worker_id, turn, at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      const u = s.p('INSERT INTO usage(id, run_id, worker_id, turn, substrate, cost_usd, cost_basis, at, written_at, written_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (let i = 1; i <= steps; i += 1) {
        const w = i % 2 ? null : 'w1';
        ins.run(runId, `t${i % 40}`, i % 3 ? 'fix' : 're_review', 'task', `t${i % 40}`, i, 1, 'done', `task:f${i}`, w, i, at + i, at + i + 5);
        for (let k = 0; k < 2; k += 1) u.run(`us-${crypto.randomUUID()}`, runId, w, i, 'claude-code', 0.01, 'delta-of-cumulative', at + i, at + i, 'orchestrator');
      }
    });
  } finally { s.close(); }
}

module.exports = { plantPolicyRun };
