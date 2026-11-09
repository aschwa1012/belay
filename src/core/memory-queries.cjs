'use strict';
// memory-queries.cjs — the orchestrator's short search lines for the first-message index (ADR 0042 amendment): up to 4 lines of at most
// 160 bytes, given on task_create (kept on the task row) or on worker_spawn (kept on the worker row). One check for both, so the limits
// are one set. `prefix` names the caller in the message ('task' or 'spawn'); `fail` makes the error (core and run each have their own).

const QUERIES_MAX = 4, QUERY_BYTES_MAX = 160;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/; // C0 and DEL; tab, line feed and carriage return are white space and fold to a space

// Returns the lines trimmed and with white space folded, or [] when none were given.
function check(list, prefix, fail) {
  if (list === null || list === undefined) return [];
  if (!Array.isArray(list) || list.length > QUERIES_MAX) fail('E_ARGS', `${prefix} memory_queries must be an array of at most ${QUERIES_MAX} task lines`, { field: 'memory_queries' });
  return list.map((q, i) => {
    const t = typeof q === 'string' ? q.replace(/\s+/g, ' ').trim() : '';
    if (typeof q === 'string' && CONTROL.test(q)) fail('E_ARGS', `${prefix} memory_queries[${i}] has a control character; use plain text`, { field: 'memory_queries', index: i });
    if (!t) fail('E_ARGS', `${prefix} memory_queries[${i}] must be a non-empty string`, { field: 'memory_queries', index: i });
    if (Buffer.byteLength(t) > QUERY_BYTES_MAX) fail('E_ARGS', `${prefix} memory_queries[${i}] is ${Buffer.byteLength(t)} bytes and the limit is ${QUERY_BYTES_MAX}; word the task line shorter`, { field: 'memory_queries', index: i, max: QUERY_BYTES_MAX });
    return t;
  });
}

module.exports = { check, QUERIES_MAX, QUERY_BYTES_MAX };
