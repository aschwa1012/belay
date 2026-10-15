'use strict';
// memory-levers.cjs (core) — ADR 0041 decision 1: the pure spec of a run's memory levers. `parseMemoryBlock`
// validates the spec's optional `memory` block and `isDefault` says whether a block differs from the defaults.
// It requires nothing, so run.attach can validate a block without loading the run manager; src/run reads the
// parsed block back with `leversFor`. Every lever that does anything new defaults off.

const { DEFAULT_MODE, MODES, ALLOWED: MODE_VALUES, normalize: normalizeMode, describe: describeModes } = require('./embedder-mode.cjs');

const DEFAULTS = Object.freeze({
  // ADR 0034 amendment 1: what the run does when the embedder fails: required (pause loudly, the default), keyword or off.
  on_embedder_failure: DEFAULT_MODE,
  redact: true,
  rules: false,
  alpha: 0.3,
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
  // ADR 0047: notes workers mean to share. Every behaviour below sits behind `notes`; the other four tune it.
  notes: false,
  notes_match_threshold: 0.8, // operator 2026-10-15 from the planted-duplicate study (offline/duplicates): valid only for the embedder it was measured on (voyage-4-nano q4, 1024); re-measure if the embedder changes
  notes_match_n: 3, // provisional: at most this many matches are returned for a pending note
  notes_reflection: false, // write ablation: a second end-of-task question as its own turn after the hand-back
  notes_lesson_question: false, // write ablation: the question aimed at lessons learned
  notes_overflow_line: false, // ADR 0047 decision 6: one neutral line counting the path and term notes the index could not hold; off until measured
  notes_trust_wording: false, // ADR 0047 decision 6: basis, evidence and review status instead of "unverified"; off until the harm arms have run
  notes_sink: 'off', // off | record | penalty: record writes a note_chance fact per delivered note at task end; penalty records the same, its rank shift is not built yet
});

const BOOLEAN_KEYS = ['redact', 'rules', 'capture', 'observations', 'project_writes', 'cost_ledger',
  'first_message_index', 'bottle', 'wrapup', 'knowledge_agent', 'notes', 'notes_reflection', 'notes_lesson_question', 'notes_overflow_line', 'notes_trust_wording'];
const SUMMARIES = ['off', 'mechanical'];
const SINKS = ['off', 'record', 'penalty'];
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
  const mode = normalizeMode(v.on_embedder_failure);
  if (mode === null) return { error: `memory.on_embedder_failure must be one of ${describeModes()}` };
  v.on_embedder_failure = mode;
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
  if (typeof v.notes_match_threshold !== 'number' || !(v.notes_match_threshold > 0 && v.notes_match_threshold <= 1)) return { error: 'memory.notes_match_threshold must be a number above 0 and at most 1' };
  if (!boundedInt(v.notes_match_n, 10)) return { error: 'memory.notes_match_n must be an integer from 1 to 10' };
  if (v.notes && v.project === null) return { error: 'memory.notes needs memory.project: notes live in the project namespace' };
  // Notes outlive the run in the project namespace, so they never take unredacted text.
  if (v.notes && v.redact === false) return { error: 'memory.redact false cannot be combined with memory.notes true: the project namespace outlives the run and must never hold unredacted text' };
  for (const k of ['notes_reflection', 'notes_lesson_question', 'notes_overflow_line', 'notes_trust_wording']) if (v[k] && !v.notes) return { error: `memory.${k} needs memory.notes` };
  if (!SINKS.includes(v.notes_sink)) return { error: `memory.notes_sink must be one of ${SINKS.join(', ')}` };
  if (v.notes_sink !== 'off' && !v.notes) return { error: 'memory.notes_sink needs memory.notes' };
  if (v.summaries === 'mechanical' && !v.observations) return { error: 'memory.summaries "mechanical" needs memory.observations' };
  return { value: v };
}

function isDefault(levers) {
  if (!levers) return true;
  return Object.keys(DEFAULTS).every((k) => levers[k] === DEFAULTS[k]);
}

// What each lever is, for a command that lists and sets them (`belay settings`). Every key of DEFAULTS has an
// entry: the type comes from the default's own type unless OVERRIDES names a tighter one, so a lever added to
// DEFAULTS is listed and settable with no edit here. parseMemoryBlock stays the one judge of a value: a caller
// that parses a value by its type here still asks parseMemoryBlock before it writes.
// TYPES[key] = { type: 'boolean'|'number'|'integer'|'enum'|'string', values?, min?, max?, minExclusive?, nullable? }; `values` only for enums.
const OVERRIDES = {
  // the aliases stop (required) and continue (keyword) are handled by the parser, not listed in values
  on_embedder_failure: { type: 'enum', values: MODES },
  alpha: { type: 'number', min: 0, max: 1 },
  summaries: { type: 'enum', values: SUMMARIES },
  project: { type: 'string', nullable: true },
  index_bytes: { type: 'integer', min: 1, max: INDEX_BYTES_MAX },
  bottle_bytes: { type: 'integer', min: 1, max: BOTTLE_BYTES_MAX },
  notes_match_threshold: { type: 'number', min: 0, max: 1, minExclusive: true },
  notes_match_n: { type: 'integer', min: 1, max: 10 },
  notes_sink: { type: 'enum', values: SINKS },
};

function specOf(key) {
  if (OVERRIDES[key]) return Object.freeze({ ...OVERRIDES[key] });
  const t = typeof DEFAULTS[key];
  return Object.freeze({ type: t === 'boolean' || t === 'number' ? t : 'string', ...(DEFAULTS[key] === null ? { nullable: true } : {}) });
}

const TYPES = Object.freeze(Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, specOf(k)])));

module.exports = { DEFAULTS, TYPES, MODE_VALUES, parseMemoryBlock, isDefault };
