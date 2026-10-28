'use strict';
// pre-close-wake.cjs — before a headless run closes on its idle rule, tell the orchestrator once, while it is live, which of the
// run's task trees the close would keep for uncommitted work or a HEAD off its branch (ADR 0065 amendment 1). One read-only
// task.worktreeSweep { dry_run: true, close_pending: true }; nothing is removed or written. Facts only. A failed read says nothing
// and the run closes as before. The interactive orchestrator has no idle-close rule, so it never reaches this.

const REASONS = new Set(['dirty', 'head_off_branch']);
const TREES = 3, PATHS = 3, MAX_BYTES = 600, NAME_BYTES = 60;

// Cut a worker-chosen string to at most `max` bytes, keeping its tail (the file name), and mark the cut.
function clip(s, max = NAME_BYTES) {
  s = String(s);
  if (Buffer.byteLength(s) <= max) return s;
  const tail = Buffer.from(s).subarray(Buffer.byteLength(s) - (max - 3)).toString('utf8').replace(/^\uFFFD+/, '');
  return `...${tail}`;
}

const describe = (k) => {
  const paths = k.paths || [];
  const why = k.reason === 'dirty' ? `uncommitted: ${paths.slice(0, PATHS).map((p) => clip(p)).join(', ')}${paths.length > PATHS ? ', and more' : ''}` : k.detail;
  return `${clip(k.path, 120)} (task ${k.task_ids.join(', ')}; ${why})`;
};

// The wake text for a dry-run answer, or null when no tree would be kept for either reason. Paths and names are chosen by a
// worker, so they are quoted by clip and the whole text is held to MAX_BYTES by naming fewer trees.
function textOf(plan) {
  const kept = ((plan && plan.kept) || []).filter((k) => REASONS.has(k.reason));
  if (!kept.length) return null;
  const build = (n) => `belay: the run closes when you next end a turn with no worker mid-turn, and it would keep these task trees: ${kept.slice(0, n).map(describe).join('; ')}${kept.length > n ? `; and ${kept.length - n} more` : ''}. Nothing has been removed or changed.`;
  let text = build(Math.min(TREES, kept.length));
  for (let n = Math.min(TREES, kept.length) - 1; n >= 1 && Buffer.byteLength(text) > MAX_BYTES; n--) text = build(n);
  return text;
}

function createPreCloseNotice({ core, runId }) {
  let spent = false;
  // Once per run. { ran: false } when the read was already made; otherwise { ran: true, wake } with the wake event or null.
  // The caller never closes in the pass that made the read: a pause or a new turn may have arrived during the await, and the next
  // poll tests the run again with fresh facts. If isPaused() is true after the read, nothing is said and the read is kept for later.
  async function check({ isPaused } = {}) {
    if (spent) return { ran: false, wake: null };
    spent = true;
    let plan;
    try { plan = await core.task.worktreeSweep({ run_id: runId, dry_run: true, close_pending: true }); } catch { return { ran: true, wake: null }; }
    if (isPaused && isPaused()) { spent = false; return { ran: true, wake: null }; }
    const text = textOf(plan);
    return { ran: true, wake: text ? { event: 'pre_close', worker_id: `close:${runId}`, turn: 0, seq: null, text } : null };
  }
  return { check };
}

module.exports = { createPreCloseNotice, textOf, clip };
