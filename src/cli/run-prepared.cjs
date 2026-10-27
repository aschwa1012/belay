'use strict';
// run-prepared.cjs — the merges belay prepared for the user in this run and left for them to take (ADR 0067): each is kept under a
// ref of belay's own until the user takes it or the integration is removed. The run receipt lists those still there.

async function left(core, runId) {
  try {
    const { integrations } = await core.integration.list({ run_id: runId });
    const kept = integrations.filter((r) => r.prepared && r.prepared.ref && !r.prepared.deleted_at)
      .map((r) => ({ integration_id: r.id, into: r.into_branch, sha: r.prepared.sha, ref: r.prepared.ref, checkout: r.prepared.checkout, ff_command: r.prepared.ff_command }));
    return kept.length ? { prepared_left: kept } : {};
  } catch { return {}; }
}

module.exports = { left };
