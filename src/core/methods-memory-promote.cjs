'use strict';
// methods-memory-promote.cjs — memory.promote (ADR 0044 decision 2). When a worker's task ends the run manager moves
// that worker's own run rows into the project namespace: the row keeps its id (so a citation of it stays valid), and
// its namespace is the only thing that changes. Only the orchestrator and the operator call it (engine.cjs); the run
// manager calls it on the harness view. Each move is a `project_write` event with key `promote:<id>`.

const { err } = require('./errors.cjs');
const rows = require('./rows.cjs');
const { projectOf } = require('./memory-reach.cjs');

const PER_TASK_MAX = 50; // rows that may move for one (task, worker); the rest are counted
const IDS_MAX = 500;

const bad = (message, field) => err('E_ARGS', `memory.promote: ${message}`, { field });

function projectWritesOn(E, runId) {
  let raw = null;
  try { const run = rows.current(E.store, 'run', runId); raw = run ? run.memory_levers : null; } catch { return false; }
  try { const o = typeof raw === 'string' ? JSON.parse(raw) : raw; return !!(o && o.project_writes === true); } catch { return false; }
}

// Why a row does not qualify, or null when it does. The reasons are the answer's `skipped[].reason`.
function disqualified(E, r, { runId, taskId, writer, now }) {
  if (r.namespace !== `run/${runId}`) return 'not in this run\'s namespace';
  if (r.written_by !== writer) return 'not written by this worker';
  if (r.task_id !== taskId) return 'not carrying this task';
  if ((r.status || 'unverified') !== 'unverified') return `the row is ${r.status}`;
  if (r.ttl_at !== null && r.ttl_at < now) return 'expired';
  if (E.store.p('SELECT 1 AS x FROM memory_entries WHERE supersedes = ? LIMIT 1').get(r.id)) return 'superseded';
  return null;
}

async function record(E, caller, fields) {
  try { await require('./methods-ledger.cjs').recordEvent(E, caller, { kind: 'project_write', ...fields }); } catch { /* the answer below still names what happened */ }
}

// memory.promote { ids, to: 'project', task_id, worker_id } → { namespace, moved, existing, refused, skipped, capped }
async function promote(E, caller, args) {
  if (args.to !== 'project') throw bad('to must be "project"', 'to');
  if (!Array.isArray(args.ids) || !args.ids.length || args.ids.length > IDS_MAX || args.ids.some((x) => typeof x !== 'string' || !x)) throw bad(`ids must be an array of 1 to ${IDS_MAX} row ids`, 'ids');
  if (typeof args.task_id !== 'string' || !args.task_id) throw bad('task_id must name the task whose rows move', 'task_id');
  if (typeof args.worker_id !== 'string' || !args.worker_id) throw bad('worker_id must name the worker whose rows move', 'worker_id');
  const runId = caller.run_id;
  const project = projectOf(E, caller);
  if (!project) throw err('E_ARGS', 'memory.promote: this run has no project, so there is nowhere to move a row to', { field: 'to' });
  if (!projectWritesOn(E, runId)) throw err('E_LEVER_OFF', 'memory.promote needs the run\'s memory.project_writes lever on', { lever: 'project_writes' });
  const ns = `project/${project}`;
  const now = Date.now();
  const ctx = { runId, taskId: args.task_id, writer: `worker:${args.worker_id}`, now };
  const out = { namespace: ns, moved: [], existing: [], refused: [], skipped: [], capped: 0 };
  const moves = [];

  E.store.tx(() => {
    const qualified = [];
    for (const id of new Set(args.ids)) {
      const r = E.store.p('SELECT id, namespace, written_by, task_id, status, ttl_at, created_at, text_hash, embedding_model, dim FROM memory_entries WHERE id = ?').get(id);
      if (!r) { out.skipped.push({ id, reason: 'no such row' }); continue; }
      const why = disqualified(E, r, ctx);
      if (why) out.skipped.push({ id, reason: why }); else qualified.push(r);
    }
    qualified.sort((a, b) => (b.created_at - a.created_at) || (a.id < b.id ? 1 : -1)); // newest first
    out.capped = Math.max(0, qualified.length - PER_TASK_MAX);
    for (const r of qualified.slice(0, PER_TASK_MAX)) {
      const dup = E.store.p('SELECT id FROM memory_entries WHERE namespace = ? AND text_hash = ? AND id != ?').get(ns, r.text_hash, r.id);
      if (dup) { out.existing.push({ id: r.id, existing_id: dup.id }); continue; }
      if (r.embedding_model) {
        const m = E.store.p('SELECT embedding_model, dim FROM namespace_models WHERE namespace = ?').get(ns);
        if (m && (m.embedding_model !== r.embedding_model || m.dim !== r.dim)) {
          out.refused.push({ id: r.id, code: 'E_MODEL', message: `namespace ${ns} is bound to ${m.embedding_model}/${m.dim} and this row carries ${r.embedding_model}/${r.dim}`, bound: m });
          continue;
        }
        if (!m) E.store.p('INSERT INTO namespace_models(namespace, embedding_model, dim) VALUES (?, ?, ?)').run(ns, r.embedding_model, r.dim);
      }
      E.store.moveRow(r.id, r.namespace, ns);
      out.moved.push({ id: r.id, from: r.namespace, to: ns });
      moves.push(r.id);
    }
  });
  if (out.moved.length) E.noteWrite();

  const tail = out.capped ? `; ${out.capped} more qualifying row${out.capped === 1 ? '' : 's'} not moved (cap ${PER_TASK_MAX})` : '';
  const common = { worker_id: args.worker_id, task_id: args.task_id };
  for (const m of out.moved) await record(E, caller, { ...common, ok: true, row_ids: [m.id], newest_row_id: m.id, key: `promote:${m.id}`, message: `moved ${m.id} from ${m.from} to ${m.to}${tail}` });
  for (const x of out.refused) await record(E, caller, { ...common, ok: false, code: x.code, row_ids: [x.id], key: `promote:${x.id}`, message: x.message.slice(0, 300) });
  return out;
}

module.exports = { promote, PER_TASK_MAX };
