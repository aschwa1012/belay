'use strict';
// memory-levers.cjs — ADR 0041 decision 1: the run's memory levers. `parseMemoryBlock` validates the spec's
// optional `memory` block; `leversFor` reads the parsed block back from the run row once and caches it for
// the life of the manager; `isDefault` says whether a block differs from the defaults (the receipt prints
// `memory_levers` only then). A run without the block has every lever at its default, and every lever that
// does anything new defaults off.

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
  if (v.summaries === 'mechanical' && !v.observations) return { error: 'memory.summaries "mechanical" needs memory.observations' };
  return { value: v };
}

function isDefault(levers) {
  if (!levers) return true;
  return Object.keys(DEFAULTS).every((k) => levers[k] === DEFAULTS[k]);
}

// One read per manager. The cache holds the promise, so concurrent callers share the read; a failed read is
// not cached, so the next call tries again. A row with no block (an older run, or a run that gave none) is
// the defaults, and so is an unreadable column: a bad stored value is never silently half-applied.
const cache = new WeakMap(); // core -> Map(runId -> Promise<levers>)

async function readLevers(core, runId) {
  const got = await core.run.get();
  // run.get answers for the caller's own run only; a different runId would silently get that run's levers.
  if (core.caller && core.caller.run_id !== undefined && core.caller.run_id !== runId) {
    throw new Error(`leversFor(${runId}): this core is bound to run ${core.caller.run_id}, and run.get reads only that run`);
  }
  if (got && got.run && got.run.id !== undefined && got.run.id !== runId) {
    throw new Error(`leversFor(${runId}): run.get answered for run ${got.run.id}`);
  }
  const raw = got && got.run ? got.run.memory_levers : null;
  if (raw == null) return { ...DEFAULTS };
  let obj;
  try { obj = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return { ...DEFAULTS }; }
  const parsed = parseMemoryBlock(obj);
  return parsed.error ? { ...DEFAULTS } : parsed.value;
}

function leversFor(core, runId) {
  let byRun = cache.get(core);
  if (!byRun) { byRun = new Map(); cache.set(core, byRun); }
  if (!byRun.has(runId)) {
    const p = readLevers(core, runId).catch((e) => { byRun.delete(runId); throw e; });
    byRun.set(runId, p);
  }
  return byRun.get(runId);
}

module.exports = { DEFAULTS, parseMemoryBlock, leversFor, isDefault };
