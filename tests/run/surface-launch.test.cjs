'use strict';
// surface-launch.test.cjs — build step S2, ADR 0024: the
// ready gate's surface check, driven over the fakes (never a real Claude Code session — those cost
// money and are the acceptance rows' job, not this suite's). fake-claude.cjs's FAKE_SURFACE and
// FAKE_SURFACE_ON_RESUME knobs corrupt its own first init so the refusal paths are drivable.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { runOrchestrator } = require('../../src/run/orchestrator.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');
const P = require('../../src/run/process.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');
const fwd = (p) => String(p).replace(/\\/g, '/');

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-surface-launch-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { data: fwd(d), worktree: fwd(path.join(d, 'wt')) };
}

function mgr(sb, core) {
  return createRunManager({
    core, dataDir: sb.data, runId: 'run-surface',
    paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') },
  });
}

// Every test clears its own knobs in `finally`, whether it threw or not, so one test's fault plant
// never leaks a FAKE_SURFACE_* variable into the next.
function clearKnobs() {
  delete process.env.FAKE_SURFACE;
  delete process.env.FAKE_SURFACE_ON_RESUME;
}

// ------------------------------------------------------------------------- (s8)

test('spawn: a first init with an extra tool fails E_NO_READY naming it, and the worker is dead with its pid gone', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  process.env.FAKE_SURFACE = 'extra-tool';
  try {
    let pid = null;
    await assert.rejects(
      () => m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: 'w-extra' }),
      (e) => {
        assert.equal(e.code, 'E_NO_READY');
        assert.match(e.detail.reason, /Task/, 'the reason must name the extra tool: ' + e.detail.reason);
        pid = e.detail.pid;
        return true;
      }
    );
    assert.ok(Number.isInteger(pid) && pid > 0);
    assert.equal(P.pidAlive(pid), false, 'a worker refused at the surface gate is killed, not left behind');
    const states = core.rowsFor('w-extra').map((r) => r.state);
    assert.equal(states[states.length - 1], 'dead');
  } finally {
    clearKnobs();
    await m.shutdown();
    cleanup(sb.data);
  }
});

// ------------------------------------------------------------------------- (s9)

test("restart: a resumed init with a user plugin fails the relaunch naming it", async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  process.env.FAKE_SURFACE = 'user-plugin';
  process.env.FAKE_SURFACE_ON_RESUME = '1';
  try {
    const row = await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: 'w-plugin' });
    assert.equal(row.state, 'running', 'the fresh spawn is untouched by FAKE_SURFACE_ON_RESUME');
    await assert.rejects(
      () => m.restart({ worker_id: 'w-plugin' }),
      (e) => {
        assert.equal(e.code, 'E_NO_READY');
        assert.match(e.detail.reason, /example-plugin@example/, 'the reason must name the user plugin: ' + e.detail.reason);
        return true;
      }
    );
  } finally {
    clearKnobs();
    await m.shutdown();
    cleanup(sb.data);
  }
});

// ------------------------------------------------------------------------- (s10)

test('spawn: a clean fake launch passes and its ready evidence carries tools_hash', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  try {
    const row = await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: 'w-clean' });
    assert.equal(row.state, 'running');
    const ev = m._worker('w-clean').readyEvidence;
    assert.match(ev.tools_hash, /^[0-9a-f]{64}$/);
    assert.deepStrictEqual(ev.builtins, ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write']);
    // F4 (S2 review 1, should-fix 4): the gate's evidence is also on the method's own return, not only
    // on the in-memory record — a caller has no other receipt of the surface it got.
    assert.match(row.surface.tools_hash, /^[0-9a-f]{64}$/);
    assert.equal(row.surface.tools_hash, ev.tools_hash);
    assert.deepStrictEqual(row.surface.builtins, ev.builtins);
    assert.deepStrictEqual(row.surface.belay_tools, ev.belay_tools);
  } finally {
    await m.shutdown();
    cleanup(sb.data);
  }
});

// ------------------------------------------------------------------------- (F4, restart return)

test('restart: a clean relaunch also carries surface.tools_hash on its own return', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: 'w-restart-surface' });
    const restarted = await m.restart({ worker_id: 'w-restart-surface' });
    assert.match(restarted.surface.tools_hash, /^[0-9a-f]{64}$/);
    assert.deepStrictEqual(restarted.surface.builtins, ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write']);
  } finally {
    await m.shutdown();
    cleanup(sb.data);
  }
});

// ------------------------------------------------------------------------- (s12)

test('orchestrator: a malformed plugins field aborts the run, naming it', async () => {
  const sb = sandbox();
  const dataDir = fwd(path.join(sb.data, '.belay'));
  const orchestratorDir = fwd(path.join(sb.data, 'orch'));
  fs.mkdirSync(dataDir, { recursive: true });
  const core = createFakeCore();
  core.worker = { ...core.worker, list: async () => ({ workers: [] }) };

  const savedExe = process.env.BELAY_CLAUDE_EXE;
  process.env.BELAY_CLAUDE_EXE = FAKE;
  process.env.FAKE_SURFACE = 'plugins-object';
  try {
    const result = await runOrchestrator({
      core, runId: 'run-s12', dataDir,
      spec: {
        worktree: sb.worktree, promptText: 'hello', orchestratorDir, model: 'claude-sonnet-5',
        allowedTools: null, startupTimeoutMs: 8000, timeoutMs: 0, mcpToolTimeoutMs: 60000,
        pollMs: 100, closeGraceMs: 3000,
      },
      onAttached: async () => ({ ok: true }),
    });
    // Renamed by fix round 2 (tester 2): this test used to be named for the `.catch` path it no longer
    // reaches. F1 (review 1) already made checkSurface refuse a malformed plugins field rather than
    // throw; fix round 2 additionally calls it synchronously in handleEvent, right on the ready event,
    // before the poll chain ever starts — closing the race where a turn ending before verifyReady's own
    // microtask-later check let the idle-close win and discard this exact reason. This test now proves
    // that synchronous path: the run aborts naming the bad surface, every time, not just most times.
    assert.match(result.ended_by, /plugins/, 'the run must name the malformed surface: ' + result.ended_by);
    assert.equal(result.orchestrator.exit_code === 0, false, 'the orchestrator was killed, not let finish on its own');
  } finally {
    if (savedExe === undefined) delete process.env.BELAY_CLAUDE_EXE; else process.env.BELAY_CLAUDE_EXE = savedExe;
    clearKnobs();
    cleanup(sb.data);
  }
});

// ------------------------------------------------------------------------- (s13)

test('spawn: a malformed plugins field fails E_NO_READY with the worker dead and its pid gone', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  process.env.FAKE_SURFACE = 'plugins-object';
  try {
    let pid = null;
    await assert.rejects(
      () => m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: 'w-badplugins' }),
      (e) => {
        assert.equal(e.code, 'E_NO_READY');
        assert.match(e.detail.reason, /plugins/, 'the reason must name the malformed field: ' + e.detail.reason);
        pid = e.detail.pid;
        return true;
      }
    );
    assert.ok(Number.isInteger(pid) && pid > 0);
    assert.equal(P.pidAlive(pid), false, 'a worker refused at the surface gate is killed, not left behind');
    const states = core.rowsFor('w-badplugins').map((r) => r.state);
    assert.equal(states[states.length - 1], 'dead');
  } finally {
    clearKnobs();
    await m.shutdown();
    cleanup(sb.data);
  }
});

// ------------------------------------------------------------------------- (fix round 3)

test('orchestrator: a failed belay connection aborts the run naming the connection, not the surface', async () => {
  const sb = sandbox();
  const dataDir = fwd(path.join(sb.data, '.belay'));
  const orchestratorDir = fwd(path.join(sb.data, 'orch'));
  fs.mkdirSync(dataDir, { recursive: true });
  const core = createFakeCore();
  core.worker = { ...core.worker, list: async () => ({ workers: [] }) };

  const savedExe = process.env.BELAY_CLAUDE_EXE;
  process.env.BELAY_CLAUDE_EXE = FAKE;
  process.env.FAKE_MCP = 'failed';
  try {
    const result = await runOrchestrator({
      core, runId: 'run-fixround3', dataDir,
      spec: {
        worktree: sb.worktree, promptText: 'hello', orchestratorDir, model: 'claude-sonnet-5',
        allowedTools: null, startupTimeoutMs: 8000, timeoutMs: 0, mcpToolTimeoutMs: 60000,
        pollMs: 100, closeGraceMs: 3000,
      },
      onAttached: async () => ({ ok: true }),
    });
    // Review 2 should-fix: before this fix the sync pre-check ran checkSurface alone, ahead of the
    // mcp_servers check, and the fake still listed a belay tool even when not connected — so this was
    // reported as "no mcp__belay__* tool is listed" (a surface defect) instead of the real cause.
    assert.match(result.ended_by, /mcp_servers/, 'must name the connection failure: ' + result.ended_by);
    assert.match(result.ended_by, /status connected/, 'must name the connection failure: ' + result.ended_by);
    assert.doesNotMatch(result.ended_by, /mcp__belay/, 'must not blame the tool list: ' + result.ended_by);
    assert.equal(result.orchestrator.exit_code === 0, false, 'the orchestrator was killed, not let finish on its own');
  } finally {
    if (savedExe === undefined) delete process.env.BELAY_CLAUDE_EXE; else process.env.BELAY_CLAUDE_EXE = savedExe;
    delete process.env.FAKE_MCP;
    clearKnobs();
    cleanup(sb.data);
  }
});

// ------------------------------------------------------------------------- (s11)

test('orchestrator: a first init with memory_paths.auto aborts the run naming it', async () => {
  const sb = sandbox();
  const dataDir = fwd(path.join(sb.data, '.belay'));
  const orchestratorDir = fwd(path.join(sb.data, 'orch'));
  fs.mkdirSync(dataDir, { recursive: true });
  const core = createFakeCore();
  core.worker = { ...core.worker, list: async () => ({ workers: [] }) };

  const savedExe = process.env.BELAY_CLAUDE_EXE;
  process.env.BELAY_CLAUDE_EXE = FAKE;
  process.env.FAKE_SURFACE = 'memory';
  try {
    const result = await runOrchestrator({
      core, runId: 'run-s11', dataDir,
      spec: {
        worktree: sb.worktree, promptText: 'hello', orchestratorDir, model: 'claude-sonnet-5',
        allowedTools: null, startupTimeoutMs: 8000, timeoutMs: 0, mcpToolTimeoutMs: 60000,
        pollMs: 100, closeGraceMs: 3000,
      },
      onAttached: async () => ({ ok: true }),
    });
    assert.match(result.ended_by, /memory_paths\.auto/, 'the run must name the bad surface: ' + result.ended_by);
    assert.equal(result.orchestrator.exit_code === 0, false, 'the orchestrator was killed, not let finish on its own');
  } finally {
    if (savedExe === undefined) delete process.env.BELAY_CLAUDE_EXE; else process.env.BELAY_CLAUDE_EXE = savedExe;
    clearKnobs();
    cleanup(sb.data);
  }
});

// ------------------------------------------------------------------------- ADR 0054 decision 1

async function orchestrate(sb, knob) {
  const dataDir = fwd(path.join(sb.data, '.belay'));
  fs.mkdirSync(dataDir, { recursive: true });
  const core = createFakeCore();
  core.worker = { ...core.worker, list: async () => ({ workers: [] }) };
  const savedExe = process.env.BELAY_CLAUDE_EXE;
  process.env.BELAY_CLAUDE_EXE = FAKE;
  if (knob) process.env.FAKE_SURFACE = knob;
  try {
    return await runOrchestrator({
      core, runId: `run-0054-${knob || 'clean'}`, dataDir,
      spec: {
        worktree: sb.worktree, promptText: 'hello', orchestratorDir: fwd(path.join(sb.data, 'orch')), model: 'claude-sonnet-5',
        allowedTools: null, startupTimeoutMs: 8000, timeoutMs: 0, mcpToolTimeoutMs: 60000, pollMs: 100, closeGraceMs: 3000,
      },
      onAttached: async () => ({ ok: true }),
    });
  } finally {
    if (savedExe === undefined) delete process.env.BELAY_CLAUDE_EXE; else process.env.BELAY_CLAUDE_EXE = savedExe;
    clearKnobs();
  }
}

test('orchestrator: launched with --tools Read,Glob,Grep,Edit,Write, and its surface evidence names exactly those', async () => {
  const sb = sandbox();
  try {
    const result = await orchestrate(sb, null);
    assert.deepStrictEqual(result.orchestrator.surface.builtins, ['Edit', 'Glob', 'Grep', 'Read', 'Write'], JSON.stringify(result.orchestrator.surface));
    const argv = JSON.parse(fs.readFileSync(path.join(sb.data, 'orch', 'argv.json'), 'utf8')).spec.args;
    assert.strictEqual(argv[argv.indexOf('--tools') + 1], 'Read,Glob,Grep,Edit,Write');
  } finally { cleanup(sb.data); }
});

test('orchestrator: an init that reports Bash aborts the run, naming it', async () => {
  const sb = sandbox();
  try {
    const result = await orchestrate(sb, 'six-tools');
    assert.match(result.ended_by, /extra built-in tool\(s\) beyond ADR 0024's list: Bash(;|$)/, result.ended_by);
    assert.equal(result.orchestrator.exit_code === 0, false, 'the orchestrator was killed, not let finish on its own');
  } finally { cleanup(sb.data); }
});
