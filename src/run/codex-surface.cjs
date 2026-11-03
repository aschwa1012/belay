'use strict';
// codex-surface.cjs — what belay sets on a Codex worker's launch, and what it leaves to the user's own `~/.codex/config.toml`.
// The user's model, provider, profile and sandbox mode keep coming from that file, as they always did: `--ignore-user-config` was
// probed on codex-cli 0.164.0 and rejected, because it also drops the user's provider and profile (a working setup would stop
// working). Belay overrides only what it must, with explicit flags, on every launch and resume:
//   --ignore-rules                      user and project execpolicy rules
//   -c mcp_servers.belay.required=true  a failed belay server is an exit, not a line in the log
//   -c model_reasoning_effort=<level>   only when the spawn gives one (spawn argument, or agents.<type>.codex_effort)
//   --disable <feature>                 the 12 features below
// Not isolated on this version, and the receipt says so: `$CODEX_HOME/AGENTS.md` still loads, the `spawn_agent` family is offered
// even with `multi_agent` and `multi_agent_v2` off, and Codex adds a trust entry for a worktree's git root to config.toml (no `-c` key
// reaches it: a dotted override splits a path at its dots).

const fs = require('node:fs');
const cp = require('node:child_process');
const { promisify } = require('node:util');

const execFile = promisify(cp.execFile);

const PROBED_VERSION = '0.164.0';
// 12 features of the probed version that were on and that belay supplies nothing for: the probe showed their tools gone when off
// (apps, plugins, goals, computer and browser use, image generation), or ADR 0077 named them (hooks, skill search, the model approver,
// remote plugins, multi_agent). This is not every default-on feature: about 50 are on in 0.164.0 and the rest (tool_suggest, sleep_tool,
// view_image, daemon_auto_start and others) were not judged, so they stay as Codex has them. Pinned by a test; an unknown name exits
// Codex at once (see explainStart).
const DISABLED_FEATURES = Object.freeze([
  'apps', 'browser_use', 'browser_use_full_cdp_access', 'computer_use', 'goals', 'guardian_approval',
  'hooks', 'image_generation', 'multi_agent', 'plugins', 'remote_plugin', 'skill_search',
]);
const CODEX_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh']); // Codex's levels; 'max' is Claude Code's
const LEFT_TO_USER_CONFIG = Object.freeze([
  'model (unless agents.<type>.codex_model or the spawn names one)', 'model provider and profile', 'the Windows sandbox mode',
  'reasoning effort (unless the spawn or agents.<type>.codex_effort gives one)',
]);
// What belay could not isolate on the probed version: Codex does these itself, whatever belay passes.
const NOT_ISOLATED = Object.freeze([
  '$CODEX_HOME/AGENTS.md still loads', 'the spawn_agent tools are still offered',
  "Codex adds a git worktree's root to the user's config.toml as trusted",
]);

function checkEffort(effort) {
  if (!CODEX_EFFORTS.includes(effort)) {
    const e = new Error(`codex effort must be one of ${CODEX_EFFORTS.join(', ')} (got ${JSON.stringify(effort)}); max is Claude Code's`);
    e.code = 'E_ARGS';
    e.detail = { field: 'effort', effort, expected: CODEX_EFFORTS };
    throw e;
  }
}

// The arguments that follow the MCP overrides, in a fixed order. No effort: nothing is passed and the user's config decides.
function surfaceArgs(effort = null) {
  const argv = ['--ignore-rules', '-c', 'mcp_servers.belay.required=true'];
  if (effort) { checkEffort(effort); argv.push('-c', `model_reasoning_effort="${effort}"`); }
  for (const f of DISABLED_FEATURES) argv.push('--disable', f);
  return argv;
}

// The spawn result's `codex_surface` (null for Claude Code): belay's intent, named as such. `agent` is the typed spawn's resolution.
function forSpawn(substrate, effort, agent) {
  if (substrate !== 'codex') return null;
  return {
    probed_version: PROBED_VERSION,
    set_by_belay: {
      ignore_rules: true, belay_server_required: true, disabled_features: [...DISABLED_FEATURES],
      effort: effort ? { value: effort, source: agent ? agent.effort.source : 'spawn argument' } : null,
    },
    left_to_user_config: [...LEFT_TO_USER_CONFIG],
    not_isolated: [...NOT_ISOLATED],
  };
}

// A launch that Codex ends at once on a feature name it does not know: the pinned list is for the probed version, and a Codex
// upgrade can rename a feature. Returns { message, detail } naming the feature, the version Codex reports and its stderr line, or null.
async function explainStart(workerDir, stderr) {
  const m = /Unknown feature flag:[ \t]*(\S+)/.exec(String(stderr || '')); // same line: a newline after the colon is not a name
  if (!m) return null;
  let version = null;
  try {
    const spec = JSON.parse(fs.readFileSync(`${workerDir}/argv.json`, 'utf8')).spec;
    const script = /\.(c|m)?js$/i.test(spec.args[0] || '') ? [spec.args[0]] : [];
    const r = await execFile(spec.exe, [...script, '--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true }); // async: the manager is not held while it runs
    version = String(r.stdout).trim().slice(0, 80) || null;
  } catch { /* the version stays unknown, and the message says so */ }
  const line = (String(stderr).split('\n').find((l) => l.includes(m[0])) || m[0]).trim().slice(0, 200);
  return {
    message: `Codex exited at once: "${line}". Belay disables ${DISABLED_FEATURES.length} features by name, pinned for codex-cli ${PROBED_VERSION}; this Codex is ${version || 'of an unknown version'} and does not know "${m[1]}". Upgrade or downgrade Codex to a version belay supports, or report this to the belay maintainers`,
    detail: { cause: 'unknown_codex_feature', feature: m[1], codex_version: version, pinned_for: PROBED_VERSION, stderr_line: line },
  };
}

module.exports = { PROBED_VERSION, DISABLED_FEATURES, CODEX_EFFORTS, LEFT_TO_USER_CONFIG, NOT_ISOLATED, checkEffort, surfaceArgs, forSpawn, explainStart };
