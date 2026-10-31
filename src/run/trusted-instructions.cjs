'use strict';
// trusted-instructions.cjs — a worker that reads another worker's tree (a reviewer: agent_type `reviewer`, or any worker spawned
// for a review task) must not take its instructions from that tree's working copy: the reviewed coder can edit CLAUDE.md there and
// address its reviewer. Its spawn-time copy comes from CLAUDE.md as committed at the reviewed work's base commit (the base the
// work's worktree recorded, else the task's own `base`), or, when none is known, at HEAD of the main checkout. Every other
// spawn keeps instructions.cjs's copy of its own worktree. Spawn path only (invariant 9).

const I = require('./instructions.cjs');

const isReviewTask = (t) => !!(t && t.acceptance && t.acceptance.verdict === true); // the core's review-tree.cjs isReview
const sha = (v) => (typeof v === 'string' && /^[0-9a-f]{7,64}$/i.test(v) ? v : null); // a raw commit id only: never a ref or option-shaped text

async function getTask(core, id) {
  try { return core && core.task && typeof core.task.get === 'function' ? await core.task.get({ task_id: id }) : null; } catch { return null; }
}

// The base commit the reviewed work started from, or null.
async function trustedRef(core, task) {
  for (const dep of Array.isArray(task && task.depends_on) ? task.depends_on : []) {
    const t = await getTask(core, dep);
    const ref = t && t.worktree && sha(t.worktree.base_sha);
    if (ref) return ref;
  }
  return (task && task.worktree && sha(task.worktree.base_sha)) || null;
}

// The `instructions` record for a Claude Code spawn. `agentType` and `taskId` are the spawn's arguments.
async function snapshotFor({ core, worktree, dir, agentType, taskId }) {
  const task = taskId ? await getTask(core, taskId) : null;
  if (agentType !== 'reviewer' && !isReviewTask(task)) return I.snapshotInstructions(worktree, dir);
  return I.snapshotTrusted(worktree, dir, await trustedRef(core, task));
}

module.exports = { snapshotFor, trustedRef };
