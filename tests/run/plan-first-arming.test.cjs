'use strict';
require('../helpers/tmp.cjs');
// plan-first-arming.test.cjs — ADR 0074 amendment 4: a plan-first run's first step is a build, before any worker exists, so the headless run
// arms its policy watcher from the run's plan at start (cmd-run passes `policy` from the run's plan), and a due build holds the idle close.
// The run's own orchestrator loop over the fake executable and a fake core: the orchestrator ends its first turn, no worker ever starts.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runOrchestrator } = require('../../src/run/orchestrator.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const RUN = 'r1';
const fwd = (p) => String(p).split(path.sep).join('/');
const PLANNED = { id: 'T1', seq: 3, run_id: RUN, state: 'open', policy: { build: { worker: 'b1' } }, policy_rev: 1, depends_on: [], repairs: null, lease: null, acceptance: { commands: [] }, review: null, integration: null };

test('cmd-run passes the run plan to the orchestrator loop, so the policy watcher is armed from the start', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/cli/cmd-run.cjs'), 'utf8');
  assert.match(src, /policy: !!parsed\.levers\.policy_default,/);
});

test('armed at start: the orchestrator ends its turn with no worker yet, and the due build holds the close', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-pf-arm-'));
  const saved = process.env.BELAY_CLAUDE_EXE;
  process.env.BELAY_CLAUDE_EXE = fwd(path.join(__dirname, 'fakes', 'fake-claude.cjs'));
  try {
    const sb = { worktree: fwd(path.join(root, 'wt')), dataDir: fwd(path.join(root, '.belay')), orchestratorDir: fwd(path.join(root, 'orch')) };
    fs.mkdirSync(sb.worktree, { recursive: true }); fs.mkdirSync(sb.dataDir, { recursive: true });
    const core = createFakeCore();
    core.task = { ...(core.task || {}), list: async () => ({ tasks: [PLANNED] }) };
    core.policy = { list: async () => ({ rows: [], last_seq: 0 }) };
    const out = await runOrchestrator({ core, runId: RUN, dataDir: sb.dataDir, onAttached: async () => ({ ok: true }), spec: {
      worktree: sb.worktree, promptText: 'hello', orchestratorDir: sb.orchestratorDir, model: 'claude-sonnet-5', allowedTools: null, policy: true,
      startupTimeoutMs: 8000, timeoutMs: 120000, mcpToolTimeoutMs: 60000, pollMs: 50, closeGraceMs: 3000,
    } });
    const held = (out.holds || []).filter((h) => Array.isArray(h.live) && h.live.includes('policy:build:T1'));
    assert.ok(held.length > 0, `the due build held the close: ${JSON.stringify((out.holds || []).slice(0, 3))}`);
  } finally {
    if (saved === undefined) delete process.env.BELAY_CLAUDE_EXE; else process.env.BELAY_CLAUDE_EXE = saved;
    cleanup(root);
  }
});
