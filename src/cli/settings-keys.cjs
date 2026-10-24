'use strict';
// settings-keys.cjs — the keys `belay settings` answers for, beyond the panel's `mod.*` ones: the memory levers
// (`memory.<lever>`, project defaults a run inherits) and the per-agent-type model and effort defaults
// (`agents.<type>.model|effort`). The memory keys are derived from src/core/memory-levers.cjs, never listed here, so
// a lever added there appears in `settings` with no edit. Both modules this requires are pure (they require nothing
// of src/core's store), so listing the settings loads no embedder and starts no process.

const C = require('./config.cjs');
const ML = require('../core/memory-levers.cjs');
const AD = require('../run/agent-defaults.cjs');
const EM = require('../core/embedder-mode.cjs');
const TP = require('../run/tool-policy.cjs'); // pure

const MOD_NAMES = C.KEY_NAMES.filter((k) => C.KEYS[k].allowed);
const MEMORY_NAMES = Object.keys(ML.DEFAULTS).filter((k) => !ML.EVAL_ONLY.includes(k)).map((k) => `memory.${k}`);
const AGENT_NAMES = AD.AGENT_KEYS.flatMap((t) => AD.fieldsOf(t).map((f) => `agents.${t}.${f}`));
const NAMES = [...MOD_NAMES, ...MEMORY_NAMES, ...AGENT_NAMES];

const kindOf = (key) => (MOD_NAMES.includes(key) ? 'mod' : key.startsWith('memory.') ? 'memory' : 'agents');
const leverOf = (key) => key.slice('memory.'.length);
const fieldOf = (key) => key.slice(key.lastIndexOf('.') + 1);

// memory.on_embedder_failure also takes the 0.2.0 names (stop, continue). Every reader and the writer map them with the one
// function `belay run` uses (embedder-mode.cjs), so settings never disagrees with a run about the effective value.
const isModeKey = (key) => key === 'memory.on_embedder_failure';
// { value, from } when `raw` is a legacy name mapped to its current one; null otherwise.
const legacyMap = (key, raw) => (isModeKey(key) && typeof raw === 'string' && EM.ALIASES[raw] !== undefined ? { value: EM.normalize(raw), from: raw } : null);
const legacyNote = (m) => `${JSON.stringify(m.from)} is the 0.2.0 name of ${JSON.stringify(m.value)}; read as ${JSON.stringify(m.value)}`;

// What a key accepts: { type, allowed (array or null), text (for the listing) }.
function shape(key) {
  const kind = kindOf(key);
  if (kind === 'mod') return { type: 'enum', allowed: C.KEYS[key].allowed, text: C.KEYS[key].allowed.join(' | ') };
  if (kind === 'agents') {
    if (fieldOf(key) === AD.TOOLS_FIELD) return { type: 'tools', allowed: null, text: `comma-separated tools from ${TP.POLICY_TOOLS.join(', ')} | null (the built-in policy)` };
    return fieldOf(key) === 'effort'
      ? { type: 'enum', allowed: [...AD.EFFORT_LEVELS, null], text: `${AD.EFFORT_LEVELS.join(' | ')} | null` }
      : { type: 'model', allowed: null, text: fieldOf(key) === AD.CODEX_FIELD ? 'a Codex model name | null (no default: the Codex config decides)' : 'a model name | null (no default)' };
  }
  const s = ML.TYPES[leverOf(key)];
  if (s.type === 'boolean') return { type: 'boolean', allowed: [true, false], text: 'true | false' };
  if (s.type === 'enum') return { type: 'enum', allowed: s.values, text: s.values.join(' | ') };
  if (s.type === 'string') return { type: 'string', nullable: !!s.nullable, allowed: null, text: s.nullable ? 'a name | null' : 'a string' };
  const range = s.min !== undefined ? ` ${s.minExclusive ? '>' : ''}${s.min}${s.minExclusive ? '' : '..'}${s.minExclusive ? ' to ' : ''}${s.max}` : '';
  return { type: s.type, allowed: null, text: `${s.type}${range}` };
}

function defaultOf(key) {
  const kind = kindOf(key);
  if (kind === 'mod') return C.KEYS[key].default;
  if (kind === 'memory') return ML.DEFAULTS[leverOf(key)];
  if (key === 'agents.orchestrator.model') return AD.ORCHESTRATOR_MODEL;
  if (fieldOf(key) === AD.TOOLS_FIELD) return [...TP.forType(null, key.split('.')[1]).tools]; // the built-in tool policy
  const built = AD.BUILTIN[key.split('.')[1]]; // the built-in roster default, which a stored null falls back to
  return built && built[fieldOf(key)] !== undefined ? built[fieldOf(key)] : null;
}

// Parses the CLI's text into the value its key takes. Returns { value } or { error }; parseMemoryBlock still judges
// the whole block before anything is written.
function parseValue(key, raw) {
  const sh = shape(key);
  if (typeof raw !== 'string') { // an already-typed value from a caller other than the command line
    const ok = kindOf(key) === 'mod' ? sh.allowed.includes(raw) : checkStored(key, raw).ok;
    return ok ? { value: raw } : { error: `${JSON.stringify(raw)} is not a value of ${key} (${sh.text})` };
  }
  const bad = (what) => ({ error: `${JSON.stringify(raw)} is not ${what} for ${key}` });
  const legacy = legacyMap(key, raw);
  if (legacy) return { value: legacy.value, mapped_from: legacy.from }; // written as the current name
  switch (sh.type) {
    case 'boolean': return raw === 'true' || raw === 'false' ? { value: raw === 'true' } : bad('true or false');
    case 'integer': return /^-?\d+$/.test(raw) ? { value: Number(raw) } : bad('an integer');
    case 'number': return /^-?\d+(\.\d+)?$/.test(raw) ? { value: Number(raw) } : bad('a number');
    case 'model': {
      if (raw === 'null') return { value: null };
      if (!raw) return bad('a model name or null');
      const chk = checkStored(key, raw); // a Codex model under a Claude `model` key is refused here, before anything is written
      return chk.ok ? { value: raw } : { error: `${JSON.stringify(raw)} is not a value of ${key}: ${chk.reason}` };
    }
    case 'string': return { value: raw === 'null' && sh.nullable ? null : raw };
    case 'tools': {
      if (raw === 'null') return { value: null };
      const c = TP.checkList(raw.split(',').map((t) => t.trim()).filter(Boolean), key);
      return c.error ? { error: `${JSON.stringify(raw)} is not a value of ${key}: ${c.error}` } : { value: c.value };
    }
    default: {
      if (raw === 'null' && sh.allowed.includes(null)) return { value: null };
      return sh.allowed.includes(raw) ? { value: raw }
        : { error: `${JSON.stringify(raw)} is not a value of ${key}; the allowed values are ${sh.allowed.filter((a) => a !== null).join(', ')}` };
    }
  }
}

function storedAt(config, key) {
  let cur = config;
  for (const p of key.split('.')) {
    if (!cur || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, p)) return { present: false };
    cur = cur[p];
  }
  return { present: true, value: cur };
}

// A stored value as the key would accept it, or why not. A stored null on an agents key is "unset".
function checkStored(key, value) {
  if (kindOf(key) === 'agents') {
    if (value === null) return { ok: true, unset: true };
    if (fieldOf(key) === AD.TOOLS_FIELD) { const c = TP.checkList(value, key); return c.error ? { ok: false, reason: c.error } : { ok: true }; }
    if (fieldOf(key) === 'effort') return AD.EFFORT_LEVELS.includes(value) ? { ok: true } : { ok: false, reason: `${JSON.stringify(value)} is not one of ${AD.EFFORT_LEVELS.join(', ')}` };
    if (!(typeof value === 'string' && value)) return { ok: false, reason: `${JSON.stringify(value)} is not a model name` };
    return fieldOf(key) === 'model' && AD.NOT_CLAUDE.test(value) ? { ok: false, reason: `${JSON.stringify(value)} is not a Claude model; a Codex model goes in ${key.replace(/model$/, AD.CODEX_FIELD)}` } : { ok: true };
  }
  const block = { [leverOf(key)]: value };
  const t = typeof value;
  const s = ML.TYPES[leverOf(key)];
  const typeOk = s.type === 'boolean' ? t === 'boolean' : s.type === 'string' ? (value === null ? !!s.nullable : t === 'string') : s.type === 'enum' ? (isModeKey(key) ? EM.normalize(value) !== null : s.values.includes(value)) : t === 'number';
  if (!typeOk) return { ok: false, reason: `${JSON.stringify(value)} is not ${shape(key).text}` };
  // Ranges and patterns are parseMemoryBlock's to judge; a prerequisite on another key is not this key's fault.
  const r = ML.parseMemoryBlock(block);
  return r.error && !/ needs memory\./.test(r.error) && !/cannot be combined/.test(r.error) ? { ok: false, reason: r.error } : { ok: true };
}

// { key, value, source, default, allowed, describe, type, invalid? } for a memory or agents key; the mod keys go through config.cjs.
// `memory.notes` left unstated resolves per run: on when the memory block has a project and keeps redaction. Show that
// state and why, instead of the bare lever default (off), which says nothing about the project.
function effectiveNotes(found, out) {
  const cfg = found.found && found.config && found.config.memory;
  const block = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {};
  const r = ML.parseMemoryBlock(block);
  if (r.error) return { ...out, note: 'effective: off (the memory block is refused: ' + r.error + ')' };
  const why = r.value.notes ? 'on, because memory.project is set' : block.redact === false ? 'off, because memory.redact is false' : 'off, because memory.project is not set';
  return { ...out, value: r.value.notes, note: 'effective: ' + why };
}

function effective(found, key) {
  if (kindOf(key) === 'mod') {
    const e = C.effective(found, key);
    return { key, value: e.value, source: e.source, default: C.KEYS[key].default, allowed: e.allowed, describe: e.describe, ...(e.invalid ? { invalid: e.invalid } : {}) };
  }
  const dflt = defaultOf(key);
  const sh = shape(key);
  const stored = found.found ? storedAt(found.config, key) : { present: false };
  const out = {
    key, value: dflt, source: 'default', default: dflt, allowed: sh.allowed, type: sh.text,
    describe: kindOf(key) === 'memory' ? 'memory lever: the default every run inherits; the run spec\'s memory block overrides it key by key'
      : fieldOf(key) === AD.TOOLS_FIELD ? 'the agent type\'s tools: a spawn of that type gets them, and its allowed_tools may narrow them, never widen them'
        : 'default for the agent type; an explicit model or effort always wins',
  };
  const withNote = (o) => (key === 'memory.notes' && o.source === 'default' ? effectiveNotes(found, o) : o);
  if (!stored.present) return withNote(out);
  const chk = checkStored(key, stored.value);
  if (!chk.ok) return { ...out, invalid: { stored: stored.value, reason: `${chk.reason}; the default ${JSON.stringify(dflt)} is used` } };
  if (chk.unset) return withNote(out);
  const legacy = legacyMap(key, stored.value);
  if (legacy) return { ...out, value: legacy.value, source: found.path, mapped_from: legacy.from, note: legacyNote(legacy) };
  return { ...out, value: fieldOf(key) === AD.TOOLS_FIELD && kindOf(key) === 'agents' ? TP.checkList(stored.value).value : stored.value, source: found.path };
}

// The memory block as the config holds it, after setting `key` to `value`; `null` when it is not an object.
function memoryBlockWith(config, key, value) {
  const cur = config && config.memory;
  if (cur !== undefined && (cur === null || typeof cur !== 'object' || Array.isArray(cur))) return null;
  return { ...(cur || {}), [leverOf(key)]: value };
}

// Refuses a write the run would later refuse: the whole resulting memory block goes through parseMemoryBlock
// (prerequisites included). Returns an error string or null. Agents values are checked by parseValue.
function refusal(config, key, value) {
  if (kindOf(key) !== 'memory') return null;
  const block = memoryBlockWith(config, key, value);
  if (block === null) return '"memory" in the config file is not an object';
  const r = ML.parseMemoryBlock(block);
  return r.error ? `${r.error}; nothing was written` : null;
}

// After a write, would a fresh read see this value from this file? A stored null on an agents key is "unset", read as the default.
// A null written to an agents key is read back as that key's built-in default.
const expectedValue = (key, value) => (kindOf(key) === 'agents' && value === null ? defaultOf(key) : value);
const expectedSource = (key, value, file) => (kindOf(key) === 'agents' && value === null ? 'default' : file);

// The memory block's own verdict, for a listing: an error string when the stored block would be refused by a run.
// The eval-only run-spec keys are no project default: a config memory block naming one is refused (null when it names none).
function evalOnlyIn(memory) {
  const bad = memory && typeof memory === 'object' ? ML.EVAL_ONLY.filter((k) => Object.prototype.hasOwnProperty.call(memory, k)) : [];
  return bad.length ? `${bad.join(', ')} ${bad.length > 1 ? 'are' : 'is'} eval-only: set in a run spec (top level), never in the config's memory block` : null;
}

function memoryBlockError(found) {
  if (!found.found || found.config.memory === undefined) return null;
  const eo = evalOnlyIn(found.config.memory);
  if (eo) return eo;
  const r = ML.parseMemoryBlock(found.config.memory);
  return r.error || null;
}

module.exports = { NAMES, MOD_NAMES, MEMORY_NAMES, AGENT_NAMES, kindOf, shape, parseValue, effective, refusal, expectedSource, expectedValue, memoryBlockError };
