'use strict';
// methods-memory-status.cjs — memory.setStatus (ADR 0040 §2). A worker cannot verify a claim, its own or a
// peer's, so the engine admits only the orchestrator and the operator; this module holds the evidence rule.
// A status other than unverified needs a receipt that follows the grammar in memory-rows.cjs and, where it
// names a row, names one that exists. Setting unverified clears the receipt (the claim is back to unproven,
// so it keeps no evidence); who reset it and when are still recorded.
//
// ADR 0041 §5: verifying a row of a run's own namespace copies it into the run's project namespace, but only when that
// run's levers have `project_writes` on and name a project. Every other call answers exactly as it did before.

const { err } = require('./errors.cjs');
const rows = require('./rows.cjs');
const { parseReceipt, STATUSES } = require('./memory-rows.cjs');

const COPY_PREFIX = 'copy-of:';
const noReceipt = (receipt, reason) => err('E_RECEIPT', `memory.setStatus: receipt ${JSON.stringify(receipt)} refused: ${reason}`, { receipt, reason });

// Existence checks for the receipt kinds that name a row. commit: and test: are syntax only (parseReceipt).
function checkRef(E, parsed, receipt, id, status) {
  if (parsed.kind === 'checkpoint') {
    if (!rows.current(E.store, 'checkpoint', parsed.ref)) throw noReceipt(receipt, `no checkpoint ${parsed.ref}`);
  } else if (parsed.kind === 'task') {
    const task = rows.current(E.store, 'task', parsed.ref);
    if (!task) throw noReceipt(receipt, `no task ${parsed.ref}`);
    if (status === 'verified' && task.state !== 'done') throw noReceipt(receipt, `task ${parsed.ref} is ${task.state}, and a task receipt for verified needs it done`);
  } else if (parsed.kind === 'memory') {
    // A row cannot vouch for itself: that would be a receipt that proves nothing.
    if (parsed.ref === id) throw noReceipt(receipt, 'a row cannot be its own receipt');
    if (!E.store.p('SELECT 1 FROM memory_entries WHERE id = ?').get(parsed.ref)) throw noReceipt(receipt, `no memory row ${parsed.ref}`);
  }
}

// The levers and project of the run that wrote the row, from that run's latest row. A store without the columns, an
// unparseable lever block and a run with no project all mean "no copy".
function projectCopyTarget(E, row) {
  if (!row.run_id || row.namespace !== `run/${row.run_id}` || String(row.provenance || '').startsWith(COPY_PREFIX)) return null;
  let run;
  try { run = E.store.p('SELECT project, memory_levers FROM run WHERE id = ? ORDER BY seq DESC LIMIT 1').get(row.run_id); } catch { return null; }
  if (!run || !run.project || !run.memory_levers) return null;
  let levers;
  try { levers = typeof run.memory_levers === 'string' ? JSON.parse(run.memory_levers) : run.memory_levers; } catch { return null; }
  return levers && levers.project_writes === true ? `project/${run.project}` : null;
}

// The receipt for the copy: a memory_event of kind project_write, ok or failed with its code. A store that has no
// ledger table cannot take one, and that does not undo the copy.
async function recordCopy(E, caller, row, ev) {
  try {
    await require('./methods-ledger.cjs').recordEvent(E, caller, {
      kind: 'project_write', run_id: row.run_id, worker_id: row.worker_id || undefined, task_id: row.task_id || undefined, key: `${COPY_PREFIX}${row.id}`, ...ev,
    });
  } catch { /* the copy's own result below still names what happened */ }
}

// Copy a verified run row into the project namespace and verify the copy with the same receipt. The status change
// on the source has already been written; a failed copy is returned and recorded, never swallowed.
async function copyVerified(E, caller, row, namespace, receipt, at) {
  try {
    const vec = row.embedding && row.dim ? Array.from(new Float32Array(row.embedding.buffer.slice(row.embedding.byteOffset, row.embedding.byteOffset + row.dim * 4))) : null;
    const copy = E.store.store({
      namespace, worker_id: E.writtenBy(caller), type: row.type, text: row.text, title: row.title, body: row.body,
      redactions: row.redactions, tags: row.tags ? JSON.parse(row.tags) : undefined, provenance: `${COPY_PREFIX}${row.id}`,
      run_id: row.run_id, task_id: row.task_id, turn: row.turn, source: row.source,
      ...(vec ? { embedding: vec, embedding_model: row.embedding_model, embedding_revision: row.embedding_revision, dim: row.dim } : {}),
    });
    const status = E.store.setStatus(copy.id, { status: 'verified', receipt, by: E.writtenBy(caller), at });
    E.noteWrite();
    await recordCopy(E, caller, row, { ok: true, row_ids: [copy.id], newest_row_id: copy.id, message: `copied ${row.id} to ${namespace}` });
    return { ok: true, id: copy.id, namespace, action: copy.action, status: status.status, source_id: row.id };
  } catch (e) {
    const code = e && typeof e.code === 'string' && e.code.startsWith('E_') ? e.code : 'E_INTERNAL';
    await recordCopy(E, caller, row, { ok: false, code, row_ids: [row.id], message: String((e && e.message) || e).slice(0, 300) });
    return { ok: false, namespace, code, message: String((e && e.message) || e).slice(0, 300), source_id: row.id };
  }
}

async function setStatus(E, caller, args) {
  const { id, status, receipt } = args;
  if (typeof id !== 'string' || !id) throw err('E_ARGS', 'memory.setStatus needs an id', { field: 'id' });
  if (!STATUSES.includes(status)) throw err('E_ARGS', `memory.setStatus status must be one of ${STATUSES.join(', ')}`, { field: 'status', value: status });
  if (!E.store.p('SELECT 1 FROM memory_entries WHERE id = ?').get(id)) throw err('E_NOT_FOUND', `no memory row ${id}`, { id });
  let kept = null;
  if (status !== 'unverified') {
    // Before any write: a refused receipt changes nothing.
    const parsed = parseReceipt(receipt);
    if (parsed.error) throw noReceipt(receipt, parsed.error);
    checkRef(E, parsed, receipt, id, status);
    kept = receipt;
  }
  const at = Date.now();
  const out = E.store.setStatus(id, { status, receipt: kept, by: E.writtenBy(caller), at });
  E.noteWrite();
  if (status === 'verified') {
    const row = E.store.p('SELECT * FROM memory_entries WHERE id = ?').get(id);
    const target = projectCopyTarget(E, row);
    if (target) out.project_copy = await copyVerified(E, caller, row, target, kept, at);
  }
  return out;
}

module.exports = { setStatus };
