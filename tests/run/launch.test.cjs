'use strict';
require('../helpers/tmp.cjs'); // every test process gets its own spawn register and tmp cleanup (tests/helpers/tmp.cjs), however it is run
// Golden argv for the three launch-table entries (ADR 0001 §1, ADR 0008 §6), the per-worker files
// (ADR 0007 §6) and the environment scrub. Nothing here spawns a substrate; the one spawn is a bare
// `node -e` that reports its own PWD, which is the receipt for ADR 0016.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const L = require('../../src/run/launch.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'belay-run-launch-'));

test('the binary paths come from the environment override, and are not hard-coded', () => {
  const savedC = process.env.BELAY_CLAUDE_EXE;
  const savedX = process.env.BELAY_CODEX_EXE;
  process.env.BELAY_CLAUDE_EXE = 'D:/elsewhere/claude.exe';
  process.env.BELAY_CODEX_EXE = 'D:/elsewhere/codex.exe';
  assert.equal(L.claudeExe(), 'D:/elsewhere/claude.exe');
  assert.equal(L.codexExe(), 'D:/elsewhere/codex.exe');
  if (savedC === undefined) delete process.env.BELAY_CLAUDE_EXE;
  else process.env.BELAY_CLAUDE_EXE = savedC;
  if (savedX === undefined) delete process.env.BELAY_CODEX_EXE;
  else process.env.BELAY_CODEX_EXE = savedX;
});

test('resolveExe runs a .cjs substrate under this node binary and passes anything else through', () => {
  const r = L.resolveExe('C:/x/fake.cjs');
  assert.equal(r.command, L.fwd(process.execPath));
  assert.deepEqual(r.prefixArgs, ['C:/x/fake.cjs']);
  const d = L.resolveExe('C:/x/claude.exe');
  assert.equal(d.command, 'C:/x/claude.exe');
  assert.deepEqual(d.prefixArgs, []);
});

test('Claude Code launch argv is the ADR 0001 §1 table, always strict', () => {
  const argv = L.claudeLaunchArgv({
    workerId: 'w1', mcpJsonPath: 'C:/d/workers/w1/mcp.json', settingsPath: 'C:/d/workers/w1/settings.json',
  });
  assert.deepEqual(argv, [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--name', 'belay-w1', '--model', 'claude-sonnet-5-5',
    '--strict-mcp-config', '--mcp-config', 'C:/d/workers/w1/mcp.json',
    '--settings', 'C:/d/workers/w1/settings.json',
    // ADR 0024 decisions 1 and 3: the positive tool list and the restricted setting sources, on
    // every launch, right after --settings.
    '--tools', 'Read,Edit,Write,Glob,Grep,Bash', '--setting-sources=',
    '--allowedTools', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'mcp__belay',
    '--permission-mode', 'auto',
  ]);
  assert.ok(argv.includes('--strict-mcp-config'), 'workers are never launched non-strict (ADR 0001 §8)');
});

test('Claude Code resume appends --resume and keeps everything else', () => {
  const argv = L.claudeLaunchArgv({ workerId: 'w1', mcpJsonPath: 'm', settingsPath: 's', resumeSessionId: 'sess-1' });
  assert.deepEqual(argv.slice(-2), ['--resume', 'sess-1']);
  assert.ok(argv.includes('--strict-mcp-config'));
});

test('Codex launch argv carries -C, -s and the four -c overrides, with the prompt last', () => {
  const adapterArgs = ['C:/b/src/mcp/belay-mcp.cjs', '--role', 'worker', '--worker-id', 'w2', '--run', 'r1', '--data', 'C:/d'];
  const argv = L.codexLaunchArgv({ worktree: 'C:/wt', adapterArgs, prompt: 'do the thing' });
  assert.deepEqual(argv.slice(0, 7), ['exec', '--json', '-C', 'C:/wt', '--skip-git-repo-check', '-s', 'workspace-write']);
  assert.equal(argv[argv.length - 1], 'do the thing');
  assert.ok(argv.includes('approval_policy="never"'));
  assert.ok(argv.some((a) => a === 'mcp_servers.belay.default_tools_approval_mode="approve"'), 'WR-5: tools must be pre-approved');
  assert.ok(argv.some((a) => a.startsWith('mcp_servers.belay.args=')));
});

test('Codex resume argv has no -C and no -s (ADR 0008 §6)', () => {
  const adapterArgs = ['C:/b/src/mcp/belay-mcp.cjs', '--role', 'worker', '--worker-id', 'w2', '--run', 'r1', '--data', 'C:/d'];
  const argv = L.codexResumeArgv({ threadId: 'thread-9', adapterArgs, prompt: 'next' });
  assert.deepEqual(argv.slice(0, 5), ['exec', 'resume', 'thread-9', '--json', '--skip-git-repo-check']);
  assert.ok(!argv.includes('-C'), 'exec resume rejects -C at the parse layer in ~76 ms');
  assert.ok(!argv.includes('--cd'));
  assert.ok(!argv.includes('-s'));
  assert.ok(!argv.includes('--sandbox'));
  assert.equal(argv[argv.length - 1], 'next');
  // The MCP configuration is resupplied on every resume; the adapter is relaunched, not reused.
  assert.ok(argv.some((a) => a.startsWith('mcp_servers.belay.command=')));
  assert.ok(argv.some((a) => a === 'mcp_servers.belay.default_tools_approval_mode="approve"'));
});

test('the environment is scrubbed and the 1 h prompt-cache TTL is set (ADR 0007 §6, ADR 0001 §7)', () => {
  const base = {
    PATH: 'x', BELAY_FAKE_V3_ENABLED: 'true', BELAY_FAKE_HOOKS_ENABLED: 'true',
    CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_BRIDGE_SESSION_ID: '2', CLAUDE_CODE_MESSAGING_SOCKET: '3',
    CLAUDE_CODE_MESSAGING_TOKEN: '4', CLAUDE_CODE_SESSION_ID: '5', CLAUDE_CODE_SSE_PORT: '6',
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1', CLAUDE_CODE_PROMPT_CACHE_TTL: '5m',
  };
  const env = L.buildEnv(base);
  assert.equal(env.PATH, 'x');
  assert.equal(env.CLAUDE_CODE_PROMPT_CACHE_TTL, '1h');
  for (const k of L.SCRUB_EXACT) assert.ok(!(k in env), k + ' must be scrubbed');
  for (const k of Object.keys(base)) if (k.startsWith('BELAY_FAKE_')) assert.ok(!(k in env), k + ' must be scrubbed');
  assert.equal(env.RUST_LOG, undefined, 'a Claude Code worker needs no Codex wire logging');
});

test('BELAY_FAKE_ is scrubbed and the two binary overrides are not', () => {
  // A BELAY_FAKE_* variable points a process at a fake core or a fake path. A worker adapter that
  // inherited one from up-tree would load the fake in production, so the prefix is scrubbed. The
  // binary overrides name a real binary and are inherited on purpose.
  const env = L.buildEnv({
    BELAY_FAKE_CORE: 'C:/t/fake-core.cjs', BELAY_FAKE_DATA: 'C:/t/data',
    BELAY_CLAUDE_EXE: 'D:/elsewhere/claude.exe', BELAY_CODEX_EXE: 'D:/elsewhere/codex.exe',
  });
  assert.deepEqual(L.SCRUB_PREFIXES, ['BELAY_FAKE_']);
  assert.equal('BELAY_FAKE_CORE' in env, false);
  assert.equal('BELAY_FAKE_DATA' in env, false);
  assert.equal(env.BELAY_CLAUDE_EXE, 'D:/elsewhere/claude.exe');
  assert.equal(env.BELAY_CODEX_EXE, 'D:/elsewhere/codex.exe');
});

// ---------------------------------------------------------------- ADR 0016: PWD

test('PWD is set to the spawn cwd, and OLDPWD and INIT_CWD are dropped', () => {
  // The defect ADR 0016 fixes: `spawn({ cwd })` sets the real working directory and leaves `PWD`
  // pointing wherever the parent's shell was. A substrate's file tools follow `PWD`.
  const base = {
    PATH: 'x',
    PWD: 'C:/Home/someone/Projects/belay',
    OLDPWD: 'C:/Home/someone',
    INIT_CWD: 'C:/Home/someone/Projects/belay',
  };
  const env = L.buildEnv(base, { cwd: 'C:/tmp/run-1/clone' });
  assert.equal(env.PWD, 'C:/tmp/run-1/clone', 'PWD must name the directory being spawned into');
  assert.equal('OLDPWD' in env, false, 'OLDPWD has no correct inherited value');
  assert.equal('INIT_CWD' in env, false, 'INIT_CWD is npm-era state naming the operator shell');
  assert.equal(env.PATH, 'x', 'nothing else is touched');
});

test('without a cwd the three are scrubbed rather than inherited', () => {
  // Better a worker with no PWD than one holding the parent's: an absent variable makes a tool fall
  // back to the real cwd, a wrong one sends it somewhere else entirely.
  const env = L.buildEnv({ PATH: 'x', PWD: 'C:/wrong', OLDPWD: 'C:/w', INIT_CWD: 'C:/w' });
  for (const k of L.SCRUB_CWD) assert.equal(k in env, false, k + ' must not be inherited');
});

test('a real child sees the corrected PWD, not the one this process holds', () => {
  // The receipt, not the intention: a process spawned through the built environment is asked what
  // its own PWD is. Without the fix it answers with this test runner's directory.
  const cwd = L.fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-pwd-')));
  const stale = 'C:/Home/someone/Projects/belay';
  const env = L.buildEnv({ ...process.env, PWD: stale }, { cwd });
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.env.PWD))'], {
    cwd, env, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(r.status, 0);
  assert.equal(L.fwd(r.stdout.trim()), cwd, 'the child must see the directory it was spawned into');
  assert.notEqual(L.fwd(r.stdout.trim()), stale);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('a Codex worker gets RUST_LOG, the only channel an MCP failure shows on (WR-5)', () => {
  const env = L.buildEnv({ PATH: 'x' }, { substrate: 'codex' });
  assert.equal(env.RUST_LOG, L.CODEX_RUST_LOG);
  // An operator who set their own RUST_LOG keeps it.
  assert.equal(L.buildEnv({ RUST_LOG: 'trace' }, { substrate: 'codex' }).RUST_LOG, 'trace');
});

test('the per-worker mcp.json names the server belay and puts identity in the adapter argv', () => {
  const cfg = L.mcpConfig({ workerId: 'w3', runId: 'run-7', dataDir: 'C:/d', mcpPath: 'C:/b/src/mcp/belay-mcp.cjs' });
  assert.deepEqual(Object.keys(cfg.mcpServers), ['belay']);
  const s = cfg.mcpServers.belay;
  assert.equal(s.type, 'stdio');
  assert.equal(s.command, L.fwd(process.execPath));
  // Contract §1: `--role worker --worker-id <id> --run <run> --data <dir>`; `--log` only when the
  // caller passes a logPath (build 12 A1: the run manager always does).
  assert.deepEqual(s.args, [
    'C:/b/src/mcp/belay-mcp.cjs', '--role', 'worker', '--worker-id', 'w3', '--run', 'run-7', '--data', L.fwd(path.resolve('C:/d')),
  ]);
  assert.ok(!s.args.includes('--log'));
});

test('a worker mcp.json carries --log only when the caller names one, and the argv hash does not move', () => {
  const base = { workerId: 'w3', runId: 'run-7', dataDir: 'C:/d', mcpPath: 'C:/b/m.cjs' };
  const withLog = L.mcpConfig({ ...base, logPath: 'C:/d/workers/w3/adapter.log' }).mcpServers.belay.args;
  assert.deepEqual(withLog.slice(-2), ['--log', 'C:/d/workers/w3/adapter.log']);
  assert.deepEqual(withLog.slice(0, -2), L.mcpConfig(base).mcpServers.belay.args, 'the identity argv is untouched');
  // The substrate's own argv names mcp.json by path, so the hash adopt and restart compare cannot see the log.
  const spec = (p) => ({ exe: 'c', cwd: 'w', args: L.claudeLaunchArgv({ workerId: 'w3', mcpJsonPath: p, settingsPath: 'C:/d/workers/w3/settings.json', model: 'm', allowedTools: ['Read'] }) });
  assert.equal(L.argvHash(spec('C:/d/workers/w3/mcp.json')), L.argvHash(spec('C:/d/workers/w3/mcp.json')));
  const dir = tmp();
  const wdir = path.join(dir, 'workers', 'w3');
  const r = L.writeWorkerFiles({ dir: wdir, ...base, dataDir: dir, logPath: L.wireLogPath(wdir) });
  const written = JSON.parse(fs.readFileSync(r.mcpJsonPath, 'utf8')).mcpServers.belay.args;
  assert.equal(written[written.indexOf('--log') + 1], L.fwd(path.join(wdir, 'adapter.log')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the Codex adapter argv carries --log, the only ADR 0001 §8 evidence that substrate has', () => {
  const dir = L.workerDir('C:/d', 'w5');
  const logPath = L.wireLogPath(dir);
  assert.equal(logPath, 'C:/d/workers/w5/adapter.log', 'the log sits beside the worker (contract §1 layout)');
  const args = L.workerAdapterArgs({ workerId: 'w5', runId: 'run-7', dataDir: 'C:/d', mcpPath: 'C:/b/m.cjs', logPath });
  assert.deepEqual(args, [
    'C:/b/m.cjs', '--role', 'worker', '--worker-id', 'w5', '--run', 'run-7', '--data', L.fwd(path.resolve('C:/d')),
    '--log', 'C:/d/workers/w5/adapter.log',
  ]);
  // And it is what the Codex `-c mcp_servers.belay.args=` override carries, verbatim.
  const argv = L.codexLaunchArgv({ worktree: 'C:/wt', adapterArgs: args, prompt: 'go' });
  const toml = argv.find((a) => a.startsWith('mcp_servers.belay.args='));
  assert.deepEqual(JSON.parse(toml.slice('mcp_servers.belay.args='.length)), args);
});

test('the wire-log predicate reads only the bytes a launch added', () => {
  const dir = tmp();
  const log = path.join(dir, 'adapter.log');
  fs.writeFileSync(log, JSON.stringify({ at: 1, method: 'initialize' }) + '\n');
  assert.equal(L.wireLogHasToolsList(log).seen, false, 'initialize is not tools/list');
  const afterFirst = fs.statSync(log).size;
  fs.appendFileSync(log, JSON.stringify({ at: 2, method: 'tools/list', id: 1 }) + '\n');
  assert.equal(L.wireLogHasToolsList(log).seen, true);
  assert.equal(L.wireLogHasToolsList(log, afterFirst).seen, true, 'the new bytes carry it');
  // A previous launch's tools/list must not pass this launch's check.
  assert.equal(L.wireLogHasToolsList(log, fs.statSync(log).size).seen, false);
  // A log that was never created is a reason, not a throw.
  const missing = L.wireLogHasToolsList(path.join(dir, 'nope.log'));
  assert.equal(missing.seen, false);
  assert.match(missing.reason, /could not be read/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the worker settings file disables every plugin named in the user settings, read at launch time', () => {
  const dir = tmp();
  const userSettings = path.join(dir, 'user-settings.json');
  fs.writeFileSync(userSettings, JSON.stringify({ enabledPlugins: { 'example-plugin@example': true, 'codex@openai-codex': true } }));
  assert.deepEqual(L.readEnabledPluginNames(userSettings), ['example-plugin@example', 'codex@openai-codex']);
  assert.deepEqual(L.workerSettings(L.readEnabledPluginNames(userSettings)), {
    enabledPlugins: { 'example-plugin@example': false, 'codex@openai-codex': false },
  });
  // A missing or unreadable user settings file yields no plugins rather than throwing.
  assert.deepEqual(L.readEnabledPluginNames(path.join(dir, 'nope.json')), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeWorkerFiles puts mcp.json and settings.json beside the worker', () => {
  const dir = tmp();
  const userSettings = path.join(dir, 'user-settings.json');
  fs.writeFileSync(userSettings, JSON.stringify({ enabledPlugins: { 'p@m': true } }));
  const wdir = path.join(dir, 'workers', 'w4');
  const r = L.writeWorkerFiles({ dir: wdir, workerId: 'w4', runId: 'run-1', dataDir: dir, settingsPath: userSettings });
  assert.deepEqual(JSON.parse(fs.readFileSync(r.settingsPath, 'utf8')), { enabledPlugins: { 'p@m': false } });
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(r.mcpJsonPath, 'utf8')).mcpServers)[0], 'belay');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('argv.json is written beside the worker and argv_hash is recomputable from it', () => {
  const dir = tmp();
  const spec = { exe: 'C:/x/claude.exe', args: ['-p', '--verbose'], cwd: 'C:/wt' };
  const h = L.writeArgvJson(dir, spec);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'argv.json'), 'utf8'));
  assert.equal(onDisk.argv_hash, h);
  assert.equal(L.argvHash(onDisk.spec), h);
  assert.match(h, /^[0-9a-f]{64}$/);
  // A different argv is a different hash.
  assert.notEqual(L.argvHash({ ...spec, args: ['-p'] }), h);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- ADR 0028 (S6b): a worker's effort is a spawn argument, on every launch

test('launch: effort adds --effort <level> to a fresh and a resume argv', () => {
  assert.deepEqual(L.EFFORT_LEVELS, ['low', 'medium', 'high', 'xhigh', 'max']);
  const fresh = L.claudeLaunchArgv({ workerId: 'w1', mcpJsonPath: 'm', settingsPath: 's', effort: 'low' });
  const at = fresh.indexOf('--permission-mode');
  assert.deepEqual(fresh.slice(at, at + 4), ['--permission-mode', 'auto', '--effort', 'low']);
  const resumed = L.claudeLaunchArgv({ workerId: 'w1', mcpJsonPath: 'm', settingsPath: 's', effort: 'xhigh', resumeSessionId: 'sess-1' });
  assert.equal(resumed[resumed.indexOf('--effort') + 1], 'xhigh', 'a resume carries the level (probe cases E1r and E1rh)');
  assert.deepEqual(resumed.slice(-2), ['--resume', 'sess-1']);
});

test('launch: no effort adds no --effort', () => {
  for (const opts of [{}, { effort: null }, { resumeSessionId: 'sess-1' }]) {
    const argv = L.claudeLaunchArgv({ workerId: 'w1', mcpJsonPath: 'm', settingsPath: 's', ...opts });
    assert.ok(!argv.includes('--effort'), JSON.stringify(opts));
  }
  assert.ok(!L.orchestratorLaunchArgv({ mcpJsonPath: 'm', settingsPath: 's' }).includes('--effort'));
});

test('launch: buildEnv drops CLAUDE_CODE_EFFORT_LEVEL', () => {
  for (const substrate of ['claude-code', 'codex']) {
    const env = L.buildEnv({ PATH: 'x', CLAUDE_CODE_EFFORT_LEVEL: 'low' }, { substrate });
    assert.ok(!('CLAUDE_CODE_EFFORT_LEVEL' in env), 'the operator shell must not outrank --effort (ADR 0028 decision 4, case E6)');
    assert.equal(env.PATH, 'x');
  }
});

test('launch: the orchestrator argv carries --effort when asked', () => {
  const argv = L.orchestratorLaunchArgv({ mcpJsonPath: 'm', settingsPath: 's', effort: 'high' });
  assert.equal(argv[argv.indexOf('--effort') + 1], 'high');
  const resumed = L.orchestratorLaunchArgv({ mcpJsonPath: 'm', settingsPath: 's', effort: 'max', resumeSessionId: 'sess-2' });
  assert.equal(resumed[resumed.indexOf('--effort') + 1], 'max');
  assert.deepEqual(resumed.slice(-2), ['--resume', 'sess-2']);
});

test('launch: the default orchestrator model is claude-opus-5-5', () => {
  assert.strictEqual(L.DEFAULT_ORCHESTRATOR_MODEL, 'claude-opus-5-5');
  const argv = L.orchestratorLaunchArgv({ mcpJsonPath: '/a/mcp.json', settingsPath: '/a/settings.json' });
  assert.strictEqual(argv[argv.indexOf('--model') + 1], 'claude-opus-5-5');
});

test('a Claude Code launch turns off IDE auto-connect, even when the parent set it, and a Codex one is left alone (probe ide-leak P1)', () => {
  const vscode = { TERM_PROGRAM: 'vscode', VSCODE_GIT_IPC_HANDLE: 'x', CLAUDE_CODE_AUTO_CONNECT_IDE: 'true' };
  assert.equal(L.buildEnv(vscode).CLAUDE_CODE_AUTO_CONNECT_IDE, 'false');
  assert.equal(L.buildEnv(vscode, { substrate: 'claude-code' }).CLAUDE_CODE_AUTO_CONNECT_IDE, 'false');
  assert.equal(L.buildEnv({ PATH: 'x' }, { substrate: 'codex' }).CLAUDE_CODE_AUTO_CONNECT_IDE, undefined);
  assert.equal(L.buildEnv(vscode).TERM_PROGRAM, 'vscode', 'the terminal identity is not scrubbed');
});

test('a Claude Code launch sets DISABLE_AUTOUPDATER=1 unless the parent set it; a Codex launch is left alone', () => {
  assert.equal(L.buildEnv({ PATH: 'x' }).DISABLE_AUTOUPDATER, '1');
  assert.equal(L.buildEnv({ PATH: 'x' }, { substrate: 'claude-code' }).DISABLE_AUTOUPDATER, '1');
  assert.equal(L.buildEnv({ DISABLE_AUTOUPDATER: '0' }).DISABLE_AUTOUPDATER, '0', 'an explicit value wins');
  assert.equal(L.buildEnv({ PATH: 'x' }, { substrate: 'codex' }).DISABLE_AUTOUPDATER, undefined);
});

test('CLAUDE_CODE_NO_FLICKER is scrubbed from every launch env: the orchestrator sets its own, and a worker adapter inherits claude\'s', () => {
  assert.ok(!('CLAUDE_CODE_NO_FLICKER' in L.buildEnv({ PATH: 'x', CLAUDE_CODE_NO_FLICKER: '1' })));
  assert.ok(!('CLAUDE_CODE_NO_FLICKER' in L.buildEnv({ CLAUDE_CODE_NO_FLICKER: '1' }, { substrate: 'codex' })));
});
