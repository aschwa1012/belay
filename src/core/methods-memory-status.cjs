'use strict';
// methods-memory-status.cjs — memory.setStatus (ADR 0040 §2). A worker cannot verify a claim, its own or a
// peer's, so the engine admits only the orchestrator and the operator; this module holds the evidence rule.
// A status other than unverified needs a receipt that follows the grammar in memory-rows.cjs and, where it
// names a row, names one that exists. Setting unverified clears the receipt (the claim is back to unproven,
// so it keeps no evidence); who reset it and when are still recorded.

const { err } = require('./errors.cjs');
const rows = require('./rows.cjs');
const { parseReceipt, STATUSES } = require('./memory-rows.cjs');

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
  const out = E.store.setStatus(id, { status, receipt: kept, by: E.writtenBy(caller), at: Date.now() });
  E.noteWrite();
  return out;
}

module.exports = { setStatus };
