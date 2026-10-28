'use strict';
// run-spec.cjs — `belay run`'s spec file: the keys it knows, the ones it needs, and parseSpec, which checks
// all of it before the data dir is created, the core is opened or a process is spawned. Moved verbatim out
// of cmd-run.cjs (the 500-line rule).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const L = require('../run/launch.cjs');
const RI = require('./run-interactive.cjs');
const { parseLevers } = require('./run-levers.cjs');
const C = require('./config.cjs');
const { isPathId, pathIdMessage } = require('../core/path-id.cjs');
const AD = require('../run/agent-defaults.cjs');

const fwd = (p) => String(p).split('\\').join('/');

const KNOWN_KEYS = new Set([
  'worktree', 'prompt_file', 'brief_file', 'run_id', 'model', 'allowed_tools', 'orchestrator_dir',
  'startup_timeout_ms', 'timeout_ms', 'mcp_tool_timeout_ms', 'poll_ms', 'close_grace_ms',
  'max_fix_rounds', 'fix_hard_cap', 'fix_cutoff', 'on_embedder_failure', 'compact_at_tokens', 'stop_idle_on_done', 'max_parallel_evaluations', 'permission_prompt', 'keep_review_scratch', 'memory', 'mode', 'interactive_surface_ms', 'fullscreen',
  'native_memory', 'handback_question', // eval-only (0.3.2 memory eval); parseLevers folds them into the run's memory levers

]);
// Exactly one of prompt_file (a fully custom prompt) and brief_file (belay's template around the operator's brief) is also required.
const REQUIRED_KEYS = ['worktree'];
const PROMPT_KEYS = ['prompt_file', 'brief_file'];

// All of it: usage errors here return before the data dir is created, the core is opened, or a
// process is spawned (TASK.md step 1).
// `opts.found` is the discovered config (default: discovered from cwd); `opts.effort` is `--effort`, which beats the
// config's agents.orchestrator.effort.
// Job ids are a prefix (up to 11), the run id, a hyphen and a base-36 time (up to 9): 40 keeps them inside the 64-character id grammar.
const RUN_ID_MAX = 40;
function parseSpec(specPath, cwd, opts = {}) {
  let raw;
  try { raw = fs.readFileSync(specPath, 'utf8'); }
  catch (e) { return { error: `could not read spec file ${specPath}: ${e.message}` }; }
  let spec;
  try { spec = JSON.parse(raw); }
  catch (e) { return { error: `spec file ${specPath} is not valid JSON: ${e.message}` }; }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return { error: `spec file ${specPath} must be a JSON object` };
  }
  for (const k of Object.keys(spec)) {
    if (!KNOWN_KEYS.has(k)) return { error: `unknown spec key "${k}"` };
  }
  for (const k of REQUIRED_KEYS) {
    if (spec[k] === undefined || spec[k] === null || spec[k] === '') {
      return { error: `spec is missing required key "${k}"` };
    }
  }

  const given = PROMPT_KEYS.filter((k) => spec[k] !== undefined && spec[k] !== null && spec[k] !== '');
  if (given.length === 2) return { error: 'spec gives both "prompt_file" and "brief_file": use prompt_file for a fully custom prompt, or brief_file for the belay template around your brief, not both' };
  if (given.length === 0) return { error: 'spec is missing "prompt_file" (a fully custom prompt) or "brief_file" (the belay template around your brief)' };

  const specDir = fwd(path.dirname(specPath));
  const resolveRel = (p) => (path.isAbsolute(String(p)) ? fwd(p) : fwd(path.resolve(specDir, String(p))));

  const worktree = resolveRel(spec.worktree);
  let wtStat;
  try { wtStat = fs.statSync(worktree); } catch { return { error: `worktree ${worktree} does not exist` }; }
  if (!wtStat.isDirectory()) return { error: `worktree ${worktree} is not a directory` };

  let promptFile = null, promptText = null, briefFile = null, briefText = null;
  if (given[0] === 'brief_file') {
    briefFile = resolveRel(spec.brief_file);
    try { briefText = fs.readFileSync(briefFile, 'utf8'); }
    catch (e) { return { error: `brief_file ${briefFile} could not be read: ${e.message}` }; }
    if (!briefText.trim()) return { error: `brief_file ${briefFile} is empty` };
  } else {
    promptFile = resolveRel(spec.prompt_file);
    try { promptText = fs.readFileSync(promptFile, 'utf8'); }
    catch (e) { return { error: `prompt_file ${promptFile} could not be read: ${e.message}` }; }
  }

  if (spec.allowed_tools !== undefined) {
    const at = spec.allowed_tools;
    if (!Array.isArray(at) || !at.every((x) => typeof x === 'string')) {
      return { error: 'allowed_tools must be an array of strings' };
    }
  }

  const numeric = {};
  for (const [key, dflt] of [
    ['startup_timeout_ms', 60000], ['timeout_ms', 0],
    ['mcp_tool_timeout_ms', 120000], ['poll_ms', 1000], ['close_grace_ms', 10000],
  ]) {
    const v = spec[key] === undefined ? dflt : Number(spec[key]);
    if (!Number.isFinite(v) || v < 0) return { error: `${key} must be a non-negative number` };
    // ADR 0029 amendment 1 item 4: Claude Code parses MCP_TOOL_TIMEOUT with parseInt, so a decimal (or zero)
    // would set a client timeout the adapter's digits-only wait cap does not see.
    if (key === 'mcp_tool_timeout_ms' && (!Number.isSafeInteger(v) || v <= 0)) return { error: `${key} must be a positive integer` };
    numeric[key] = v;
  }

  const found = opts.found || C.discover(cwd);
  if (found.found && found.parse_error) return { error: `refusing to start: ${found.parse_error}` }; // its memory and agents defaults cannot be read
  const agents = AD.fromConfig(found);
  if (agents.error) return { error: agents.error };
  const levers = parseLevers(spec, { config: found.found ? { path: found.path, memory: found.config.memory } : null }); // ADR 0031 decisions 3 and 5
  if (levers.error) return { error: levers.error };
  const modeKeys = RI.parseModeKeys(spec); // ADR 0037 decision 1
  if (modeKeys.error) return { error: modeKeys.error };

  const orch = AD.forOrchestrator(agents, { model: spec.model, effort: opts.effort || null, builtinModel: L.DEFAULT_ORCHESTRATOR_MODEL });
  const runId = spec.run_id ? String(spec.run_id) : crypto.randomUUID();
  if (!isPathId(runId)) return { error: pathIdMessage('run_id', runId) };
  if (runId.length > RUN_ID_MAX) return { error: `run_id ${JSON.stringify(runId.slice(0, 50))} is ${runId.length} characters and the limit is ${RUN_ID_MAX}: belay's own job worker ids carry it (archreview-<run_id>-<time>) and must stay within 64` }; // it names the orchestrator's temp directory and prefixes job worker ids
  return {
    specPath, worktree, promptFile, promptText, briefFile, briefText, runId, levers,
    model: orch.model.value, effort: orch.effort.value, agentSettings: { orchestrator: orch }, agentDefaults: agents,
    allowedTools: spec.allowed_tools === undefined ? null : spec.allowed_tools,
    orchestratorDirRaw: spec.orchestrator_dir ? resolveRel(spec.orchestrator_dir) : null,
    ...numeric, ...modeKeys.fields,
  };
}

module.exports = { parseSpec, KNOWN_KEYS, REQUIRED_KEYS };
