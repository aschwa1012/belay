'use strict';
// tools-schema.cjs — the small JSON Schema builders the tool listings share (moved out of tools.cjs, the 500-line rule).

const S = (properties, required) => {
  const s = { type: 'object', properties };
  if (required) s.required = required;
  return s;
};
const str = (description) => (description ? { type: 'string', description } : { type: 'string' });
const int = (description) => (description ? { type: 'integer', description } : { type: 'integer' });
const num = () => ({ type: 'number' });
const bool = () => ({ type: 'boolean' });
const DEBUG = { type: 'string', enum: ['debug'] };
const strs = (description) => {
  const a = { type: 'array', items: { type: 'string' } };
  if (description) a.description = description;
  return a;
};

module.exports = { S, str, int, num, bool, DEBUG, strs };
