'use strict';
// pre-close-wake.cjs — before a headless run closes on its idle rule, tell the orchestrator once, while it is live, which of the
// run's task trees the close would keep for uncommitted work or a HEAD off its branch (ADR 0065 amendment 1). One read-only
// task.worktreeSweep { dry_run: true }; nothing is removed or written. Facts only. A failed read says nothing and the run closes
// as before. The interactive orchestrator has no idle-close rule, so it never reaches this.

const REASONS = new Set(['dirty', 'head_off_branch']);
const TREES = 3, PATHS = 3;

const describe = (k) => {
  const paths = k.paths || [];
  const why = k.reason === 'dirty' ? `uncommitted: ${paths.slice(0, PATHS).join(', ')}${paths.length > PATHS ? ', and more' : ''}` : k.detail;
  return `${k.path} (task ${k.task_ids.join(', ')}; ${why})`;
};

// The wake text for a dry-run answer, or null when no tree would be kept for either reason.
function textOf(plan) {
  const kept = ((plan && plan.kept) || []).filter((k) => REASONS.has(k.reason));
  if (!kept.length) return null;
  const named = kept.slice(0, TREES).map(describe).join('; ');
  return `belay: the run closes when you next end a turn with no worker mid-turn, and it would keep these task trees: ${named}${kept.length > TREES ? `; and ${kept.length - TREES} more` : ''}. Nothing has been removed or changed.`;
}

function createPreCloseNotice({ core, runId }) {
  let spent = false;
  // Once per run: the wake event to write, or null (nothing to say, already said, or the read failed).
  async function notice() {
    if (spent) return null;
    spent = true;
    let plan;
    try { plan = await core.task.worktreeSweep({ run_id: runId, dry_run: true }); } catch { return null; }
    const text = textOf(plan);
    return text ? { event: 'pre_close', worker_id: `close:${runId}`, turn: 0, seq: null, text } : null;
  }
  return { notice };
}

module.exports = { createPreCloseNotice, textOf };
