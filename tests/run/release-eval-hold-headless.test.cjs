'use strict';
// release-eval-hold-headless.test.cjs — ADR 0058 amendment 2 in the headless orchestrator: a worker's turn ends with its
// hand-back still being evaluated, and the evaluation lands a few polls later. The orchestrator gets one wake for it (the
// turn_end, carrying the result), never a turn_end and then an evaluated wake. Over the fakes: no Claude Code, no model.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runOrchestrator } = require('../../src/run/orchestrator.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const fwd = (p) => String(p).split(path.sep).join('/');
const FAKE = fwd(path.join(__dirname, 'fakes', 'fake-claude.cjs'));
const RUN = 'run-hold';

test('the headless orchestrator holds a turn_end wake for its release evaluation and sends one wake', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-hold-headless-'));
  const sb = { worktree: fwd(path.join(root, 'wt')), dataDir: fwd(path.join(root, '.belay')), orchestratorDir: fwd(path.join(root, 'orch')) };
  fs.mkdirSync(sb.worktree, { recursive: true });
  fs.mkdirSync(sb.dataDir, { recursive: true });
  const core = createFakeCore();
  // One worker of the run that has finished turn 1, alive and not mid-turn; its task released with a hand-back.
  core.worker = { ...core.worker, list: async () => ({ workers: [{ id: 'w1', run_id: RUN, state: 'running', turns: 1, seq: 2, pid: process.pid, pid_alive: true, mid_turn: 0 }] }) };
  let reads = 0;
  const released = { id: 't1', run_id: RUN, state: 'released', handoff: { by: 'w1', at: 10 }, results: null };
  const done = { ...released, state: 'done', results: { trigger: 'release', evaluated_at: 20, passed: true, executable: true, checks: [] } };
  core.task = { ...(core.task || {}), list: async () => { reads += 1; return { tasks: [reads > 4 ? done : released] }; } }; // lands on the fifth read
  const savedExe = process.env.BELAY_CLAUDE_EXE;
  const savedHold = process.env.BELAY_RELEASE_WAKE_HOLD_MS;
  process.env.BELAY_CLAUDE_EXE = FAKE;
  delete process.env.BELAY_RELEASE_WAKE_HOLD_MS; // the shipped hold
  try {
    const out = await runOrchestrator({ core, runId: RUN, dataDir: sb.dataDir, onAttached: async () => ({ ok: true }), spec: {
      worktree: sb.worktree, promptText: 'hello', orchestratorDir: sb.orchestratorDir, model: 'claude-sonnet-5', allowedTools: null,
      startupTimeoutMs: 8000, timeoutMs: 60000, mcpToolTimeoutMs: 60000, pollMs: 50, closeGraceMs: 3000,
    } });
    assert.ok(reads > 4, `the evaluation landed before the run closed (${reads} task reads)`);
    const about = out.wakes.filter((w) => w.worker_id === 'w1' || String(w.worker_id).startsWith('eval:'));
    assert.deepStrictEqual(about.map((w) => w.event), ['turn_end'], `one wake for the release: ${JSON.stringify(out.wakes)}`);
    assert.ok(out.holds.some((h) => JSON.stringify(h).includes('wake:w1')), 'the held wake held the idle close');
  } finally {
    if (savedExe === undefined) delete process.env.BELAY_CLAUDE_EXE; else process.env.BELAY_CLAUDE_EXE = savedExe;
    if (savedHold !== undefined) process.env.BELAY_RELEASE_WAKE_HOLD_MS = savedHold;
    cleanup(root);
  }
});
