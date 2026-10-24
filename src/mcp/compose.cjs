'use strict';
// compose.cjs — orchestrator tools that are one core write followed by the step the prompt used to ask the orchestrator
// to remember (ADR 0058): the core call is the effect and its row is returned whole; the follow-up is a second effect,
// reported beside the row with what happened, and its failure never undoes or hides the first.
// `callCore(dotted, args)` is the adapter's own; `manager()` returns the run manager when this adapter has opened one.

// A worker this adapter launched is the only one it has a channel to: an adopted row's process belongs to another adapter.
const launchedHere = (r, id) => !!(r && typeof r._worker === 'function' && r._worker(id));

function createCompose({ callCore, manager }) {
  // task_assign: assign, then send the worker its task: the resume line (which names the lease), the orchestrator's
  // `prompt` or the task's spec, and the hand-back rule. `deliver: false` assigns only.
  async function assign(args) {
    const { prompt = null, deliver = true, ...coreArgs } = args || {};
    const out = await callCore('task.assign', coreArgs);
    const not = (reason, extra) => ({ ...out, delivered: { sent: false, reason, ...extra } });
    if (deliver === false) return not('deliver was false');
    const r = manager();
    if (!launchedHere(r, coreArgs.worker_id)) return not(`worker ${coreArgs.worker_id} was not launched by this session, so belay has no channel to it; send the task with worker_message`);
    const lease = out && out.new_lease ? out.new_lease.id : null;
    let head = `task ${coreArgs.task_id} state=assigned lease=${lease}.`;
    try { const rl = await callCore('continuity.resumeLine', { task_id: coreArgs.task_id }); if (rl && rl.text) head = rl.text; } catch { /* the short head above still names the lease */ }
    const body = typeof prompt === 'string' && prompt.trim() ? prompt : `Task: ${(out && out.task && out.task.spec) || ''}`;
    const text = `${head}\n\n${body}\n\nWhen you are finished, call lease_release with lease_id ${lease} and a result object (branch, head, tests, findings).`;
    try {
      const m = await r.message({ worker_id: coreArgs.worker_id, text });
      return { ...out, delivered: { sent: true, ...m } };
    } catch (e) {
      return not(`the task is assigned but the message was not sent: ${e && e.message}`, { error: (e && e.code) || 'E_INTERNAL' });
    }
  }

  return { assign };
}

module.exports = { createCompose };
