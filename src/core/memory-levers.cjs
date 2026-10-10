'use strict';
// memory-levers.cjs (core) — ADR 0041 decision 1: the pure spec of a run's memory levers. `parseMemoryBlock`
// validates the spec's optional `memory` block and `isDefault` says whether a block differs from the defaults.
// It requires nothing, so run.attach can validate a block without loading the run manager; src/run reads the
// parsed block back with `leversFor`. Every lever that does anything new defaults off.

const DEFAULTS = Object.freeze({
  redact: true,
  rules: false,
  alpha: 0.5,
  capture: false,
  observations: false,
  summaries: 'off',
  project: null,
  project_writes: false,
  cost_ledger: false,
  first_message_index: false,
  index_bytes: 1200,
  bottle: false,
  bottle_bytes: 65536,
  wrapup: false,
  knowledge_agent: false,
});

const BOOLEAN_KEYS = ['redact', 'rules', 'capture', 'observations', 'project_writes', 'cost_ledger',
  'first_message_index', 'bottle', 'wrapup', 'knowledge_agent'];
const SUMMARIES = ['off', 'mechanical'];
const PROJECT_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const INDEX_BYTES_MAX = 4096; // ADR 0042 decision 2
const BOTTLE_BYTES_MAX = 262144; // ADR 0042 decision 4

function boundedInt(v, max) {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= max;
}

// Returns { value } (every key present, defaults filled) or { error } naming the key. `undefined` and null
// both mean "no block". Unknown keys, wrong types and a lever whose prerequisite is off are refused.
function parseMemoryBlock(block) {
  if (block === undefined || block === null) return { value: { ...DEFAULTS } };
  if (typeof block !== 'object' || Array.isArray(block)) return { error: 'memory must be an object' };
  for (const key of Object.keys(block)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
      return { error: `memory.${key} is not a known memory lever (known: ${Object.keys(DEFAULTS).join(', ')})` };
    }
  }
  const v = { ...DEFAULTS, ...block };
  for (const k of BOOLEAN_KEYS) {
    if (typeof v[k] !== 'boolean') return { error: `memory.${k} must be true or false` };
  }
  if (typeof v.alpha !== 'number' || !Number.isFinite(v.alpha) || v.alpha < 0 || v.alpha > 1) {
    return { error: 'memory.alpha must be a number from 0 to 1' };
  }
  if (!SUMMARIES.includes(v.summaries)) return { error: `memory.summaries must be one of ${SUMMARIES.join(', ')}` };
  if (v.project !== null && !(typeof v.project === 'string' && PROJECT_RE.test(v.project))) {
    return { error: 'memory.project must be null or match ^[a-z0-9][a-z0-9._-]{0,63}$' };
  }
  if (!boundedInt(v.index_bytes, INDEX_BYTES_MAX)) return { error: `memory.index_bytes must be an integer from 1 to ${INDEX_BYTES_MAX}` };
  if (!boundedInt(v.bottle_bytes, BOTTLE_BYTES_MAX)) return { error: `memory.bottle_bytes must be an integer from 1 to ${BOTTLE_BYTES_MAX}` };
  if (v.observations && !v.capture) return { error: 'memory.observations needs memory.capture' };
  if (v.project_writes && v.project === null) return { error: 'memory.project_writes needs memory.project' };
  // A project namespace outlives the run and is read by every later one, so it never takes unredacted text.
  if (v.project_writes && v.redact === false) {
    return { error: 'memory.redact false cannot be combined with memory.project_writes true: the project namespace outlives the run and must never hold unredacted text' };
  }
  if (v.summaries === 'mechanical' && !v.observations) return { error: 'memory.summaries "mechanical" needs memory.observations' };
  return { value: v };
}

function isDefault(levers) {
  if (!levers) return true;
  return Object.keys(DEFAULTS).every((k) => levers[k] === DEFAULTS[k]);
}

module.exports = { DEFAULTS, parseMemoryBlock, isDefault };
