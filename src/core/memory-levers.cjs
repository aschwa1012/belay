'use strict';
// memory-levers.cjs (core) — ADR 0041 decision 1: the pure spec of a run's memory levers. `parseMemoryBlock`
// validates the spec's optional `memory` block and `isDefault` says whether a block differs from the defaults.
// It requires only pure data (the profile table, which loads no GPU module), so run.attach can validate a block without loading the run manager; src/run reads the
// parsed block back with `leversFor`. Every lever that does anything new defaults off.

const RP = require('./retrieval-profiles.cjs'); // pure data: the profile table and the model lookups (ADR 0050)
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
  // The scrubber's write side (the lifecycle): off refuses, propose writes proposals and applies nothing, apply writes holds.
  scrub_action: 'propose',
  scrub_max_items: 40, // entries in one scrub hand-back
  scrub_alarm_holds: 20, // more holds than this from one scrub raise the alarm field (the call still succeeds)
  notes_trust_wording: false, // ADR 0047 decision 6: basis, evidence and review status instead of "unverified"; off until the harm arms have run
  note_review: false, // wave 4: when a task that wrote notes ends with no reviewer, belay starts one short read-only review job for them; off until the planted-false-claim gate sets its model
  note_review_model: 'claude-haiku-5-5', // the review job's model; a lever, set by the planted-false-claim gate
  note_review_cost_cap_usd: 0.05, // the review job's cost cap in dollars: passed to the substrate as its budget, and a job that went over leaves its notes unreviewed
  // The run-close stages (the Haiku scrubber and the Opus archive reviewer). Caps are real: the recorded cost is the binding check.
  scrub_wall_s: 300, // the scrubber's wall cap in seconds
  scrub_cost_cap_usd: 0.1, // the scrubber's cost cap in dollars: passed to the substrate as its budget; a scrub that recorded more applies nothing and its items are owed
  scrub_model: 'claude-haiku-5-5', // the scrubber's model: a Claude 5.5 id
  archive_review_auto: false, // the Opus archive reviewer runs at run close only when this is true; otherwise only `belay memory review` (or the panel button) dispatches it
  review_min_held: 3, // the archive reviewer runs at run close when the held queue has at least this many marks
  review_max_age_runs: 3, // ... or the oldest mark has waited this many runs
  review_wall_s: 600, // the reviewer's wall cap in seconds
  review_cost_cap_usd: 2, // the reviewer's cost cap in dollars (the whole queue is one spawn; leftovers carry over)
  archive_review_model: 'claude-opus-5-5', // the reviewer's model: a Claude 5.5 id
  // ADR 0050: light and heavy retrieval. Nano with no reranker everywhere until the user picks otherwise (nothing heavy downloads unasked).
  profile: RP.FALLBACK_PROFILE, // a named profile of src/core/retrieval-profiles.cjs, or custom (then `embedder` and `reranker` apply)
  profile_cpu: RP.FALLBACK_PROFILE, // the profile a run takes when no usable GPU is found: CPU models only
  embedder: RP.NANO, // custom profile: a model id from the embedder tables
  reranker: 'none', // custom profile: a reranker model id, or none
  routing: null, // null, or a map from agent type to a profile name or a custom pair { embedder, reranker? }; an unset type uses the run's profile
  rerank_depth: RP.DEFAULT_DEPTH, // the top candidates reranked, on every device, until the 0.3.2 eval re-picks it
  rerank_bound_ms: 10000, // the rerank stage's own bound, inside the MCP tool timeout
  on_heavy_failure: 'fallback', // fallback | pause: a heavy model that fails to load or fails mid-run
  on_heavy_behind: 'wait', // wait | fallback: a heavy embedder with a backlog at run start, when no one is there to ask
  search_log_cap_mb: 500, // the search log's size cap; the oldest runs are pruned first
  vram_headroom_gb: 0.75, // kept free above the summed measured peaks of the routing's GPU models (the probe)
  notes_sink: 'off', // off | record | penalty: record writes a note_chance fact per delivered note at task end; penalty records the same, its rank shift is not built yet (the index has a no-op seam, memory-index-rank.cjs sinkFactor)
});

const BOOLEAN_KEYS = ['redact', 'rules', 'capture', 'observations', 'project_writes', 'cost_ledger',
  'first_message_index', 'bottle', 'wrapup', 'knowledge_agent', 'notes', 'notes_reflection', 'notes_lesson_question', 'notes_overflow_line', 'notes_trust_wording', 'note_review', 'archive_review_auto'];
const MODEL_RE = /^claude-(haiku|sonnet|opus)-5-5$/; // a Claude 5.5 model id: the only models the roster allows (ADR 0021 amendments 5 and 6)
const SUMMARIES = ['off', 'mechanical'];
const SCRUB_ACTIONS = ['off', 'propose', 'apply'];
const SINKS = ['off', 'record', 'penalty'];
const PROFILE_VALUES = [...RP.PROFILE_NAMES, RP.CUSTOM];
const HEAVY_FAILURE = ['fallback', 'pause'];
const HEAVY_BEHIND = ['wait', 'fallback'];
const ROUTING_MAX = 64; // entries in the routing map
const ROUTING_TYPE_RE = /^[a-z][a-z0-9_-]{0,31}$/; // the main keys are orchestrator, reviewer and coder; any other agent type is an advanced key
const PROJECT_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const INDEX_BYTES_MAX = 4096; // ADR 0042 decision 2
const BOTTLE_BYTES_MAX = 262144; // ADR 0042 decision 4

// The routing map: { <agent type>: <profile name> | { embedder, reranker? } }, or null. Returns { msg, code? } or null.
function routingProblem(r) {
  if (r === null) return null;
  if (typeof r !== 'object' || Array.isArray(r)) return { msg: 'memory.routing must be null or an object from agent type to profile' };
  if (Object.keys(r).length > ROUTING_MAX) return { msg: `memory.routing has more than ${ROUTING_MAX} entries` };
  for (const [type, p] of Object.entries(r)) {
    if (!ROUTING_TYPE_RE.test(type)) return { msg: `memory.routing.${type}: an agent type is lower-case letters, digits, - or _` };
    if (typeof p === 'string') {
      if (p === RP.CUSTOM || !RP.isProfile(p)) return { msg: `memory.routing.${type} must be one of ${RP.PROFILE_NAMES.join(', ')} or a pair { embedder, reranker }` };
      const pend = RP.pendingIn(RP.PROFILES[p]);
      if (pend) return { msg: `memory.routing.${type}: ${RP.pendingMessage(pend)}`, code: 'E_MODEL' };
      continue;
    }
    if (!p || typeof p !== 'object' || Array.isArray(p)) return { msg: `memory.routing.${type} must be a profile name or a pair { embedder, reranker }` };
    for (const k of Object.keys(p)) if (k !== 'embedder' && k !== 'reranker') return { msg: `memory.routing.${type}.${k} is not a field of a pair (embedder, reranker)` };
    const bad = RP.embedderProblem(p.embedder) || RP.rerankerProblem(p.reranker === undefined ? 'none' : p.reranker);
    if (bad) return { msg: `memory.routing.${type}: ${bad}` };
    const pend = RP.pendingIn({ embedder: p.embedder, reranker: p.reranker === 'none' ? null : p.reranker });
    if (pend) return { msg: `memory.routing.${type}: ${RP.pendingMessage(pend)}`, code: 'E_MODEL' };
  }
  return null;
}

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
  if (!SCRUB_ACTIONS.includes(v.scrub_action)) return { error: `memory.scrub_action must be one of ${SCRUB_ACTIONS.join(', ')}` };
  if (!boundedInt(v.scrub_max_items, 500)) return { error: 'memory.scrub_max_items must be an integer from 1 to 500' };
  if (!boundedInt(v.scrub_alarm_holds, 500)) return { error: 'memory.scrub_alarm_holds must be an integer from 1 to 500' };
  if (!boundedInt(v.notes_match_n, 10)) return { error: 'memory.notes_match_n must be an integer from 1 to 10' };
  if (v.notes && v.project === null) return { error: 'memory.notes needs memory.project: notes live in the project namespace' };
  // Notes outlive the run in the project namespace, so they never take unredacted text.
  if (v.notes && v.redact === false) return { error: 'memory.redact false cannot be combined with memory.notes true: the project namespace outlives the run and must never hold unredacted text' };
  if (typeof v.note_review_model !== 'string' || !MODEL_RE.test(v.note_review_model)) return { error: 'memory.note_review_model must be a Claude 5.5 model id (claude-haiku-5-5, claude-sonnet-5-5 or claude-opus-5-5)' };
  if (typeof v.note_review_cost_cap_usd !== 'number' || !(v.note_review_cost_cap_usd > 0 && v.note_review_cost_cap_usd <= 5)) return { error: 'memory.note_review_cost_cap_usd must be a number above 0 and at most 5' };
  for (const k of ['notes_reflection', 'notes_lesson_question', 'notes_overflow_line', 'notes_trust_wording', 'note_review', 'archive_review_auto']) if (v[k] && !v.notes) return { error: `memory.${k} needs memory.notes` };
  for (const [k, max] of [['scrub_wall_s', 3600], ['review_wall_s', 7200], ['review_min_held', 500], ['review_max_age_runs', 1000]]) if (!boundedInt(v[k], max)) return { error: `memory.${k} must be an integer from 1 to ${max}` };
  for (const [k, max] of [['scrub_cost_cap_usd', 5], ['review_cost_cap_usd', 20]]) if (typeof v[k] !== 'number' || !(v[k] > 0 && v[k] <= max)) return { error: `memory.${k} must be a number above 0 and at most ${max}` };
  for (const k of ['scrub_model', 'archive_review_model']) if (typeof v[k] !== 'string' || !MODEL_RE.test(v[k])) return { error: `memory.${k} must be a Claude 5.5 model id (claude-haiku-5-5, claude-sonnet-5-5 or claude-opus-5-5)` };
  if (!SINKS.includes(v.notes_sink)) return { error: `memory.notes_sink must be one of ${SINKS.join(', ')}` };
  if (v.notes_sink !== 'off' && !v.notes) return { error: 'memory.notes_sink needs memory.notes' };
  for (const k of ['profile', 'profile_cpu']) if (!PROFILE_VALUES.includes(v[k])) return { error: `memory.${k} must be one of ${PROFILE_VALUES.join(', ')}` };
  if (RP.isProfile(v.profile_cpu) && RP.needsGpu(RP.PROFILES[v.profile_cpu])) return { error: `memory.profile_cpu ${v.profile_cpu} needs a GPU; it is the profile used when there is none` };
  const embProblem = RP.embedderProblem(v.embedder);
  if (embProblem) return { error: `memory.embedder: ${embProblem}` };
  const rrProblem = RP.rerankerProblem(v.reranker);
  if (rrProblem) return { error: `memory.reranker: ${rrProblem}` };
  if (v.profile_cpu === RP.CUSTOM && RP.needsGpu({ embedder: v.embedder, reranker: v.reranker === 'none' ? null : v.reranker })) return { error: 'memory.profile_cpu custom needs a CPU-only memory.embedder and memory.reranker; it is the profile used when there is no GPU' };
  const pending = (RP.isProfile(v.profile) && RP.pendingIn(RP.PROFILES[v.profile])) || (RP.isProfile(v.profile_cpu) && RP.pendingIn(RP.PROFILES[v.profile_cpu]))
    || RP.pendingIn({ embedder: v.embedder, reranker: v.reranker === 'none' ? null : v.reranker });
  if (pending) return { error: `memory: ${RP.pendingMessage(pending)}`, code: 'E_MODEL' };
  const routeProblem = routingProblem(v.routing);
  if (routeProblem) return { error: routeProblem.msg, ...(routeProblem.code ? { code: routeProblem.code } : {}) };
  if (!boundedInt(v.rerank_depth, 200)) return { error: 'memory.rerank_depth must be an integer from 1 to 200' };
  if (!boundedInt(v.rerank_bound_ms, 600000)) return { error: 'memory.rerank_bound_ms must be an integer from 1 to 600000' };
  if (!boundedInt(v.search_log_cap_mb, 1048576)) return { error: 'memory.search_log_cap_mb must be an integer from 1 to 1048576' };
  if (typeof v.vram_headroom_gb !== 'number' || !(v.vram_headroom_gb >= 0 && v.vram_headroom_gb <= 16)) return { error: 'memory.vram_headroom_gb must be a number from 0 to 16' };
  if (!HEAVY_FAILURE.includes(v.on_heavy_failure)) return { error: `memory.on_heavy_failure must be one of ${HEAVY_FAILURE.join(', ')}` };
  if (!HEAVY_BEHIND.includes(v.on_heavy_behind)) return { error: `memory.on_heavy_behind must be one of ${HEAVY_BEHIND.join(', ')}` };
  if (v.summaries === 'mechanical' && !v.observations) return { error: 'memory.summaries "mechanical" needs memory.observations' };
  return { value: v };
}

function isDefault(levers) {
  if (!levers) return true;
  return Object.keys(DEFAULTS).every((k) => (typeof DEFAULTS[k] === 'object' && DEFAULTS[k] !== null ? JSON.stringify(levers[k]) === JSON.stringify(DEFAULTS[k]) : levers[k] === DEFAULTS[k]));
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
  note_review_cost_cap_usd: { type: 'number', min: 0, max: 5, minExclusive: true },
  scrub_action: { type: 'enum', values: SCRUB_ACTIONS },
  scrub_max_items: { type: 'integer', min: 1, max: 500 },
  scrub_alarm_holds: { type: 'integer', min: 1, max: 500 },
  notes_sink: { type: 'enum', values: SINKS },
  profile: { type: 'enum', values: PROFILE_VALUES },
  profile_cpu: { type: 'enum', values: PROFILE_VALUES },
  embedder: { type: 'string' },
  reranker: { type: 'string' },
  routing: { type: 'json', nullable: true },
  rerank_depth: { type: 'integer', min: 1, max: 200 },
  rerank_bound_ms: { type: 'integer', min: 1, max: 600000 },
  on_heavy_failure: { type: 'enum', values: HEAVY_FAILURE },
  on_heavy_behind: { type: 'enum', values: HEAVY_BEHIND },
  search_log_cap_mb: { type: 'integer', min: 1, max: 1048576 },
  vram_headroom_gb: { type: 'number', min: 0, max: 16 },
  scrub_wall_s: { type: 'integer', min: 1, max: 3600 },
  review_wall_s: { type: 'integer', min: 1, max: 7200 },
  review_min_held: { type: 'integer', min: 1, max: 500 },
  review_max_age_runs: { type: 'integer', min: 1, max: 1000 },
  scrub_cost_cap_usd: { type: 'number', min: 0, max: 5, minExclusive: true },
  review_cost_cap_usd: { type: 'number', min: 0, max: 20, minExclusive: true },
};

function specOf(key) {
  if (OVERRIDES[key]) return Object.freeze({ ...OVERRIDES[key] });
  const t = typeof DEFAULTS[key];
  return Object.freeze({ type: t === 'boolean' || t === 'number' ? t : 'string', ...(DEFAULTS[key] === null ? { nullable: true } : {}) });
}

const TYPES = Object.freeze(Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, specOf(k)])));

module.exports = { ROUTING_TYPE_RE, ROUTING_MAX, DEFAULTS, TYPES, MODE_VALUES, parseMemoryBlock, isDefault };
