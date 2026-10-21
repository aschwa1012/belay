'use strict';
require('../helpers/tmp.cjs'); // every test process gets its own spawn register and tmp cleanup (tests/helpers/tmp.cjs), however it is run
// orchestrator-launch.test.cjs — the fourth launch-table entry (ADR 0009 §1 and its consequences):
// a headless `claude -p` orchestrator with the belay adapter in a strict MCP config, spawned by the
// CLI. Nothing here spawns a real session; these assert the argv, the config and the file placement,
// which is what a launch table is.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const launch = require('../../src/run/launch.cjs');

const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');
const MCP_BIN = `${ROOT}/src/mcp/belay-mcp.cjs`;

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'belay-orch-test-')).split(path.sep).join('/');
}
function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

test('the adapter argv carries role orchestrator and no worker id', () => {
  const args = launch.orchestratorAdapterArgs({ runId: 'run-1', dataDir: '/tmp/dd', mcpPath: MCP_BIN });
  assert.strictEqual(args[0], MCP_BIN);
  assert.ok(args.includes('--role'));
  assert.strictEqual(args[args.indexOf('--role') + 1], 'orchestrator');
  assert.ok(!args.includes('--worker-id'), 'an orchestrator has no worker id; the adapter refuses one');
  assert.strictEqual(args[args.indexOf('--run') + 1], 'run-1');
  assert.ok(args.includes('--data'), 'the data dir is named rather than defaulted silently');
});

test('the mcp config names the belay server and runs it on this node binary', () => {
  const cfg = launch.orchestratorMcpConfig({ runId: 'run-1', dataDir: '/tmp/dd', mcpPath: MCP_BIN });
  assert.deepStrictEqual(Object.keys(cfg.mcpServers), ['belay']);
  assert.strictEqual(cfg.mcpServers.belay.type, 'stdio');
  assert.strictEqual(cfg.mcpServers.belay.command.split('\\').join('/'), process.execPath.split('\\').join('/'));
});

test('orchestrator files are refused inside the data dir (api.md §1 fixes that layout)', () => {
  const dir = sandbox();
  try {
    const dataDir = `${dir}/.belay`;
    fs.mkdirSync(dataDir, { recursive: true });
    assert.throws(
      () => launch.writeOrchestratorFiles({ dir: dataDir, runId: 'r', dataDir, mcpPath: MCP_BIN, settingsPath: null }),
      /must not live inside the data dir/,
      'the data dir layout has no orchestrator entry, so writing one there must be refused'
    );
    assert.throws(
      () => launch.writeOrchestratorFiles({ dir: `${dataDir}/orchestrator`, runId: 'r', dataDir, mcpPath: MCP_BIN, settingsPath: null }),
      /must not live inside the data dir/
    );
  } finally { cleanup(dir); }
});

test('writeOrchestratorFiles writes an mcp.json and a plugin-disabling settings.json outside the data dir', () => {
  const dir = sandbox();
  try {
    const dataDir = `${dir}/.belay`;
    const outDir = `${dir}/orch`;
    const r = launch.writeOrchestratorFiles({ dir: outDir, runId: 'run-7', dataDir, mcpPath: MCP_BIN, settingsPath: null });
    assert.ok(fs.existsSync(r.mcpJsonPath), 'mcp.json written');
    assert.ok(fs.existsSync(r.settingsPath), 'settings.json written');
    assert.ok(!r.mcpJsonPath.startsWith(dataDir), 'and not inside the data dir');

    const cfg = JSON.parse(fs.readFileSync(r.mcpJsonPath, 'utf8'));
    const args = cfg.mcpServers.belay.args;
    assert.strictEqual(args[args.indexOf('--role') + 1], 'orchestrator');
    assert.strictEqual(args[args.indexOf('--run') + 1], 'run-7');

    const settings = JSON.parse(fs.readFileSync(r.settingsPath, 'utf8'));
    assert.ok('enabledPlugins' in settings, 'the orchestrator runs with the host plugins disabled (ADR 0007 §6)');
  } finally { cleanup(dir); }
});

test('the adapter is told the worktree only when the knowledge agent is on; off, its argv is the base one', () => {
  const dir = sandbox();
  try {
    const dataDir = `${dir}/.belay`;
    const wt = `${dir}/wt`;
    const argsOf = (r) => JSON.parse(fs.readFileSync(r.mcpJsonPath, 'utf8')).mcpServers.belay.args;
    const off = argsOf(launch.writeOrchestratorFiles({ dir: `${dir}/off`, runId: 'r', dataDir, mcpPath: MCP_BIN, settingsPath: null, cwd: wt }));
    const plain = argsOf(launch.writeOrchestratorFiles({ dir: `${dir}/plain`, runId: 'r', dataDir, mcpPath: MCP_BIN, settingsPath: null }));
    assert.ok(!off.includes('--worktree'), 'a cwd alone adds nothing');
    assert.deepStrictEqual(off, plain, 'with the lever off the argv equals one written with no cwd at all');
    const on = argsOf(launch.writeOrchestratorFiles({ dir: `${dir}/on`, runId: 'r', dataDir, mcpPath: MCP_BIN, settingsPath: null, cwd: wt, knowledgeAgent: true }));
    assert.strictEqual(on[on.indexOf('--worktree') + 1], wt);
    assert.deepStrictEqual(on.filter((a, i) => a !== '--worktree' && on[i - 1] !== '--worktree'), plain, 'and nothing else changes');
  } finally { cleanup(dir); }
});

test('the launch argv is a headless stream-json session with a strict mcp config', () => {
  const argv = launch.orchestratorLaunchArgv({ mcpJsonPath: '/tmp/orch/mcp.json', settingsPath: '/tmp/orch/settings.json' });
  assert.ok(argv.includes('-p'), 'headless');
  assert.strictEqual(argv[argv.indexOf('--output-format') + 1], 'stream-json',
    'the orchestrator token series is only readable because its stream is owned');
  assert.strictEqual(argv[argv.indexOf('--input-format') + 1], 'stream-json');
  assert.ok(argv.includes('--verbose'), 'stream-json needs --verbose to emit assistant events');
  assert.ok(argv.includes('--strict-mcp-config'), 'the host .mcp.json must not leak in');
  assert.strictEqual(argv[argv.indexOf('--model') + 1], launch.DEFAULT_ORCHESTRATOR_MODEL);
});

test('the orchestrator takes no --name, so it is never listed as one of its own workers', () => {
  const argv = launch.orchestratorLaunchArgv({ mcpJsonPath: '/a/mcp.json', settingsPath: '/a/settings.json' });
  assert.ok(!argv.includes('--name'), 'ADR 0008 §4 filters the registry by the belay- worker prefix');
});

test('--headless on the adapter is refused with the reason, and names where the entry actually is', () => {
  const r = spawnSync(process.execPath, [MCP_BIN, '--role', 'orchestrator', '--run', 'r', '--headless'], {
    encoding: 'utf8', windowsHide: true, timeout: 20000,
  });
  assert.strictEqual(r.status, 2, 'an argv it cannot honour exits 2 rather than starting');
  assert.match(r.stderr, /not a mode of this adapter/);
  assert.match(r.stderr, /orchestratorLaunchArgv/, 'the refusal names the real launch entry');
});
