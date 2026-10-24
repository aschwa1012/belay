'use strict';
// compose.cjs — orchestrator tools that are one core write followed by the step the prompt used to ask the orchestrator
// to remember (ADR 0058): the core call is the effect and its row is returned whole; the follow-up is a second effect,
// reported beside the row with what happened, and its failure never undoes or hides the first.
// `callCore(dotted, args)` is the adapter's own; `manager()` returns the run manager when this adapter has opened one.

// worker_spawn's default answer (ADR 0058 decision 9): what the orchestrator acts on. The rest (surface, plugins, instruction
// hashes, pid_created, argv_hash, token counters) is the receipt, behind view: "debug".
const SPAWN_KEEP = ['id', 'substrate', 'pid', 'state', 'session_id', 'adapter_pid', 'worktree', 'task_id', 'started_at', 'ready_ms', 'model', 'permission_mode_effective'];
// `requested` is the spawn's own model argument. Codex reports no model on its stream (B5), so its row has none: the
// answer then names the model belay asked for, and says so in model_source.
function compactSpawn(row, requested = null) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const k of SPAWN_KEEP) if (row[k] !== undefined) out[k] = row[k];
  const asked = (row.agent && row.agent.model && row.agent.model.value) || requested || null;
  if (row.model != null) out.model_source = 'reported';
  else if (asked) { out.model = asked; out.model_source = 'requested'; }
  out.effort = row.agent && row.agent.effort ? row.agent.effort.value : (row.effort_requested ?? null);
  const builtins = row.surface && row.surface.builtins;
  out.tools = builtins != null ? builtins : (row.tools ?? null);
  if (row.permission_mode_degraded) out.permission_mode_degraded = row.permission_mode_degraded;
  return out;
}

const NO_CHECK = 'this task declares no acceptance check, so task_evaluate can never mark it done: give it commands, files_within_owned, verdict or handoff';
const hasCheck = (a) => !!a && ((Array.isArray(a.commands) && a.commands.length > 0) || a.files_within_owned === true || a.verdict === true || !!a.handoff);

// A worker this adapter launched is the only one it has a channel to: an adopted row's process belongs to another adapter.
const launchedHere = (r, id) => !!(r && typeof r._worker === 'function' && r._worker(id));

// `openManager()` opens the run manager when a tool needs one (spawn); `manager()` only reads whether it is open.
function createCompose({ callCore, manager, openManager, dataDir = null }) {
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
      return { ...out, delivered: { ...m, sent: !m.queued, queued: !!m.queued } }; // queued: held for a compaction, written when it ends
    } catch (e) {
      return not(`the task is assigned but the message was not sent: ${e && e.message}`, { error: (e && e.code) || 'E_INTERNAL' });
    }
  }

  // task_evaluate: the evaluation, then (with the stop_idle_on_done lever) the stop of the worker whose hand-back made it done.
  async function evaluate(args) {
    const row = await callCore('task.evaluate', args);
    const r = manager();
    if (!row || row.state !== 'done' || !r || typeof r.idleStop !== 'function') return row;
    const stop = await r.idleStop(row);
    return stop ? { ...row, idle_stop: stop } : row;
  }

  async function spawn(args) {
    const { view = 'compact', ...rest } = args || {};
    const row = await (await openManager()).spawn(rest);
    return view === 'debug' ? row : compactSpawn(row, rest.model);
  }

  // worker_last_reply (B11): read from the worker's recorded stream (last-reply.cjs); no core call, no write.
  const lastReply = async (args) => require('./last-reply.cjs').read(dataDir, args.worker_id);

  // task_create (B4): the row as written, with a warning when it declares no check, since such a task can never be done.
  async function create(args) {
    const row = await callCore('task.create', args);
    return row && !hasCheck(row.acceptance) ? { ...row, warning: NO_CHECK } : row;
  }

  // task_cancel: the cancel, then a short line to the worker whose lease it ended, when this session launched it.
  async function cancel(args) {
    const out = await callCore('task.cancel', args);
    const l = out && out.released_lease;
    if (!l || l.holder_role !== 'worker') return { ...out, notified: null };
    const r = manager();
    if (!launchedHere(r, l.holder)) return { ...out, notified: { sent: false, reason: `worker ${l.holder} was not launched by this session, so belay has no channel to it` } };
    const text = `belay: task ${out.task.id} was cancelled${args && args.reason ? ` (${args.reason})` : ''}, and your lease ${l.id} on it has ended. Stop work on it; do not call lease_release for it.`;
    try {
      const m = await r.message({ worker_id: l.holder, text });
      return { ...out, notified: { ...m, sent: !m.queued, queued: !!m.queued } };
    } catch (e) {
      return { ...out, notified: { sent: false, reason: `the task is cancelled but the worker was not told: ${e && e.message}`, error: (e && e.code) || 'E_INTERNAL' } };
    }
  }

  return { assign, evaluate, spawn, lastReply, create, cancel };
}

// ADR 0058 decision 10: a row's `seq` is its version in the store, not an order a model should reason about, so every tool answer
// names it `rev`. Applied to the answer only; the store and the core keep `seq`. A row that already has `rev` keeps both as they are.
function revOf(v, depth = 0) {
  if (depth > 12 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => revOf(x, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k === 'seq' && !('rev' in v) ? 'rev' : k] = revOf(x, depth + 1);
  return out;
}

module.exports = { createCompose, compactSpawn, revOf, SPAWN_KEEP };
