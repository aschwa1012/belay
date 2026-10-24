'use strict';
// path-ids.cjs — pure. The one rule for an id that becomes a path segment: a worker id (workers/<id>/), a run id (the run's
// orchestrator directory, the job ids built from it), and a task id a caller chooses. A letter or digit first, then letters,
// digits, dot, underscore and dash, at most 128 bytes, never a Windows device name (CON, NUL, COM1...) and never a trailing dot,
// which Windows strips. No separator can pass, so no id leaves the directory it is joined under. Checked at the MCP boundary,
// in the run manager's argument check and in the core before a new row is written.

const RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;

const isPathId = (id) => typeof id === 'string' && RE.test(id) && !DEVICE.test(id) && !id.endsWith('.');

const RULE = 'a letter or digit, then letters, digits, ".", "_" or "-", at most 128 characters, not a device name and not ending in "."';

// Throws E_ARGS naming the field when `id` breaks the rule; returns it unchanged otherwise.
function checkPathId(field, id) {
  if (isPathId(id)) return id;
  const shown = typeof id === 'string' ? JSON.stringify(id.slice(0, 80)) : typeof id;
  throw Object.assign(new Error(`${field} must be ${RULE}; got ${shown}`), { code: 'E_ARGS', detail: { field, reason: 'id_shape' } });
}

module.exports = { isPathId, checkPathId, RULE };
