'use strict';
// call-hooks.cjs — the two run-ledger events an orchestrator adapter writes for a long call that answered `still_running`
// (call-budget.cjs). The run process reads them (src/run/call-wake.cjs): `call_detached` holds the run open and names the task ids;
// `call_ended` carries how it ended, and the run process reads the result itself from the store. The ledger is the cross-process
// mechanism the refuted-note wake uses too. A write that fails is dropped: the call's own record is the store's.

const crypto = require('node:crypto');
const { taskIdsOf } = require('./call-budget.cjs');

// An error that may have been committed (ADR 0033): a timeout, a lost owner, or one that says so.
const unknownOutcome = (e) => !!e && (e.code === 'E_TIMEOUT' || e.code === 'E_OWNER_LOST' || !!(e.detail && (e.detail.may_have_committed || e.detail.outcome === 'unknown')));

function callHooks(callCore) {
  const key = `${crypto.randomUUID()}`;
  const record = (a) => callCore('memory.recordEvent', a);
  return {
    detached: ({ tool, args, started_at }) => record({ kind: 'call_detached', key, row_ids: taskIdsOf(tool, args), message: JSON.stringify({ tool, started_at }) }),
    ended: ({ tool, args, started_at, row, error }) => {
      const base = { kind: 'call_ended', key, row_ids: taskIdsOf(tool, args), message: JSON.stringify({ tool, started_at, ...(error ? { error: String((error && error.message) || error).slice(0, 200), ...(unknownOutcome(error) ? { outcome: 'unknown' } : {}) } : {}) }) };
      if (error) return record({ ...base, ok: 0, code: String((error && error.code) || 'E_INTERNAL') });
      return record({ ...base, ok: 1, ...(row && typeof row.id === 'string' ? { newest_row_id: row.id } : {}) });
    },
  };
}

module.exports = { callHooks };
