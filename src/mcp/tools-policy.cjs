'use strict';
// tools-policy.cjs — task_create's `policy` property (ADR 0071) and the stamp fields no tool call may carry (ADR 0072 decision 3).
// The property lists what v1 takes; the core's policy-plan.cjs is the check, and refuses any other field or value.

// Written by the core for a policy step, from the harness caller only. A model naming one is refused at the boundary, by name.
const STAMPS = ['acted_by', 'trigger', 'policy_rev'];

const POLICY_PROPERTY = {
  type: ['object', 'null'],
  description: 'What belay does for this task. A field left out takes the run default, else stays yours. On amend it replaces the plan. null: no plan, no default. Its steps and hand-backs do not wake you; exceptions do, and the steps come as a digest. When you create work tasks, set review, fix, re_review and integrate here for a leaner context; do a step yourself only for a stated reason',
  properties: {
    review: { type: 'object', description: '{worker: id} or {spawn: {agent_type, worker_id?}}; when the task passes' },
    fix: { enum: ['builder'] },
    re_review: { enum: ['refuter'] },
    integrate: { enum: ['on_hold'] },
  },
};

// A batch item is a task's fields too; its stamps are refused as the top level's are. Returns the first stamp an item names, or null.
function stampIn(args) {
  if (!args || typeof args !== 'object') return null;
  const own = STAMPS.find((k) => Object.prototype.hasOwnProperty.call(args, k));
  if (own) return { field: own };
  if (Array.isArray(args.tasks)) {
    for (let i = 0; i < args.tasks.length; i++) {
      const t = args.tasks[i];
      const k = t && typeof t === 'object' ? STAMPS.find((s) => Object.prototype.hasOwnProperty.call(t, s)) : null;
      if (k) return { field: k, item: i };
    }
  }
  return null;
}

module.exports = { STAMPS, POLICY_PROPERTY, stampIn };
