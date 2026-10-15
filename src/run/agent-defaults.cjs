'use strict';
// agent-defaults.cjs — the config file's `agents` block: a default model and effort per agent type, and for the
// orchestrator. Pure (it requires nothing), so `belay settings` can list it without loading the run manager.
//
// These are defaults only. A model or effort given explicitly (a worker_spawn argument, the run spec's `model`,
// `belay run --effort`) always wins, and an unset default means no default: the launch is what it was before.
// Every resolution names where the value came from, so a receipt never shows a bare model.

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']; // ADR 0028 decision 1; launch.cjs re-exports
const WORKER_TYPES = ['coder', 'tester', 'reviewer', 'researcher'];
const AGENT_KEYS = [...WORKER_TYPES, 'orchestrator'];
const FIELDS = ['model', 'effort'];

// Returns { value: { <type>: { model?, effort? } } } holding only the set fields, or { error }. A null field is
// "unset". Unknown types and fields are refused, never ignored: a typo would otherwise be a default that never applies.
function parseAgentsBlock(block) {
  if (block === undefined || block === null) return { value: {} };
  if (typeof block !== 'object' || Array.isArray(block)) return { error: 'agents must be an object' };
  const value = {};
  for (const [type, fields] of Object.entries(block)) {
    if (!AGENT_KEYS.includes(type)) return { error: `agents.${type} is not an agent type (known: ${AGENT_KEYS.join(', ')})` };
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return { error: `agents.${type} must be an object` };
    for (const [f, v] of Object.entries(fields)) {
      if (!FIELDS.includes(f)) return { error: `agents.${type}.${f} is not a setting (known: ${FIELDS.join(', ')})` };
      if (v === null) continue;
      if (f === 'model' && !(typeof v === 'string' && v.length > 0)) return { error: `agents.${type}.model must be a non-empty string or null` };
      if (f === 'effort' && !EFFORT_LEVELS.includes(v)) return { error: `agents.${type}.effort must be one of ${EFFORT_LEVELS.join(', ')} or null` };
      (value[type] = value[type] || {})[f] = v;
    }
  }
  return { value };
}

// From a discovered config (config.cjs `discover`): { types, path } or { error } naming the file.
function fromConfig(found) {
  const block = found && found.found && found.config ? found.config.agents : undefined;
  const parsed = parseAgentsBlock(block);
  if (parsed.error) return { error: `${found.path}: ${parsed.error}` };
  return { types: parsed.value, path: found && found.found ? found.path : null };
}

// One value and its source: the explicit one if given (an empty string is not given), else the configured default, else null from 'default'.
function pick(defaults, type, field, explicit, explicitLabel) {
  if (explicit !== undefined && explicit !== null && explicit !== '') return { value: explicit, source: explicitLabel };
  const set = defaults && defaults.types && defaults.types[type] && defaults.types[type][field];
  if (set !== undefined && set !== null) return { value: set, source: `${defaults.path} agents.${type}.${field}` };
  return { value: null, source: 'default' };
}

// The model and effort a worker spawn uses. Codex takes no effort (ADR 0028 decision 6) and the configured models are
// Claude's, so neither is applied to a Codex spawn from the config; an explicit one is left for validation as before.
function forWorker(defaults, { agent_type, model, effort, substrate }) {
  const none = { value: null, source: 'default' };
  const m = substrate === 'codex' && (model === undefined || model === null || model === '') ? none : pick(defaults, agent_type, 'model', model, 'spawn argument');
  const e = substrate === 'codex' && (effort === undefined || effort === null)
    ? none
    : pick(defaults, agent_type, 'effort', effort, 'spawn argument');
  return { agent_type, model: m, effort: e };
}

// The orchestrator's model and effort: the run spec's `model` and `belay run --effort` win, then the config's
// agents.orchestrator, then `builtinModel` (and no effort, which is Claude Code's own).
function forOrchestrator(defaults, { model, effort, builtinModel }) {
  const m = pick(defaults, 'orchestrator', 'model', model, 'run spec model');
  if (m.value === null) { m.value = builtinModel; }
  return { model: m, effort: pick(defaults, 'orchestrator', 'effort', effort, '--effort') };
}

// Written beside the adapter's mcp.json only when the config sets a worker type's default, so a run without any has the
// argv and files it always had. Returns the file's path, or null.
function writeFile(dir, defaults) {
  if (!defaults || !Object.keys(defaults.types).some((t) => t !== 'orchestrator')) return null;
  const file = `${String(dir).split('\\').join('/')}/agent-defaults.json`;
  require('node:fs').writeFileSync(file, `${JSON.stringify({ path: defaults.path, types: defaults.types }, null, 2)}\n`);
  return file;
}

module.exports = { forOrchestrator, writeFile, EFFORT_LEVELS, WORKER_TYPES, AGENT_KEYS, FIELDS, parseAgentsBlock, fromConfig, pick, forWorker };
