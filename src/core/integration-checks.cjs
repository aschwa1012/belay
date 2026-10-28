'use strict';
// integration-checks.cjs — the extra commands one integrate call runs on the merged head (`checks`), in an acceptance command's own
// shape {argv, cwd?, timeout_ms?}. They belong to this call alone: no task owns them, and a later call carries none forward.

const { err } = require('./errors.cjs');

const MAX_CHECKS = 20;

// -> the commands as given, or []; throws E_ARGS before anything is merged or written.
function checkShape(v) {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > MAX_CHECKS) throw err('E_ARGS', `integration.merge: checks must be a list of at most ${MAX_CHECKS} commands, each {argv, cwd?, timeout_ms?}`, { field: 'checks' });
  v.forEach((c, i) => {
    const at = { field: 'checks', index: i };
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw err('E_ARGS', `integration.merge: checks[${i}] must be an object {argv, cwd?, timeout_ms?}`, at);
    const extra = Object.keys(c).filter((k) => !['argv', 'cwd', 'timeout_ms'].includes(k));
    if (extra.length) throw err('E_ARGS', `integration.merge: checks[${i}] has no field ${extra.join(', ')}; it takes argv, cwd and timeout_ms`, at);
    if (!Array.isArray(c.argv) || !c.argv.length || c.argv.some((x) => typeof x !== 'string') || !c.argv[0]) throw err('E_ARGS', `integration.merge: checks[${i}].argv must be a non-empty array of strings`, at);
    if (c.cwd !== undefined && (typeof c.cwd !== 'string' || !c.cwd)) throw err('E_ARGS', `integration.merge: checks[${i}].cwd must be a non-empty string`, at);
    if (c.timeout_ms !== undefined && !(Number.isSafeInteger(c.timeout_ms) && c.timeout_ms > 0)) throw err('E_ARGS', `integration.merge: checks[${i}].timeout_ms must be a positive integer`, at);
  });
  return v;
}

module.exports = { checkShape, MAX_CHECKS };
