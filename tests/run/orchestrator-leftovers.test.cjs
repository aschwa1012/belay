'use strict';
// orchestrator-leftovers.test.cjs — ADR 0054 amendment 2: what a headless orchestrator's shell left running is ended at the close,
// by exact pid after its identity is checked again; a process that is not its descendant, or whose pid no longer matches, is not.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { runOrchestrator } = require('../../src/run/orchestrator.cjs');
const { createLeftovers } = require('../../src/run/orchestrator-leftovers.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');
const P = require('../../src/run/process.cjs');

const fwd = (p) => String(p).split(path.sep).join('/');
const FAKE = fwd(path.join(__dirname, 'fakes', 'fake-claude.cjs'));
const HELPER = path.join(__dirname, 'fakes', 'helper-sleeper.cjs');

// Waits on the real event: the helper has written its pid file.
async function pidFrom(file, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const n = Number(fs.readFileSync(file, 'utf8')); if (Number.isInteger(n) && n > 0) return n; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`no pid in ${file}`);
}

test('a process the orchestrator\'s shell started is ended at the close; an unrelated process is not', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-leftovers-'));
  fs.mkdirSync(path.join(d, 'wt'));
  const dataDir = fwd(path.join(d, '.belay'));
  fs.mkdirSync(dataDir, { recursive: true });
  const kidFile = path.join(d, 'kid.pid');
  const otherFile = path.join(d, 'other.pid');
  const other = spawn(process.execPath, [HELPER], { stdio: 'ignore', windowsHide: true, env: { ...process.env, FAKE_HELPER_PIDFILE: otherFile } });
  const saved = { exe: process.env.BELAY_CLAUDE_EXE, orphan: process.env.FAKE_ORPHAN_CHILD, pf: process.env.FAKE_CHILD_PID_FILE };
  process.env.BELAY_CLAUDE_EXE = FAKE; process.env.FAKE_ORPHAN_CHILD = '1'; process.env.FAKE_CHILD_PID_FILE = kidFile; // a detached child, as the fake's own knob makes it: it survives the fake's exit
  let kid = null;
  try {
    await pidFrom(otherFile);
    const core = createFakeCore();
    core.worker = { ...core.worker, list: async () => ({ workers: [] }) };
    const result = await runOrchestrator({
      core, runId: 'run-leftovers', dataDir,
      spec: { worktree: fwd(path.join(d, 'wt')), promptText: 'hello', orchestratorDir: fwd(path.join(d, 'orch')), model: 'claude-sonnet-5', allowedTools: null, startupTimeoutMs: 8000, timeoutMs: 0, mcpToolTimeoutMs: 60000, pollMs: 100, closeGraceMs: 3000 },
      onAttached: async () => ({ ok: true }),
    });
    kid = await pidFrom(kidFile);
    assert.ok(result.leftovers, 'the result names what was found: ' + JSON.stringify(result));
    assert.ok(result.leftovers.found.includes(kid) && !result.leftovers.found.includes(other.pid), "the shell's process is found, the unrelated one is not");
    assert.ok(result.leftovers.killed.includes(kid), 'and ended by its pid: ' + JSON.stringify(result.leftovers));
    assert.strictEqual(P.pidAlive(kid), false, 'the shell\'s process is gone when the run is reported over');
    assert.strictEqual(P.pidAlive(other.pid), true, 'a process that is not its descendant is left alone');
  } finally {
    for (const [k, v] of [['BELAY_CLAUDE_EXE', saved.exe], ['FAKE_ORPHAN_CHILD', saved.orphan], ['FAKE_CHILD_PID_FILE', saved.pf]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (kid && P.pidAlive(kid)) { try { process.kill(kid, 'SIGKILL'); } catch { /* gone */ } }
    try { process.kill(other.pid, 'SIGKILL'); } catch { /* gone */ }
    cleanup(d);
  }
});

test('a recorded descendant whose pid now belongs to another process (a different creation time) is refused, not killed', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-leftovers-'));
  const pidFile = path.join(d, 'p.pid');
  const stranger = spawn(process.execPath, [HELPER], { stdio: 'ignore', windowsHide: true, env: { ...process.env, FAKE_HELPER_PIDFILE: pidFile } });
  try {
    await pidFrom(pidFile);
    const real = await P.createdOf(stranger.pid);
    assert.ok(real && real.created != null, 'the stranger\'s creation time is readable');
    const parent = { pid: process.pid, exitCode: null, signalCode: null };
    const fakeP = { createdOf: async () => ({ created: 1 }), descendantTargets: async () => [{ pid: stranger.pid, created: real.created - 60000, image: real.image }], killMany: (t) => P.killMany(t) };
    const state = {};
    const l = createLeftovers({ child: parent, P: fakeP, state });
    await l.capture();
    const r = await l.end();
    assert.deepStrictEqual(r.killed, []);
    assert.strictEqual(r.refused.length, 1);
    assert.strictEqual(r.refused[0].pid, stranger.pid);
    assert.strictEqual(P.pidAlive(stranger.pid), true, 'the process that took the pid is untouched');
  } finally { try { process.kill(stranger.pid, 'SIGKILL'); } catch { /* gone */ } cleanup(d); }
});
