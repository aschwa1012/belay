'use strict';
require('../helpers/temp-root.cjs').enforceSafeTemp(process.env); // scratch never lands in an indexed folder, even for a bare `node file`
// The launch environment is an allowlist, and a launch whose system/init reports an auth source other than the
// subscription is refused. Fake executables only; nothing here touches a real Claude Code or an API.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const L = require('../../src/run/launch.cjs');
const { verifyClaudeReady } = require('../../src/run/ready.cjs');
const { createParser } = require('../../src/run/parsers.cjs');
const { createRunManager } = require('../../src/run/index.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');
const G = require('../helpers/proc-gone.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');
const fwd = (p) => String(p).replace(/\\/g, '/');

const SECRETS = {
  GH_TOKEN: 'synthetic-gh', GITHUB_TOKEN: 'synthetic-gh2', ANTHROPIC_API_KEY: 'synthetic-key', ANTHROPIC_AUTH_TOKEN: 'synthetic-tok',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', OPENAI_API_KEY: 'synthetic-oai', CLAUDE_CODE_USE_BEDROCK: '1', AWS_SECRET_ACCESS_KEY: 'synthetic-aws',
  VSCODE_GIT_IPC_HANDLE: '\\\\.\\pipe\\vscode-git-synthetic', GIT_ASKPASS: 'C:/vscode/askpass.sh', VSCODE_GIT_ASKPASS_MAIN: 'x',
  CLAUDECODE: '1', CLAUDE_PID: '123', CODEX_COMPANION_SESSION_ID: 'x', CLAUDE_CODE_ENTRYPOINT: 'cli',
};
const REQUIRED = {
  PATH: 'C:/bin', SystemRoot: 'C:/Windows', USERPROFILE: 'C:/home/x', APPDATA: 'C:/home/x/AppData/Roaming',
  LOCALAPPDATA: 'C:/home/x/AppData/Local', TEMP: 'C:/t', TMP: 'C:/t', HOME: 'C:/home/x', COMSPEC: 'C:/Windows/cmd.exe', PATHEXT: '.EXE',
  BELAY_CLAUDE_EXE: 'D:/claude.exe', BELAY_CODEX_EXE: 'D:/codex.exe', CLAUDE_CONFIG_DIR: 'C:/cfg', CODEX_HOME: 'C:/codex',
  HTTPS_PROXY: 'http://proxy:3128', FAKE_PERMISSION_MODE: 'default',
};

test('buildEnv drops credentials, billing and redirect variables, the askpass bridge and lead-session handles, for both substrates', () => {
  for (const substrate of ['claude-code', 'codex']) {
    const env = L.buildEnv({ ...REQUIRED, ...SECRETS }, { substrate });
    for (const k of Object.keys(SECRETS)) assert.ok(!(k in env), `${k} must not reach a ${substrate} launch`);
  }
});

test('buildEnv hands the ssh agent socket to an orchestrator and to no worker', () => {
  for (const substrate of ['claude-code', 'codex']) {
    const base = { PATH: 'x', SSH_AUTH_SOCK: '/s' };
    assert.ok(!('SSH_AUTH_SOCK' in L.buildEnv(base, { substrate, workerId: 'w1' })), `${substrate} worker`);
    assert.equal(L.buildEnv(base, { substrate, orchestrator: true }).SSH_AUTH_SOCK, '/s', `${substrate} orchestrator keeps it`);
  }
});

test('buildEnv keeps what a launch needs, under the spelling it came in', () => {
  const env = L.buildEnv({ ...REQUIRED, ...SECRETS }, { substrate: 'claude-code', cwd: 'C:/wt' });
  for (const [k, v] of Object.entries(REQUIRED)) assert.equal(env[k], v, `${k} must still be present`);
  assert.equal(env.PWD, 'C:/wt');
  assert.equal(env.CLAUDE_CODE_AUTO_CONNECT_IDE, 'false');
  assert.equal(env.DISABLE_AUTOUPDATER, '1');
  const lower = L.buildEnv({ Path: 'C:/bin', ANTHROPIC_API_KEY: 'k', anthropic_auth_token: 't' });
  assert.equal(lower.Path, 'C:/bin', 'a Windows spelling of PATH is matched case-insensitively');
  assert.ok(!('anthropic_auth_token' in lower));
});

test('buildEnv still scrubs CLAUDE_CODE_EFFORT_LEVEL and BELAY_FAKE_ (the allowlisted prefixes do not undo them)', () => {
  const env = L.buildEnv({ PATH: 'x', CLAUDE_CODE_EFFORT_LEVEL: 'low', BELAY_FAKE_CORE: 'c', BELAY_WORKER_ID: 'old', BELAY_CLAUDE_EXE: 'e' });
  assert.ok(!('CLAUDE_CODE_EFFORT_LEVEL' in env));
  assert.ok(!('BELAY_FAKE_CORE' in env));
  assert.ok(!('BELAY_WORKER_ID' in env));
  assert.equal(env.BELAY_CLAUDE_EXE, 'e');
});

test('buildEnv keeps the PowerShell and git plumbing and the subscription OAuth token, drops the ssh key agent socket for a worker, and turns git prompts off', () => {
  const env = L.buildEnv({
    PATH: 'x', PSModulePath: 'C:/ps', PSExecutionPolicyPreference: 'Bypass', SSH_AUTH_SOCK: '/s', GIT_CONFIG_GLOBAL: 'C:/g', CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-sub',
    GIT_TERMINAL_PROMPT: '1', GCM_INTERACTIVE: 'always',
  });
  assert.equal(env.PSModulePath, 'C:/ps');
  assert.equal(env.PSExecutionPolicyPreference, 'Bypass');
  assert.ok(!('SSH_AUTH_SOCK' in env), 'a worker gets no key agent');
  for (const substrate of ['claude-code', 'codex']) {
    assert.ok(!('SSH_AUTH_SOCK' in L.buildEnv({ PATH: 'x', SSH_AUTH_SOCK: '/s' }, { substrate })), substrate);
  }
  assert.equal(env.GIT_CONFIG_GLOBAL, 'C:/g');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'synthetic-sub', 'a subscription credential is kept on purpose');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GCM_INTERACTIVE, 'never');
});

test('the Claude Code OAuth token reaches a Claude Code launch only, never a Codex one', () => {
  const base = { PATH: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-sub' };
  assert.equal(L.buildEnv(base, { substrate: 'claude-code' }).CLAUDE_CODE_OAUTH_TOKEN, 'synthetic-sub');
  assert.ok(!('CLAUDE_CODE_OAUTH_TOKEN' in L.buildEnv(base, { substrate: 'codex' })), 'a Codex worker gets no Claude credential');
});

test('BELAY_ENV_ALLOW refuses a name ending in _KEY, as it does _TOKEN and _SECRET', () => {
  assert.throws(() => L.buildEnv({ PATH: 'x', AWS_SECRET_ACCESS_KEY: 's', BELAY_ENV_ALLOW: 'AWS_SECRET_ACCESS_KEY,JAVA_HOME' }),
    (e) => e.code === 'E_ARGS' && /AWS_SECRET_ACCESS_KEY/.test(e.message));
  assert.equal(L.buildEnv({ PATH: 'x', JAVA_HOME: 'C:/jdk', BELAY_ENV_ALLOW: 'JAVA_HOME' }).JAVA_HOME, 'C:/jdk');
});

test('WT_SESSION and TERM_PROGRAM_VERSION reach an interactive launch only', () => {
  const base = { PATH: 'x', WT_SESSION: 'w', TERM_PROGRAM_VERSION: '1.2' };
  assert.ok(!('WT_SESSION' in L.buildEnv(base)));
  assert.ok(!('TERM_PROGRAM_VERSION' in L.buildEnv(base, { workerId: 'w1' })));
  const env = L.buildEnv(base, { interactive: true });
  assert.equal(env.WT_SESSION, 'w');
  assert.equal(env.TERM_PROGRAM_VERSION, '1.2');
});

test('BELAY_ENV_ALLOW passes the named variables and refuses billing, credential and redirect names loudly', () => {
  const env = L.buildEnv({ PATH: 'x', JAVA_HOME: 'C:/jdk', virtual_env: 'C:/v', GOPATH: 'C:/go', BELAY_ENV_ALLOW: 'JAVA_HOME, VIRTUAL_ENV' });
  assert.equal(env.JAVA_HOME, 'C:/jdk');
  assert.equal(env.virtual_env, 'C:/v', 'matched case-insensitively');
  assert.ok(!('GOPATH' in env), 'only the named variables are added');
  for (const bad of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'MY_API_KEY', 'GH_TOKEN', 'SOME_TOKEN', 'X_BASE_URL', 'ANTHROPIC_FOO', 'VSCODE_GIT_IPC_HANDLE']) {
    assert.throws(() => L.buildEnv({ PATH: 'x', [bad]: 'v', BELAY_ENV_ALLOW: `JAVA_HOME,${bad}` }), (e) => e.code === 'E_ARGS' && e.message.includes(bad), bad);
  }
});

test('verifyClaudeReady refuses an init with no apiKeySource (fail closed)', () => {
  const r = verifyClaudeReady({ id: 'w' }, { claude_code_version: '2.1.290', mcp_servers: [{ name: 'belay', status: 'connected' }] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no apiKeySource/);
});

test('the Claude Code ready event carries the init apiKeySource', () => {
  const p = createParser('claude-code');
  const [ev] = p.pushLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', apiKeySource: 'ANTHROPIC_API_KEY', mcp_servers: [] }));
  assert.equal(ev.kind, 'ready');
  assert.equal(ev.api_key_source, 'ANTHROPIC_API_KEY');
  const [none] = createParser('claude-code').pushLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's2', mcp_servers: [] }));
  assert.equal(none.api_key_source, null);
});

test('verifyClaudeReady refuses any apiKeySource but "none", naming it, before the MCP and surface checks', () => {
  for (const source of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'apiKeyHelper', 'oauth']) {
    const r = verifyClaudeReady({ id: 'w' }, { api_key_source: source, claude_code_version: '2.1.290', mcp_servers: [{ name: 'belay', status: 'connected' }] });
    assert.equal(r.ok, false);
    assert.ok(r.reason.includes(`"${source}"`), r.reason);
    assert.match(r.reason, /subscription/);
  }
  const ok = verifyClaudeReady({ id: 'w' }, { api_key_source: 'none', claude_code_version: '2.1.290', mcp_servers: [] });
  assert.ok(!/apiKeySource/.test(ok.reason || ''), 'the subscription value passes this gate and fails only on what follows it');
});

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-env-allow-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { data: fwd(d), worktree: fwd(path.join(d, 'wt')) };
}
function mgr(sb, core) {
  return createRunManager({
    core, dataDir: sb.data, runId: 'run-env',
    paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') },
  });
}

test('spawn: an init reporting apiKeySource ANTHROPIC_API_KEY fails E_NO_READY naming it, the worker is dead and its pid gone', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  process.env.FAKE_API_KEY_SOURCE = 'ANTHROPIC_API_KEY';
  try {
    let pid = null;
    await assert.rejects(
      () => m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: 'w-key' }),
      (e) => {
        assert.equal(e.code, 'E_NO_READY');
        assert.match(e.detail.reason, /ANTHROPIC_API_KEY/);
        pid = e.detail.pid;
        return true;
      }
    );
    assert.ok(Number.isInteger(pid) && pid > 0);
    // Gone by identity (ADR 0039): the row's recorded creation time, so a reused pid number is not read as the worker.
    const created = core.rowsFor('w-key').map((r) => r.pid_created).filter((c) => c != null).pop();
    assert.ok(await G.waitGone(G.recorded(pid, created), { deadlineMs: 10000 }), 'a worker refused at the gate is killed, not left behind');
    const states = core.rowsFor('w-key').map((r) => r.state);
    assert.equal(states[states.length - 1], 'dead');
  } finally {
    delete process.env.FAKE_API_KEY_SOURCE;
    await m.shutdown();
    cleanup(sb.data);
  }
});

test('spawn: an init reporting the subscription (none) still starts a worker', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  try {
    const row = await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: 'w-sub' });
    assert.equal(row.state, 'running');
  } finally {
    await m.shutdown();
    cleanup(sb.data);
  }
});
