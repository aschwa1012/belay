'use strict';
// orchestrator-bind.test.cjs — ADR 0045 decision 2 on the orchestrator's side: both launchers (headless and interactive) open a bind
// for the orchestrator before it is spawned and write its pipe into the orchestrator's mcp.json as --bind; the interactive one asks for
// a bind that does not expire, because Claude Code starts the MCP server only after the trust dialog is answered. A core with no bind
// verbs launches unbound. Over the fakes: no Claude Code, no model.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runOrchestrator } = require('../../src/run/orchestrator.cjs');
const { runInteractiveOrchestrator } = require('../../src/run/orchestrator-interactive.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const fwd = (p) => String(p).split(path.sep).join('/');
const FAKE = fwd(path.join(__dirname, 'fakes', 'fake-claude.cjs'));

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-orch-bind-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  fs.mkdirSync(path.join(d, '.belay'), { recursive: true });
  return { root: d, worktree: fwd(path.join(d, 'wt')), dataDir: fwd(path.join(d, '.belay')), orchestratorDir: fwd(path.join(d, 'orch')) };
}

function bindingCore() {
  const core = createFakeCore();
  core.worker = { ...core.worker, list: async () => ({ workers: [] }) };
  const asked = [];
  core.bindOpen = async (identity, opts) => { asked.push({ identity, opts: opts || {} }); return { bind_id: 'bo1', pipe: 'belay-test-orch-bind', caller: identity }; };
  core.bindRevoke = async (id) => ({ bind_id: id, state: 'revoked' });
  return { core, asked };
}

const bindIn = (dir) => {
  const args = JSON.parse(fs.readFileSync(path.join(dir, 'mcp.json'), 'utf8')).mcpServers.belay.args;
  return args.includes('--bind') ? args[args.indexOf('--bind') + 1] : null;
};

const spec = (sb) => ({
  worktree: sb.worktree, promptText: 'hello', orchestratorDir: sb.orchestratorDir, model: 'claude-sonnet-5',
  allowedTools: null, startupTimeoutMs: 8000, timeoutMs: 0, mcpToolTimeoutMs: 60000, pollMs: 100, closeGraceMs: 3000,
});

async function headless(sb, core) {
  const saved = process.env.BELAY_CLAUDE_EXE;
  process.env.BELAY_CLAUDE_EXE = FAKE;
  try {
    await runOrchestrator({ core, runId: 'run-ob', dataDir: sb.dataDir, spec: spec(sb), onAttached: async () => ({ ok: true }) });
  } finally { if (saved === undefined) delete process.env.BELAY_CLAUDE_EXE; else process.env.BELAY_CLAUDE_EXE = saved; }
}

test('the headless orchestrator is launched with a bind opened for exactly its run, written into its mcp.json', async () => {
  const sb = sandbox(); const { core, asked } = bindingCore();
  try {
    await headless(sb, core);
    assert.deepStrictEqual(asked, [{ identity: { role: 'orchestrator', run_id: 'run-ob' }, opts: {} }], 'one bind, for the orchestrator of this run, with an expiry');
    assert.strictEqual(bindIn(sb.orchestratorDir), 'belay-test-orch-bind');
  } finally { cleanup(sb.root); }
});

test('a core with no bind verbs launches the headless orchestrator unbound', async () => {
  const sb = sandbox(); const core = createFakeCore();
  core.worker = { ...core.worker, list: async () => ({ workers: [] }) };
  try {
    await headless(sb, core);
    assert.strictEqual(bindIn(sb.orchestratorDir), null);
  } finally { cleanup(sb.root); }
});

test('the interactive orchestrator\'s bind is written into its mcp.json and does not expire', async () => {
  const sb = sandbox(); const { core, asked } = bindingCore();
  const stop = new Error('stopped after the files, before any spawn');
  try {
    await assert.rejects(runInteractiveOrchestrator({
      core, runId: 'run-ob', dataDir: sb.dataDir, spec: { ...spec(sb), interactiveSurfaceMs: 1000 },
      onAttached: async () => ({ ok: true }), deps: { argv: () => { throw stop; } },
    }), (e) => e === stop);
    assert.deepStrictEqual(asked, [{ identity: { role: 'orchestrator', run_id: 'run-ob' }, opts: { noExpiry: true } }]);
    assert.strictEqual(bindIn(sb.orchestratorDir), 'belay-test-orch-bind');
  } finally { cleanup(sb.root); }
});
