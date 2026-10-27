'use strict';
// store-reply.cjs — what memory_store's reply says about itself. A summary comes back `status: "unverified"`, and a note's reply
// carries `applies_to` as counts; neither says what it means, so the reply does. Additive: no field of the core's row changes.

const UNVERIFIED = 'unverified means no memory_verify receipt is attached to this row (the tool is not listed in a notes run); a summary is found by its title and kept as written';
const APPLIES = 'applies_to counts the paths this note applies to: total kept; worker or orchestrator (whoever wrote the note) named them, evidence (its evidence field) or diff (changed files its text names) added them; dropped were cut for size; task_files is the size of the task diff list';

function explain(method, row) {
  if (method !== 'memory.store' || !row || typeof row !== 'object' || Array.isArray(row)) return row;
  if (row.type === 'summary' && row.status === 'unverified') return { ...row, status_note: UNVERIFIED };
  if (row.applies_to && typeof row.applies_to === 'object' && !Array.isArray(row.applies_to) && 'total' in row.applies_to) return { ...row, applies_to_note: APPLIES };
  return row;
}

module.exports = { explain, UNVERIFIED, APPLIES };
