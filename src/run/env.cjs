'use strict';
// The child environment for a launch: the scrub lists and buildEnv, moved whole out of launch.cjs
// (the 500-line rule) and re-exported there under the same names.

const path = require('node:path');

const fwd = (p) => String(p).replace(/\\/g, '/');

// ADR 0007 §6. Exact names plus the prefixes below.
const SCRUB_EXACT = [
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
  'CLAUDE_CODE_NO_FLICKER', // fullscreen is the interactive orchestrator's own (orchestrator-interactive.cjs sets it after buildEnv); its adapter inherits claude's env, so a worker would otherwise get it
  'CLAUDE_CODE_EFFORT_LEVEL', // ADR 0028 decision 4, probe case E6: the environment outranks --effort
  'BELAY_WORKER_ID', // the worker marker below: a launch never inherits one from up-tree, only buildEnv({ workerId }) sets it
];
// Identity-bind stopgap (ADR 0045 amendment, proposed): every worker's environment names the worker, and the CLI refuses its
// write verbs when it finds the name (src/cli/worker-guard.cjs). It is a marker, not a boundary: a worker can unset it.
// It stops the accident and the casual act of a worker's Bash running `belay memory verify` as the operator.
const WORKER_MARKER = 'BELAY_WORKER_ID';
// `BELAY_FAKE_` is scrubbed too: those variables point a process at a fake core or fake paths, and
// a worker adapter that inherited one from up-tree would load the fake in production. The binary
// overrides (BELAY_CLAUDE_EXE, BELAY_CODEX_EXE) deliberately do inherit — they name a real binary.
const SCRUB_PREFIXES = ['BELAY_FAKE_'];
// ADR 0016: the three variables that name a working directory. `PWD` is replaced with the spawn's
// own cwd rather than inherited; `OLDPWD` and `INIT_CWD` have no correct inherited value at all
// (`INIT_CWD` is npm's record of where a script was started, which is the operator's shell).
const SCRUB_CWD = ['PWD', 'OLDPWD', 'INIT_CWD'];
// build step 6d, ADR 0020 decision 1: a worker never inherits the operator's own MCP_TOOL_TIMEOUT;
// buildEnv sets it explicitly only for a worker launched with permission_prompt.
const SCRUB_ENV_EXTRA = ['MCP_TOOL_TIMEOUT'];

// The child environment is an allowlist: a worker or orchestrator gets what the process needs to run and nothing the operator's
// shell or the lead session happens to hold. Credentials (GH_TOKEN, ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, OPENAI_API_KEY),
// base-URL redirects (ANTHROPIC_BASE_URL), the VS Code git askpass bridge (GIT_ASKPASS, VSCODE_GIT_IPC_HANDLE) and the lead's
// session handles (CLAUDECODE, CLAUDE_PID, CODEX_COMPANION_*) are absent because they are not listed. Belay is subscription-only;
// a billing variable must never reach a launch (the ready gate also refuses an init whose apiKeySource is not "none").
// Names compare case-insensitively (Windows spells `Path` and `SystemRoot` as it likes); the original spelling is kept.
const ALLOW_EXACT = new Set([
  // process and shell basics
  'PATH', 'PATHEXT', 'COMSPEC', 'OS', 'SHELL', 'TERM', 'TERM_PROGRAM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR', 'LANG', 'TZ',
  // Windows system and profile locations
  'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)',
  'COMMONPROGRAMW6432', 'ALLUSERSPROFILE', 'PUBLIC', 'TEMP', 'TMP', 'TMPDIR', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME',
  'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
  // network plumbing: a proxy or a private CA is not a credential
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  // Claude Code and Codex configuration belay relies on (ADR 0024: the config dir the surface gate and the settings copy read)
  'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_GIT_BASH_PATH', 'CODEX_HOME', 'RUST_LOG', 'DISABLE_AUTOUPDATER',
]);
// `BELAY_` carries belay's own settings (BELAY_FAKE_ is scrubbed first); `FAKE_` is the test fakes' knobs, which the test
// processes put in their own environment and the fake executables read.
const ALLOW_PREFIXES = ['BELAY_', 'FAKE_', 'LC_'];
const allowed = (k) => ALLOW_EXACT.has(k.toUpperCase()) || ALLOW_PREFIXES.some((p) => k.startsWith(p));

// Lifted from the R5 prototype (prototypes/run-harness/harness.cjs): the only channel on which a
// Codex MCP failure is observable at all.
const CODEX_RUST_LOG = 'codex_core=debug,codex_rmcp_client=debug,rmcp=info';

// `cwd` is the directory the caller is about to spawn into, and passing it is not optional in
// practice: ADR 0016. `spawn({ cwd })` sets the child's real working directory and leaves `PWD`
// inherited from whatever shell started the parent, and a substrate's file tools compose paths
// against `PWD` rather than against the real cwd. Measured on the context experiment: a background
// agent's `Bash` ran inside the run's own clone while its `Read`/`Edit`/`Write` went to the
// operator's repository, the stale `PWD`. Scrubbing `PWD` is not the fix — a child with no `PWD`
// falls back to the same inherited-looking value from its own shell — so it is *set* to the cwd, and
// the two variables that trail it are dropped. Called without a `cwd` the three are scrubbed, which
// is wrong for a spawn and right for everything else: better a worker with no `PWD` than one holding
// the parent's.
function buildEnv(base, { substrate = 'claude-code', cwd = null, mcpToolTimeoutMs = null, workerId = null } = {}) {
  const src = base || process.env;
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (SCRUB_EXACT.includes(k)) continue;
    if (SCRUB_CWD.includes(k)) continue;
    if (SCRUB_ENV_EXTRA.includes(k)) continue;
    if (SCRUB_PREFIXES.some((p) => k.startsWith(p))) continue;
    if (!allowed(k)) continue;
    out[k] = v;
  }
  if (cwd) out.PWD = fwd(path.resolve(cwd));
  if (typeof workerId === 'string' && workerId) out[WORKER_MARKER] = workerId;
  out.CLAUDE_CODE_PROMPT_CACHE_TTL = '1h';
  // Probe ide-leak: run from a VS Code terminal inside a workspace a
  // ~/.claude/ide lock lists, an interactive claude auto-connects its "ide" MCP server, which the surface gate refuses.
  // The environment variable stops it (P1); `autoConnectIde` in --settings does not (P2). Harmless to a headless launch.
  if (substrate === 'claude-code') out.CLAUDE_CODE_AUTO_CONNECT_IDE = 'false';
  // `--setting-sources=` (ADR 0024 amendment 1) keeps the operator's settings.json `env` from reaching a launch, so a
  // belay-launched claude would self-update mid-run (one did, and left the global claude.exe missing). An explicit
  // value in belay's own environment wins.
  if (substrate === 'claude-code' && src.DISABLE_AUTOUPDATER === undefined) out.DISABLE_AUTOUPDATER = '1';
  // ADR 0001 §8 / WR-5: a crashed Codex MCP server is invisible except in RUST_LOG output, and the
  // R5 prototype set exactly this to make it visible. Without it the wire evidence does not exist.
  if (substrate === 'codex' && !src.RUST_LOG) out.RUST_LOG = CODEX_RUST_LOG;
  // build step 6d, ADR 0020 decision 1: the substrate's own bound must always lie outside the
  // adapter's permit_wait_ms, or a timed-out prompt call is reported to the model as a broken
  // system rather than a clean deny (measured, ADR 0020 §Context). Scrubbed above so a worker never
  // inherits the operator's own value; set here only when this spawn actually asked for one.
  if (typeof mcpToolTimeoutMs === 'number') out.MCP_TOOL_TIMEOUT = String(mcpToolTimeoutMs);
  return out;
}

module.exports = { ALLOW_EXACT, ALLOW_PREFIXES, WORKER_MARKER, SCRUB_EXACT, SCRUB_PREFIXES, SCRUB_CWD, SCRUB_ENV_EXTRA, CODEX_RUST_LOG, buildEnv, fwd };
