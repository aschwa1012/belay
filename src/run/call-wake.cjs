'use strict';
// call-wake.cjs — an `integrate` or `task_evaluate` the orchestrator started that answered `still_running` (src/mcp/call-budget.cjs)
// is treated like a release evaluation (release-eval.cjs): while it runs it holds the headless run open, and when it ends the
// orchestrator is woken with its result, as facts only: the task ids, passed or failed, the failing checks and the conflict.
// The adapter that holds the call writes two run-ledger events (src/mcp/call-hooks.cjs), the same cross-process mechanism the
// refuted-note wake reads (note-wake.cjs); the result itself is read from the store here, never taken from the event.
// A call whose adapter died before it ended is forgotten after PENDING_MAX_MS, and releases its hold. The bound is wall time
// only, counted from the `call_detached` event's `written_at` (the store's clock, never a time the event's message claims). A live
// adapter always ends its call first: the client gives up at 600 s, well inside the bound. A call that ended with its outcome
// unknown (ADR 0033: E_TIMEOUT, E_OWNER_LOST, or an error that may have been committed) is not reported as written nothing: the
// wake says the outcome is unknown, and the hold stays until the store shows the call settled or the same bound passes.

const RE = require('./release-eval.cjs');

const parse = (m) => { try { const v = JSON.parse(m); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
const checkName = (c) => (Array.isArray(c.argv) ? c.argv.slice(0, 3).join(' ') : c.kind || '?');
const ids = (a) => (a.length > 3 ? `${a.slice(0, 3).join(', ')} and ${a.length - 3} more` : a.join(', '));

const UNKNOWN_CODES = new Set(['E_TIMEOUT', 'E_OWNER_LOST']);
const unknownOutcome = (ended) => { const m = parse(ended.message); return UNKNOWN_CODES.has(ended.code) || m.outcome === 'unknown' || m.may_have_committed === true; };
const ok = (e) => e.ok === 1 || e.ok === true;

async function resultText(core, tool, taskIds, ended, startedAt) {
  const of = `${tool} of ${ids(taskIds) || 'no task'}`;
  if (!ok(ended) && unknownOutcome(ended)) return `belay: ${of} ended with an error, ${ended.code || 'error'}; outcome unknown; read task_list with task_ids${taskIds.length ? ` ${JSON.stringify(taskIds.slice(0, 3))}` : ''}.`;
  if (!ok(ended)) return `belay: ${of} failed: ${ended.code || 'error'}${parse(ended.message).error ? `, ${parse(ended.message).error}` : ''}; nothing was written for it.`;
  try {
    if (tool === 'integrate') {
      const r = await core.integration.get({ id: ended.newest_row_id });
      const failing = (Array.isArray(r.checks) ? r.checks : []).filter((c) => c.passed === false).map(checkName);
      const c = r.conflict;
      return `belay: ${of} ended: ${r.state}${c ? `; conflict on task ${c.task_id}${Array.isArray(c.files) ? ` (${c.files.length} file${c.files.length === 1 ? '' : 's'})` : ''}` : ''}${failing.length ? `; failing: ${failing.join(', ')}` : r.passed === true ? '; checks passed' : ''}.`;
    }
    const row = await core.task.get({ task_id: taskIds[0] });
    const s = RE.summaryOf(row);
    if (!(row.results && Number(row.results.evaluated_at) >= startedAt)) return `belay: ${of} ended with no new result; the task is ${row.state}.`;
    return `belay: ${of} ended: ${s.state === 'done' ? 'passed, done' : `not done; failing: ${s.failing.join(', ') || 'no executable check'}`}.`;
  } catch { return `belay: ${of} ended; read it with task_list { task_ids }.`; }
}

// -> the integration row id (integrate) or '' (task_evaluate) once the store shows the call's effect, else null.
async function settledRow(core, call) {
  try {
    if (call.tool === 'integrate') {
      const rows = ((await core.integration.list({})) || {}).integrations || [];
      const mine = rows.filter((r) => r.state !== 'merging' && Number(r.written_at) >= call.since && (Array.isArray(r.task_ids) ? r.task_ids : []).some((t) => call.task_ids.includes(t)));
      return mine.length ? mine[mine.length - 1].id : null;
    }
    const row = await core.task.get({ task_id: call.task_ids[0] });
    return row && row.results && Number(row.results.evaluated_at) >= call.started_at ? '' : null;
  } catch { return null; }
}

function createCallWatcher({ core, runId, now = Date.now }) {
  const seen = new Set(); // event ids taken in
  const open = new Map(); // key -> { tool, task_ids, started_at, since }; since is the detached event's written_at
  const unsettled = new Map(); // key -> the same, for a call that ended with its outcome unknown
  async function poll() {
    let evs;
    try { evs = ((await core.memory.events({ run_id: runId, kinds: ['call_detached', 'call_ended'] })) || {}).events || []; } catch { return []; }
    const out = [];
    for (const ev of evs) {
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      const m = parse(ev.message);
      const taskIds = Array.isArray(ev.row_ids) ? ev.row_ids : [];
      if (ev.kind === 'call_detached') { open.set(ev.key, { tool: m.tool, task_ids: taskIds, started_at: Number(m.started_at) || now(), since: Number(ev.written_at) || now() }); continue; }
      const call = open.get(ev.key) || { tool: m.tool, task_ids: taskIds, started_at: Number(m.started_at) || 0, since: Number(ev.written_at) || now() };
      open.delete(ev.key);
      if (!ok(ev) && unknownOutcome(ev)) unsettled.set(ev.key, call);
      const text = RE.cut(await resultText(core, call.tool, call.task_ids, ev, call.started_at), RE.WAKE_TEXT_MAX);
      out.push({ event: 'evaluated', worker_id: `call:${ev.key}`, turn: 0, seq: ev.seq, task_id: call.task_ids[0], ...(call.task_ids.length > 1 ? { task_ids: call.task_ids } : {}), text });
    }
    for (const [key, call] of [...unsettled]) {
      if (now() - call.since > RE.PENDING_MAX_MS) { unsettled.delete(key); continue; }
      const rowId = await settledRow(core, call);
      if (rowId === null) continue;
      unsettled.delete(key);
      const text = RE.cut(await resultText(core, call.tool, call.task_ids, { ok: 1, newest_row_id: rowId }, call.started_at), RE.WAKE_TEXT_MAX);
      out.push({ event: 'evaluated', worker_id: `call:${key}`, turn: 0, seq: 0, task_id: call.task_ids[0], ...(call.task_ids.length > 1 ? { task_ids: call.task_ids } : {}), text });
    }
    return out;
  }
  // The headless idle close holds while a detached call runs, or ended with its outcome unknown and the store does not yet show it
  // settled, bounded by PENDING_MAX_MS of wall time from the detached event's written_at.
  const holds = () => [...open, ...unsettled].filter(([, c]) => now() - c.since <= RE.PENDING_MAX_MS).map(([k]) => `call:${k}`);
  return { poll, holds };
}

module.exports = { createCallWatcher };
