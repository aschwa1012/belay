'use strict';
// compose.cjs — orchestrator tools that are one core write followed by the step the prompt used to ask the orchestrator
// to remember (ADR 0058): the core call is the effect and its row is returned whole; the follow-up is a second effect,
// reported beside the row with what happened, and its failure never undoes or hides the first.
// `callCore(dotted, args)` is the adapter's own; `manager()` returns the run manager when this adapter has opened one.

// worker_spawn's default answer (ADR 0058 decision 9): what the orchestrator acts on. The rest (surface, plugins, instruction
// hashes, pid_created, argv_hash, token counters) is the receipt, behind view: "debug".
const HB = require('../run/handback.cjs'); // pure but for reading the Review standard
const SPAWN_KEEP = ['id', 'substrate', 'pid', 'state', 'session_id', 'adapter_pid', 'worktree', 'task_id', 'started_at', 'ready_ms', 'model', 'permission_mode_effective', 'scratch', 'review'];
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
// ADR 0059 decision 3: an overlap with a task in another tree does not refuse, so the warning says where it will show.
const overlapWarning = (o) => Array.isArray(o) && o.length
  ? `these paths are also owned by ${o.map((x) => `task ${x.task_id} (${x.files.join(', ')})`).join(', ')} in another tree; integrate may stop on a conflict there`
  : null;
const withWarnings = (out, ...w) => { const l = w.filter(Boolean); return out && l.length ? { ...out, warning: l.join('; ') } : out; };
const hasCheck = (a) => !!a && ((Array.isArray(a.commands) && a.commands.length > 0) || a.files_within_owned === true || a.verdict === true || !!a.handoff);

// A worker this adapter launched is the only one it has a channel to: an adopted row's process belongs to another adapter.
const launchedHere = (r, id) => !!(r && typeof r._worker === 'function' && r._worker(id));

// `openManager()` opens the run manager when a tool needs one (spawn); `manager()` only reads whether it is open.
function createCompose({ callCore, manager, openManager, dataDir = null, runId = null }) {
  // ADR 0054 amendment 1: a review task's answer carries the reviewer's real scratch folder, made now if the worker has none (a
  // worker of another type given a review), so the orchestrator never names one of its own; the delivered task names it too.
  function withScratch(raw, workerId) {
    if (!raw || !raw.review || !dataDir || !workerId) return raw;
    const RS = require('../run/review-scratch.cjs');
    const scratch = require('../core/scratch-dir.cjs').scratchDir(dataDir, runId, workerId) || RS.ensure(dataDir, workerId, runId);
    return { ...raw, scratch: scratch || null };
  }

  // task_assign: assign, then send the worker its task: the resume line (which names the lease), the orchestrator's
  // `prompt` or the task's spec, and the hand-back rule. `deliver: false` assigns only.
  async function assign(args) {
    const { prompt = null, deliver = true, ...coreArgs } = args || {};
    const raw = await callCore('task.assign', coreArgs);
    const out = withWarnings(withScratch(raw, coreArgs.worker_id), raw && overlapWarning(raw.overlaps));
    const not = (reason, extra) => ({ ...out, delivered: { sent: false, reason, ...extra } });
    if (deliver === false) return not('deliver was false');
    const r = manager();
    if (!launchedHere(r, coreArgs.worker_id)) return not(`worker ${coreArgs.worker_id} was not launched by this session, so belay has no channel to it; send the task with worker_message`);
    const lease = out && out.new_lease ? out.new_lease.id : null;
    let head = `task ${coreArgs.task_id} lease=${lease}.`;
    try { const rl = await callCore('continuity.resumeLine', { task_id: coreArgs.task_id, first: true }); if (rl && rl.text) head = rl.text; } catch { /* the short head above still names the lease */ }
    const body = typeof prompt === 'string' && prompt.trim() ? prompt : `Task: ${(out && out.task && out.task.spec) || ''}`;
    // The hand-back rule closes the message (a verdict task's is verdict-shaped and carries the Review standard); a reused reviewer's
    // note-review brief follows it, as at a spawn (handback.cjs, note-review.cjs).
    let tail = '';
    if (HB.isVerdict(out && out.task) && typeof r.reviewTail === 'function') { try { tail = (await r.reviewTail({ worker_id: coreArgs.worker_id, task_id: coreArgs.task_id })) || ''; } catch { tail = ''; } }
    const text = `${head}\n\n${body}${out && out.scratch ? require('../run/review-scratch.cjs').firstLine(out.scratch) : ''}${out && out.review ? require('../run/review-scratch.cjs').treeLine(out.review) : ''}${HB.rule(out)}${tail}`;
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
    if (view === 'debug') return row;
    const out = compactSpawn(row, rest.model);
    const lease = row && row.task_id ? await leaseNote(row.task_id, row.id) : null;
    return lease ? { ...out, lease } : out;
  }

  // The lease spawn made for a task: its id and `expires_at`, and how it is kept (ADR 0026). The worker's own adapter renews it
  // each minute once under half its length remains, while the worker's row is running, its pid answers and its last event is
  // younger than the lease is long; a worker that is parked, paused, stopped, dead or silent that long is not renewed. A read
  // that fails leaves the answer without the field.
  async function leaseNote(taskId, workerId) {
    try {
      const l = ((await callCore('task.get', { task_id: taskId })) || {}).lease;
      if (!l || l.holder !== workerId) return null;
      return { id: l.id, expires_at: l.expires_at, ttl_ms: l.ttl_ms, renewal: 'belay renews it while the worker runs and is active within ttl_ms; a paused, stopped, dead or silent worker is not renewed' };
    } catch { return null; }
  }

  // worker_last_reply (B11): read from the worker's recorded stream (last-reply.cjs); no core call, no write.
  const lastReply = async (args) => require('./last-reply.cjs').read(dataDir, args.worker_id);

  // task_create (B4): the row as written, with a warning when it declares no check, since such a task can never be done, and
  // (ADR 0059) when it owns paths a task in another tree owns too.
  async function create(args) {
    const row = await callCore('task.create', args);
    return withWarnings(row, row && !hasCheck(row.acceptance) && NO_CHECK, row && overlapWarning(row.overlaps));
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
