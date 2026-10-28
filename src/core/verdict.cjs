'use strict';
// verdict.cjs — the `verdict` acceptance check (ADR 0025 decision 3). A review task's evidence is a
// verdict a worker handed back on release, not a command. belay proves who said it, under which lease,
// and that the speaker never held a lease on the work it judged; it does not prove the verdict is right.
// Pure over the store: no fs, process or git calls. methods-task.cjs requires it lazily, inside
// evaluate, so it is loaded only by a write path and never when a core is merely opened for a read.

const rows = require('./rows.cjs');

const MAX_FINDINGS = 50;

// Every lease row (all seqs) the worker ever held on one of these tasks.
function heldLeaseOn(store, workerId, taskIds) {
  if (!taskIds.length) return null;
  const marks = taskIds.map(() => '?').join(', ');
  const sql = `SELECT task_id, id FROM lease WHERE holder = ? AND holder_role = 'worker' AND task_id IN (${marks}) ORDER BY seq LIMIT 1`;
  return store.p(sql).get(workerId, ...taskIds) || null;
}

function verdictCheck(store, task) {
  const started = Date.now();
  const dependsOn = Array.isArray(task.depends_on) ? task.depends_on : [];
  const h = task.handoff && typeof task.handoff === 'object' ? task.handoff : null;
  const r = h && h.result && typeof h.result === 'object' && !Array.isArray(h.result) ? h.result : null;
  const detail = {
    verdict: r ? r.verdict : null,
    summary: r ? r.summary : null,
    findings: r && Array.isArray(r.findings) ? r.findings.slice(0, MAX_FINDINGS) : null,
    judged_by: h ? h.by : null,
    lease_id: h ? h.lease_id : null,
    handoff_at: h ? h.at : null,
    depends_on: dependsOn,
    // ADR 0054 amendment 1: what changed in the reviewer's tree between the lease's grant and the hand-back (a flag, never a fail).
    ...(h && h.tree ? { tree: h.tree, tree_changed: h.tree.changed } : {}),
    ...(h && h.scratch ? { scratch: h.scratch, scratch_over_limit: h.scratch.over_limit } : {}),
  };
  const notExecutable = (reason) => ({
    kind: 'verdict', executable: false, passed: false, ms: Date.now() - started, detail: { ...detail, reason },
  });

  if (!dependsOn.length) return notExecutable('a review task needs at least one depends_on entry: a review reviews something');
  if (!h) return notExecutable('the task has no handoff: no worker has handed back a result on release');
  // ADR 0025 amendment 1: only the task's current lease, once released, can carry the judged hand-back.
  const lease = typeof h.lease_id === 'string' ? rows.currentLeaseForTask(store, task.id) : null;
  if (!lease) return notExecutable(`handoff lease ${h.lease_id} is not a lease on task ${task.id}`);
  if (lease.id !== h.lease_id) return notExecutable(`handoff lease ${h.lease_id} was superseded: task ${task.id}'s current lease is ${lease.id}, so this hand-back is stale`);
  if (lease.released_at == null) return notExecutable(`lease ${lease.id} on task ${task.id} is not released, so its holder has not handed back`);
  if (lease.holder_role !== 'worker') return notExecutable(`handoff lease ${h.lease_id} was held by ${lease.holder_role}, not a worker`);
  if (lease.holder !== h.by) return notExecutable(`handoff lease ${h.lease_id} was held by ${lease.holder}, not by ${h.by}, who wrote the handoff`);
  if (!r || (r.verdict !== 'holds' && r.verdict !== 'refuted')) return notExecutable("handoff result.verdict must be 'holds' or 'refuted'");
  if (typeof r.summary !== 'string' || !r.summary.trim()) return notExecutable('handoff result.summary must be a non-empty string');
  const own = heldLeaseOn(store, h.by, dependsOn);
  if (own) return notExecutable(`worker ${h.by} held lease ${own.id} on ${own.task_id}, a task under review, and a worker cannot judge its own work`);

  return { kind: 'verdict', executable: true, passed: r.verdict === 'holds', ms: Date.now() - started, detail };
}

module.exports = { verdictCheck, heldLeaseOn, MAX_FINDINGS };
