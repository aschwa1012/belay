'use strict';
// Launch table for both substrates: ADR 0001 §1 (Claude Code launch, Codex launch), ADR 0008 §6
// (Codex resume: no -C, no -s; cwd comes from the spawn option), ADR 0007 §6 (settings file and env
// scrub). Three argv builders, the per-worker mcp.json and settings.json, the environment, and the
// argv hash. Nothing here spawns anything.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

// Where the Claude Code and Codex CLI executables are found: exe-discovery.cjs (env, then config, then PATH).
// belay needs Claude Code 2.1.280 or later (ready.cjs MIN_CLAUDE_CODE_VERSION). The executable itself, not
// the npm `claude.cmd` shim, since Node spawns no .cmd without a shell.
const ED = require('./exe-discovery.cjs');

const MCP_SERVER_NAME = 'belay';
// A test default only: production workers are Sonnet or Opus by role (ADR 0021 amendment 1).
const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5-5';
const DEFAULT_ALLOWED_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'mcp__belay'];
// ADR 0021 decision 2: Claude Code's classifier stands in front of every call the rules do not
// settle. On a model without auto mode (Haiku) the session silently starts in `default` instead;
// the ready event's `permission_mode` says which one it got (decision 3).
const DEFAULT_PERMISSION_MODE = 'auto';
// ADR 0028 decision 1: the levels `--effort` takes; a worker's level is a spawn argument.
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const DEFAULT_CODEX_SANDBOX = 'workspace-write';
const WORKER_NAME_PREFIX = 'belay-';

const { SCRUB_EXACT, SCRUB_PREFIXES, SCRUB_CWD, CODEX_RUST_LOG, buildEnv, fwd } = require('./env.cjs'); // moved whole (500-line rule)

// build step 6d: moved verbatim to wire-log.cjs (the 500-line rule) and re-exported below unchanged.
const { wireLogPath, wireLogHasToolsList, WIRE_LOG_NAME, TOOLS_LIST } = require('./wire-log.cjs');
const S = require('./surface.cjs'); // ADR 0024: the tool list, setting-sources and cwd hygiene.
const CP = require('./compaction.cjs'); // ADR 0007 decision 3: the compact_at_tokens lever's hooks block


function claudeExe() {
  return ED.exeFor('claude');
}
function codexExe() {
  return ED.exeFor('codex');
}
// An executable path ending in .cjs/.js/.mjs is run by this Node binary with the script as its
// first argument. That is how a fake substrate is substituted through BELAY_CLAUDE_EXE in tests
// without a shell, which Node refuses for .cmd/.bat since CVE-2024-27980. Anything else is spawned
// directly.
function resolveExe(exePath) {
  const exe = fwd(exePath);
  if (/\.(c|m)?js$/i.test(exe)) return { command: fwd(process.execPath), prefixArgs: [exe] };
  return { command: exe, prefixArgs: [] };
}

function mcpServerPath() {
  return fwd(path.resolve(__dirname, '..', 'mcp', 'belay-mcp.cjs'));
}
function userSettingsPath() {
  return fwd(path.join(os.homedir(), '.claude', 'settings.json'));
}
function workerDir(dataDir, workerId) {
  return fwd(path.join(dataDir, 'workers', workerId));
}
function workerName(workerId) {
  return WORKER_NAME_PREFIX + workerId;
}

// ---------------------------------------------------------------- environment


// --------------------------------------------------------- per-worker files

// The worker adapter's own argv (contract §1): identity comes from here and nowhere else (P9).
// `logPath` appends the contract's optional `--log <file>`. Every worker adapter gets one (build 12 A1):
// ADR 0026 §3 names each keepalive tick's line as the proof the keepalive worked, and Codex's ADR 0001 §8
// tools/list check reads the same file. The argv hash is over the substrate's own argv, which names
// mcp.json by path and not by content, so adding `--log` here does not change it; a worker launched by
// an older belay keeps the mcp.json its process already read, and a restart rewrites the file.
function workerAdapterArgs({ workerId, runId, dataDir, mcpPath, logPath = null, permit = false, permitWaitMs = null }) {
  const argv = [
    mcpPath || mcpServerPath(),
    '--role',
    'worker',
    '--worker-id',
    workerId,
    '--run',
    runId,
    '--data',
    fwd(path.resolve(dataDir)),
  ];
  // build step 6d, ADR 0020 decision 1: opt-in per spawn; a worker launched without permit gets no
  // flag and no environment change, so the listing it presents to the substrate is unchanged.
  if (permit) {
    argv.push('--permit');
    if (typeof permitWaitMs === 'number') argv.push('--permit-wait-ms', String(permitWaitMs));
  }
  if (logPath) argv.push('--log', fwd(logPath));
  return argv;
}

function mcpConfig({ workerId, runId, dataDir, mcpPath, logPath = null, permit = false, permitWaitMs = null }) {
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: 'stdio',
        command: fwd(process.execPath),
        args: workerAdapterArgs({ workerId, runId, dataDir, mcpPath, logPath, permit, permitWaitMs }),
      },
    },
  };
}

// ADR 0007 §6: every plugin named in the user's settings is disabled for the worker. Read at launch
// time, not cached, so a plugin added between launches is still disabled.
// A read or parse failure here means the worker's settings file disables nothing, which is the
// hygiene rule failing on the one machine it matters on. It is reported, never swallowed: the
// caller records it on the worker so a view can say the worker may have inherited the plugins.
function readPluginConfig(settingsPath) {
  const p = settingsPath || userSettingsPath();
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    const names = parsed && parsed.enabledPlugins;
    if (names && typeof names === 'object') return { names: Object.keys(names), read: true, path: p, error: null };
    return { names: [], read: true, path: p, error: null };
  } catch (e) {
    return {
      names: [],
      read: false,
      path: p,
      error: (e && e.code === 'ENOENT')
        ? 'no user settings file at ' + p + ', so no plugin was named to disable'
        : 'could not read or parse ' + p + ': ' + (e && e.message) + '. The worker settings file disables nothing, so the worker may inherit the user plugins (ADR 0007 §6).',
      unreadable: !(e && e.code === 'ENOENT'),
    };
  }
}

function readEnabledPluginNames(settingsPath) {
  return readPluginConfig(settingsPath).names;
}

// ADR 0024: a caller that passes `cwd` gets the hygiene block merged in; one that does not is unchanged.
function workerSettings(pluginNames, { cwd } = {}) {
  const enabledPlugins = {};
  for (const n of pluginNames || []) enabledPlugins[n] = false;
  if (!cwd) return { enabledPlugins };
  return { enabledPlugins, ...S.hygieneSettings(cwd) };
}

function writeWorkerFiles({ dir, workerId, runId, dataDir, mcpPath, settingsPath, logPath = null, permit = false, permitWaitMs = null, cwd = null, compactAt = null }) {
  fs.mkdirSync(dir, { recursive: true });
  const mcpJsonPath = fwd(path.join(dir, 'mcp.json'));
  const workerSettingsPath = fwd(path.join(dir, 'settings.json'));
  fs.writeFileSync(
    mcpJsonPath,
    JSON.stringify(mcpConfig({ workerId, runId, dataDir, mcpPath, logPath, permit, permitWaitMs }), null, 2) + '\n'
  );
  const plugins = readPluginConfig(settingsPath);
  const hooks = CP.hooksBlock({ dir, compactAt }); // null, and no `hooks` key at all, unless the lever is on
  fs.writeFileSync(workerSettingsPath, JSON.stringify({ ...workerSettings(plugins.names, { cwd }), ...(hooks ? { hooks } : {}) }, null, 2) + '\n');
  return { mcpJsonPath, settingsPath: workerSettingsPath, plugins };
}

// ------------------------------------------------------------- argv builders

// ADR 0001 §1 plus ADR 0007 §6 (--settings). ADR 0001 §1 lists both `--append-system-prompt-file
// <task>` and "the task written to stdin immediately after spawn". The measured prototype (R5,
// prototypes/run-harness/harness.cjs) used stdin only, and contract §5 puts the resume line in the
// first message, so stdin is the default here and the flag is opt-in through
// `appendSystemPromptFile`. Sending the same task on both channels would double the injected bytes
// against the ADR 0007 §7 budget. Deviation named in the build report.
function claudeLaunchArgv(opts) {
  const {
    workerId,
    mcpJsonPath,
    settingsPath,
    model = DEFAULT_CLAUDE_MODEL,
    allowedTools = DEFAULT_ALLOWED_TOOLS,
    permissionMode = DEFAULT_PERMISSION_MODE,
    resumeSessionId = null,
    appendSystemPromptFile = null,
    permissionPromptTool = false,
    effort = null,
    tools = null,
  } = opts;
  const argv = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--name',
    workerName(workerId),
    '--model',
    model,
    '--strict-mcp-config',
    '--mcp-config',
    fwd(mcpJsonPath),
    '--settings',
    fwd(settingsPath),
    '--tools', // ADR 0024 decisions 1 and 3: on every call, with or without a resume.
    (S.narrowTools(tools) || S.CLAUDE_TOOLS).join(','),
    S.SETTING_SOURCES_ARG, // ADR 0024 amendment 1: one token, no setting sources
    '--allowedTools',
    ...allowedTools,
    '--permission-mode',
    permissionMode,
  ];
  if (effort) argv.push('--effort', effort); // ADR 0028: on every launch, a resume included
  // build step 6d, ADR 0020 decision 1: the worker adapter's own prompt tool, named after the MCP
  // server (`belay`) as the adapter itself is configured under, and before the resume/system-prompt
  // flags, opt-in per spawn.
  if (permissionPromptTool) argv.push('--permission-prompt-tool', `mcp__${MCP_SERVER_NAME}__permit`);
  if (appendSystemPromptFile) argv.push('--append-system-prompt-file', fwd(appendSystemPromptFile));
  if (resumeSessionId) argv.push('--resume', resumeSessionId);
  return argv;
}

// MCP for Codex is configured through -c key=value pairs, not a config file. `args` is a TOML array,
// which is JSON-shaped for a list of strings. WR-5: tools must be pre-approved or every call is
// refused under approval_policy="never".
function codexMcpArgs(adapterArgs) {
  const argsToml = JSON.stringify(adapterArgs.map(fwd));
  return [
    '-c',
    'approval_policy="never"',
    '-c',
    `mcp_servers.${MCP_SERVER_NAME}.command="${fwd(process.execPath)}"`,
    '-c',
    `mcp_servers.${MCP_SERVER_NAME}.args=${argsToml}`,
    '-c',
    `mcp_servers.${MCP_SERVER_NAME}.default_tools_approval_mode="approve"`,
  ];
}

function codexLaunchArgv(opts) {
  const {
    worktree,
    adapterArgs,
    prompt,
    sandbox = DEFAULT_CODEX_SANDBOX,
    model = null,
  } = opts;
  const argv = [
    'exec',
    '--json',
    '-C',
    fwd(worktree),
    '--skip-git-repo-check',
    '-s',
    sandbox,
    ...codexMcpArgs(adapterArgs),
  ];
  if (model) argv.push('-m', model);
  argv.push(prompt);
  return argv;
}

// ADR 0008 §6: `exec resume` is a strict subset of `exec`. No -C and no -s; the working directory is
// supplied through the spawn's own cwd option. Passing either exits 2 at the parse layer in ~76 ms.
function codexResumeArgv(opts) {
  const { threadId, adapterArgs, prompt, model = null } = opts;
  const argv = [
    'exec',
    'resume',
    threadId,
    '--json',
    '--skip-git-repo-check',
    ...codexMcpArgs(adapterArgs),
  ];
  if (model) argv.push('-m', model);
  argv.push(prompt);
  return argv;
}

// --------------------------------------------------- headless orchestrator (ADR 0009 §1)

// The fourth launch-table entry, named in ADR 0009's consequences: `claude -p` with the orchestrator
// adapter in a strict MCP config, spawned by the CLI, which is therefore the parent of the session
// that is the parent of every worker. Invariant 1 holds through that chain.
//
// Two things differ from a worker and both are load-bearing.
//
// The adapter's argv carries no --worker-id: an orchestrator has none, and belay-mcp.cjs refuses one
// in that role. Identity is still argv-only (invariant 3).
//
// Its files cannot live in the data dir. api.md §1 fixes that layout to memory.db, owner.lock/,
// workers/<id>/ and tmp/, and says in as many words that an orchestrator adapter never logs inside
// it. So the caller supplies a directory outside the data dir and this refuses one inside, rather
// than inventing an `orchestrator/` entry the contract does not have.
// ADR 0021 amendment 4: the orchestrator is Opus 5.5. Sonnet 5 is retired.
const DEFAULT_ORCHESTRATOR_MODEL = 'claude-opus-5-5';

function orchestratorAdapterArgs({ runId, dataDir, mcpPath, logPath = null, compactAt = null, worktree = null }) {
  const argv = [
    mcpPath || mcpServerPath(),
    '--role',
    'orchestrator',
    '--run',
    runId,
    '--data',
    fwd(path.resolve(dataDir)),
  ];
  if (logPath) argv.push('--log', fwd(logPath));
  if (compactAt != null) argv.push('--compact-at', String(compactAt)); // ADR 0007 decision 3: the workers' lever
  if (worktree) argv.push('--worktree', fwd(path.resolve(worktree))); // ADR 0043 decision 1: the knowledge agent's cwd
  return argv;
}

function orchestratorMcpConfig({ runId, dataDir, mcpPath, logPath = null, compactAt = null, worktree = null }) {
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: 'stdio',
        command: fwd(process.execPath),
        args: orchestratorAdapterArgs({ runId, dataDir, mcpPath, logPath, compactAt, worktree }),
      },
    },
  };
}

function assertOutsideDataDir(dir, dataDir) {
  const d = fwd(path.resolve(dir));
  const dd = fwd(path.resolve(dataDir));
  if (d === dd || d.startsWith(`${dd}/`)) {
    throw new Error(
      `orchestrator files must not live inside the data dir (${dd}); api.md §1 fixes what lives there`
    );
  }
  return d;
}

function writeOrchestratorFiles({ dir, runId, dataDir, mcpPath, settingsPath, logPath = null, cwd = null, compactAt = null }) {
  const outDir = assertOutsideDataDir(dir, dataDir);
  fs.mkdirSync(outDir, { recursive: true });
  const mcpJsonPath = fwd(path.join(outDir, 'mcp.json'));
  const orchSettingsPath = fwd(path.join(outDir, 'settings.json'));
  fs.writeFileSync(
    mcpJsonPath,
    JSON.stringify(orchestratorMcpConfig({ runId, dataDir, mcpPath, logPath, compactAt, worktree: cwd }), null, 2) + '\n'
  );
  // Same hygiene as a worker (ADR 0007 §6): the operator's plugins and their hooks are disabled, so
  // the orchestrator's own context is not shaped by whatever is installed on the host. For the
  // context experiment that is not hygiene but the measurement itself — a plugin's hooks would
  // inject bytes into the very token series being compared.
  const plugins = readPluginConfig(settingsPath);
  fs.writeFileSync(orchSettingsPath, JSON.stringify(workerSettings(plugins.names, { cwd }), null, 2) + '\n');
  return { mcpJsonPath, settingsPath: orchSettingsPath, plugins, dir: outDir };
}

// No --name: ADR 0008 §4 filters the machine-wide registry to this run's own `belay-` worker names,
// and an orchestrator carrying that prefix would be listed as one of its own workers.
function orchestratorLaunchArgv(opts) {
  const {
    mcpJsonPath,
    settingsPath,
    model = DEFAULT_ORCHESTRATOR_MODEL,
    allowedTools = null,
    permissionMode = DEFAULT_PERMISSION_MODE,
    resumeSessionId = null,
    appendSystemPromptFile = null,
    effort = null,
  } = opts;
  const argv = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    model,
    '--strict-mcp-config',
    '--mcp-config',
    fwd(mcpJsonPath),
    '--settings',
    fwd(settingsPath),
    '--tools', // ADR 0024 decisions 1 to 3: the orchestrator gets the same list and treatment.
    S.CLAUDE_TOOLS.join(','),
    S.SETTING_SOURCES_ARG,
  ];
  if (allowedTools && allowedTools.length) argv.push('--allowedTools', ...allowedTools);
  argv.push('--permission-mode', permissionMode);
  if (effort) argv.push('--effort', effort); // ADR 0028 decision 5
  if (appendSystemPromptFile) argv.push('--append-system-prompt-file', fwd(appendSystemPromptFile));
  if (resumeSessionId) argv.push('--resume', resumeSessionId);
  return argv;
}

// ADR 0037 decision 2: the interactive orchestrator's argv. Headless's hygiene without `-p`, the two
// stream-json formats and `--verbose`, and without `--resume`. No positional prompt (decision 3): the
// run's prompt travels in `--append-system-prompt-file`. `--session-id` lets the launcher find the
// session file; `--debug-file` is what the surface gate reads (decision 5).
function orchestratorInteractiveArgv(opts) {
  const {
    mcpJsonPath,
    settingsPath,
    model = DEFAULT_ORCHESTRATOR_MODEL,
    allowedTools = null,
    permissionMode = DEFAULT_PERMISSION_MODE,
    appendSystemPromptFile,
    effort = null,
    sessionId,
    debugFile,
    pluginDir = null, // ADR 0037 amendment 5: belay's own mod, the spawn-time copy; the only plugin the gate admits
  } = opts;
  if (!sessionId) throw new Error('orchestratorInteractiveArgv: sessionId is required');
  if (!debugFile) throw new Error('orchestratorInteractiveArgv: debugFile is required');
  if (!appendSystemPromptFile) throw new Error('orchestratorInteractiveArgv: appendSystemPromptFile is required');
  const argv = [
    '--model',
    model,
    '--strict-mcp-config',
    '--mcp-config',
    fwd(mcpJsonPath),
    '--settings',
    fwd(settingsPath),
    '--tools',
    S.CLAUDE_TOOLS.join(','),
    S.SETTING_SOURCES_ARG,
  ];
  if (allowedTools && allowedTools.length) argv.push('--allowedTools', ...allowedTools);
  argv.push('--permission-mode', permissionMode);
  if (effort) argv.push('--effort', effort);
  argv.push('--append-system-prompt-file', fwd(appendSystemPromptFile));
  if (pluginDir) argv.push('--plugin-dir', fwd(pluginDir));
  argv.push('--session-id', sessionId, '--debug-file', fwd(debugFile));
  return argv;
}

// ------------------------------------------------------------------- receipt

// argv_hash is sha256 over `JSON.stringify({ exe, args, cwd })` — the exact bytes written to
// argv.json's `spec` field, so a reader can recompute it from that file alone. Key order is fixed
// here rather than taken from the caller's object.
function argvHash(spec) {
  const canonical = { exe: spec.exe, args: spec.args, cwd: spec.cwd };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function writeArgvJson(dir, spec) {
  const argv_hash = argvHash(spec);
  const body = { spec, argv_hash, written_at: Date.now() };
  fs.writeFileSync(fwd(path.join(dir, 'argv.json')), JSON.stringify(body, null, 2) + '\n');
  return argv_hash;
}

module.exports = {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_ALLOWED_TOOLS,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_CODEX_SANDBOX,
  MCP_SERVER_NAME,
  EFFORT_LEVELS,
  narrowTools: S.narrowTools,
  SCRUB_EXACT,
  SCRUB_PREFIXES,
  SCRUB_CWD,
  fwd,
  claudeExe,
  codexExe,
  resolveExe,
  mcpServerPath,
  userSettingsPath,
  workerDir,
  workerName,
  buildEnv,
  workerAdapterArgs,
  mcpConfig,
  readEnabledPluginNames,
  readPluginConfig,
  wireLogPath,
  wireLogHasToolsList,
  CODEX_RUST_LOG,
  WIRE_LOG_NAME,
  TOOLS_LIST,
  workerSettings,
  writeWorkerFiles,
  claudeLaunchArgv,
  DEFAULT_ORCHESTRATOR_MODEL,
  orchestratorAdapterArgs,
  orchestratorMcpConfig,
  writeOrchestratorFiles,
  orchestratorLaunchArgv,
  orchestratorInteractiveArgv,
  codexMcpArgs,
  codexLaunchArgv,
  codexResumeArgv,
  argvHash,
  writeArgvJson,
};
