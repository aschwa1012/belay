'use strict';
// permit-launch.test.cjs — build step 6d, design item 4,
// ADR 0020 decision 1. Golden argv for the launch table's own opt-in flags (the shape of
// tests/run/launch.test.cjs), then the run manager's own spawn/restart plumbing over the fake core
// and the fake Claude substrate (the shape of tests/run/manager.test.cjs).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const L = require('../../src/run/launch.cjs');
const { createRunManager } = require('../../src/run/index.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, timeoutMs, stepMs = 100) {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 >= timeoutMs) return null;
    await sleep(stepMs);
  }
}

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-permit-launch-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { data: d.replace(/\\/g, '/'), worktree: path.join(d, 'wt').replace(/\\/g, '/') };
}

function mgr(sb, core) {
  return createRunManager({
    core, dataDir: sb.data, runId: 'run-test',
    paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') },
  });
}

async function teardown(m, sb) { await m.shutdown(); cleanup(sb.data); }

// ================================================================ (o) golden argv

test('launch: permissionPromptTool appends the prompt-tool pair after the permission mode, workerAdapterArgs appends --permit and --permit-wait-ms, and buildEnv sets MCP_TOOL_TIMEOUT only when asked and scrubs an inherited one', () => {
  const withoutFlag = L.claudeLaunchArgv({ workerId: 'w1', mcpJsonPath: 'm', settingsPath: 's' });
  assert.ok(!withoutFlag.includes('--permission-prompt-tool'));

  const withFlag = L.claudeLaunchArgv({ workerId: 'w1', mcpJsonPath: 'm', settingsPath: 's', permissionPromptTool: true });
  const modeIdx = withFlag.indexOf('--permission-mode');
  assert.deepStrictEqual(withFlag.slice(modeIdx, modeIdx + 4), ['--permission-mode', 'auto', '--permission-prompt-tool', 'mcp__belay__permit']);

  const withResume = L.claudeLaunchArgv({ workerId: 'w1', mcpJsonPath: 'm', settingsPath: 's', permissionPromptTool: true, resumeSessionId: 'sess-1' });
  assert.deepStrictEqual(withResume.slice(-4), ['--permission-prompt-tool', 'mcp__belay__permit', '--resume', 'sess-1']);

  const argsWithoutPermit = L.workerAdapterArgs({ workerId: 'w1', runId: 'r1', dataDir: 'C:/d', mcpPath: 'C:/b/belay-mcp.cjs' });
  assert.ok(!argsWithoutPermit.includes('--permit'));

  const argsWithPermit = L.workerAdapterArgs({ workerId: 'w1', runId: 'r1', dataDir: 'C:/d', mcpPath: 'C:/b/belay-mcp.cjs', permit: true, permitWaitMs: 12345 });
  const dataIdx = argsWithPermit.indexOf('--data');
  assert.deepStrictEqual(argsWithPermit.slice(dataIdx, dataIdx + 5), ['--data', 'C:/d', '--permit', '--permit-wait-ms', '12345']);

  const argsPermitNoWaitMs = L.workerAdapterArgs({ workerId: 'w1', runId: 'r1', dataDir: 'C:/d', mcpPath: 'C:/b/belay-mcp.cjs', permit: true });
  assert.ok(argsPermitNoWaitMs.includes('--permit'));
  assert.ok(!argsPermitNoWaitMs.includes('--permit-wait-ms'));

  const envAsked = L.buildEnv({ PATH: 'x' }, { mcpToolTimeoutMs: 60000 });
  assert.strictEqual(envAsked.MCP_TOOL_TIMEOUT, '60000');

  const envUnasked = L.buildEnv({ PATH: 'x' });
  assert.strictEqual('MCP_TOOL_TIMEOUT' in envUnasked, false);

  const envScrubbed = L.buildEnv({ PATH: 'x', MCP_TOOL_TIMEOUT: '999' });
  assert.strictEqual('MCP_TOOL_TIMEOUT' in envScrubbed, false, 'an inherited MCP_TOOL_TIMEOUT must be scrubbed when this spawn does not ask for one');
});

// ================================================================ (p) spawn/restart plumbing

test("spawn: permission_prompt true over the fake lands the flag, the adapter arguments and MCP_TOOL_TIMEOUT in argv.json and the worker's environment, a restart keeps them, and a worker spawned without it has none of the three", async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  const savedEcho = process.env.FAKE_ECHO_MCP_TOOL_TIMEOUT;
  process.env.FAKE_ECHO_MCP_TOOL_TIMEOUT = '1';
  try {
    await m.spawn({
      substrate: 'claude-code', worktree: sb.worktree, prompt: 'hello', worker_id: 'w1',
      permission_prompt: true, permit_wait_ms: 12345,
    });

    const dir = path.join(sb.data, 'workers', 'w1');
    const argv = JSON.parse(fs.readFileSync(path.join(dir, 'argv.json'), 'utf8'));
    assert.ok(argv.spec.args.includes('--permission-prompt-tool'), 'the launch table must carry the flag');
    assert.strictEqual(argv.spec.args[argv.spec.args.indexOf('--permission-prompt-tool') + 1], 'mcp__belay__permit');

    const mcpJson = JSON.parse(fs.readFileSync(path.join(dir, 'mcp.json'), 'utf8'));
    const adapterArgs = mcpJson.mcpServers.belay.args;
    assert.ok(adapterArgs.includes('--permit'), 'the worker adapter must be launched with --permit');
    assert.strictEqual(adapterArgs[adapterArgs.indexOf('--permit-wait-ms') + 1], '12345');

    const stderrPath = path.join(dir, 'stderr.txt');
    const stderrText = await until(() => {
      const t = fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath, 'utf8') : '';
      return t.includes('FAKE_ENV') ? t : null;
    }, 5000);
    assert.ok(stderrText, 'the fake never echoed MCP_TOOL_TIMEOUT to stderr');
    assert.match(stderrText, /MCP_TOOL_TIMEOUT=72345/, 'permit_wait_ms + 60000');

    // a restart keeps them: the record carries permissionPrompt/permitWaitMs, so the relaunch's own
    // argv.json is rebuilt from the same flags.
    const restarted = await m.restart({ worker_id: 'w1' });
    assert.strictEqual(restarted.restarted !== false, true, JSON.stringify(restarted));
    const argv2 = JSON.parse(fs.readFileSync(path.join(dir, 'argv.json'), 'utf8'));
    assert.ok(argv2.spec.args.includes('--permission-prompt-tool'), 'a restart must keep the launch-table flag');
    const mcpJson2 = JSON.parse(fs.readFileSync(path.join(dir, 'mcp.json'), 'utf8'));
    assert.ok(mcpJson2.mcpServers.belay.args.includes('--permit'), 'a restart must keep the adapter flag');

    // a worker spawned without it has none of the three.
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: 'w2' });
    const dirNo = path.join(sb.data, 'workers', 'w2');
    const argvNo = JSON.parse(fs.readFileSync(path.join(dirNo, 'argv.json'), 'utf8'));
    assert.ok(!argvNo.spec.args.includes('--permission-prompt-tool'));
    const mcpJsonNo = JSON.parse(fs.readFileSync(path.join(dirNo, 'mcp.json'), 'utf8'));
    assert.ok(!mcpJsonNo.mcpServers.belay.args.includes('--permit'));
    const stderrNoPath = path.join(dirNo, 'stderr.txt');
    const stderrNo = await until(() => {
      const t = fs.existsSync(stderrNoPath) ? fs.readFileSync(stderrNoPath, 'utf8') : '';
      return t.includes('FAKE_ENV') ? t : null;
    }, 5000);
    assert.ok(stderrNo, 'the fake never echoed for the unflagged worker either');
    assert.match(stderrNo, /MCP_TOOL_TIMEOUT=\(absent\)/, 'no worker without permission_prompt may inherit or receive MCP_TOOL_TIMEOUT');
  } finally {
    if (savedEcho === undefined) delete process.env.FAKE_ECHO_MCP_TOOL_TIMEOUT; else process.env.FAKE_ECHO_MCP_TOOL_TIMEOUT = savedEcho;
    await teardown(m, sb);
  }
});

// ================================================================ (q) codex refusal

test('spawn: a codex worker with permission_prompt true is refused E_SUBSTRATE naming the substrate before any row or file exists', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  try {
    await assert.rejects(
      m.spawn({ substrate: 'codex', worktree: sb.worktree, prompt: 'hi', worker_id: 'w-codex', permission_prompt: true }),
      (e) => { assert.strictEqual(e.code, 'E_SUBSTRATE'); assert.match(e.message, /codex/i); return true; },
    );
    assert.strictEqual(core.rowsFor('w-codex').length, 0, 'no worker row may exist');
    assert.strictEqual(fs.existsSync(path.join(sb.data, 'workers')), false, 'no workers/ directory may exist');
  } finally { await teardown(m, sb); }
});

// ================================================================ (r) argument validation

test('spawn: a non-boolean permission_prompt or a non-positive permit_wait_ms is E_ARGS naming the field', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  try {
    await assert.rejects(
      m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', permission_prompt: 'yes' }),
      (e) => { assert.strictEqual(e.code, 'E_ARGS'); assert.match(e.message, /permission_prompt/); return true; },
    );
    await assert.rejects(
      m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', permit_wait_ms: 0 }),
      (e) => { assert.strictEqual(e.code, 'E_ARGS'); assert.match(e.message, /permit_wait_ms/); return true; },
    );
    await assert.rejects(
      m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', permit_wait_ms: -5 }),
      (e) => { assert.strictEqual(e.code, 'E_ARGS'); assert.match(e.message, /permit_wait_ms/); return true; },
    );
  } finally { await teardown(m, sb); }
});
