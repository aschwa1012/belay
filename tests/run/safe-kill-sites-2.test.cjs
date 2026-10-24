'use strict';
// safe-kill-sites-2.test.cjs — ADR 0039 review round: the orchestrator's killChild guard (mutation M11), and
// what a refused stop reports. A sleeper this test spawned stands for "the process that took over the pid".

const { readCreated } = require('../helpers/created.cjs');
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { runOrchestrator } = require('../../src/run/orchestrator.cjs');
const { createRunManager } = require('../../src/run/index.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const P = require('../../src/run/process.cjs');
const { cleanup } = require('../core/helpers.cjs');

const fwd = (p) => String(p).replace(/\\/g, '/');
const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');
const USER_SETTINGS = path.join(__dirname, 'fixtures', 'user-settings.json').replace(/\\/g, '/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sleeper = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { windowsHide: true, stdio: 'ignore' });
const running = (c) => c.exitCode === null && c.signalCode === null;

// A child whose exit the harness has already observed (exitCode 0) but whose pid a bystander now holds.
function spentChild(pid) {
  const c = new EventEmitter();
  Object.assign(c, { pid, exitCode: 0, signalCode: null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
  return c;
}

test('M11: orchestrator killChild never reaches a kill for a child whose exit was already observed, even if its pid is held', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-m11-'));
  fs.mkdirSync(path.join(d, 'wt'));
  const bystander = sleeper();
  const savedExe = process.env.BELAY_CLAUDE_EXE;
  process.env.BELAY_CLAUDE_EXE = FAKE; // never depend on a claude installed on the host; spawnWorker is stubbed below
  const saved = { spawnWorker: P.spawnWorker, killProcess: P.killProcess, killTree: P.killTree, killPid: P.killPid };
  const calls = [];
  const child = spentChild(bystander.pid);
  try {
    P.spawnWorker = () => { setImmediate(() => child.emit('spawn')); return child; };
    for (const k of ['killProcess', 'killTree', 'killPid']) P[k] = (...a) => { calls.push(k); return saved[k](...a); };
    const done = runOrchestrator({
      core: createFakeCore(), runId: 'run-m11', dataDir: fwd(path.join(d, '.belay')),
      spec: { worktree: fwd(path.join(d, 'wt')), promptText: 'x', orchestratorDir: fwd(path.join(d, 'orch')), model: 'm', allowedTools: null, startupTimeoutMs: 5000, timeoutMs: 0, mcpToolTimeoutMs: 1000, pollMs: 100, closeGraceMs: 500 },
      onAttached: async () => ({ ok: false, error: 'attach refused by the test' }), // reaches killChild with an exited child
    });
    await sleep(600);
    child.emit('exit', 0, null); // the run resolves when the child's exit arrives
    await done;
    assert.deepStrictEqual(calls, [], 'no kill may be attempted on a child whose exit was observed');
    assert.strictEqual(running(bystander), true, 'the process holding the pid must survive');
  } finally {
    Object.assign(P, saved); bystander.kill(); cleanup(d);
    if (savedExe === undefined) delete process.env.BELAY_CLAUDE_EXE; else process.env.BELAY_CLAUDE_EXE = savedExe;
  }
});

test('manager.stop: a refusal that proves the worker is not at that pid reports killed false and still writes the terminal row', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-stop-ref-'));
  fs.mkdirSync(path.join(d, 'wt'));
  const core = createFakeCore(); const m = createRunManager({ core, dataDir: fwd(d), runId: 'run-sk', paths: { claudeExe: FAKE, userSettings: USER_SETTINGS } });
  const s = sleeper();
  try {
    await core.worker.write({ id: 'w-m', run_id: 'run-sk', substrate: 'claude-code', pid: s.pid, pid_created: 1, state: 'running', session_id: 's', worktree: fwd(path.join(d, 'wt')), started_at: Date.now(), turns: 1 });
    const r = await m.stop({ worker_id: 'w-m', mode: 'kill', timeout_ms: 3000 });
    assert.strictEqual(r.killed, false, 'nothing was killed, so nothing may say it was');
    assert.strictEqual(r.refused, 'identity');
    assert.strictEqual(r.kind, 'mismatch');
    assert.strictEqual(core.currentWorker('w-m').state, 'stopped', 'the worker is provably not at that pid, so its terminal row is true');
    assert.strictEqual(running(s), true);
  } finally { s.kill(); await m.shutdown(); cleanup(fwd(d)); }
});

test('manager.stop: a refusal that proves nothing (no creation time, wrong image) writes no terminal row while the pid is alive', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-stop-unv-'));
  fs.mkdirSync(path.join(d, 'wt'));
  const core = createFakeCore(); const m = createRunManager({ core, dataDir: fwd(d), runId: 'run-sk', paths: { claudeExe: FAKE, userSettings: USER_SETTINGS } });
  const s = sleeper();
  try {
    await core.worker.write({ id: 'w-u', run_id: 'run-sk', substrate: 'claude-code', pid: s.pid, state: 'running', session_id: 's', worktree: fwd(path.join(d, 'wt')), started_at: Date.now(), turns: 1 });
    const r = await m.stop({ worker_id: 'w-u', mode: 'kill', timeout_ms: 3000 });
    assert.strictEqual(r.killed, false);
    assert.strictEqual(r.kind, 'unverifiable');
    assert.notStrictEqual(core.currentWorker('w-u').state, 'stopped');
    assert.notStrictEqual(core.currentWorker('w-u').state, 'dead');
    assert.strictEqual(running(s), true);
    // and a row whose creation-time read failed is unverified even with a matching image
    await core.worker.write({ id: 'w-e', run_id: 'run-sk', substrate: 'claude-code', pid: s.pid, pid_image: 'node.exe', pid_created_error: 'snapshot failed', state: 'running', session_id: 's', worktree: fwd(path.join(d, 'wt')), started_at: Date.now(), turns: 1 });
    const e = await m.stop({ worker_id: 'w-e', mode: 'kill', timeout_ms: 3000 });
    assert.strictEqual(e.killed, false);
    assert.match(e.detail, /never verified at spawn/);
    assert.strictEqual(running(s), true);
  } finally { s.kill(); await m.shutdown(); cleanup(fwd(d)); }
});

test('manager.stop: an adopted row with no creation time kills only the root by image and says the descendants were not killed', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-stop-old-'));
  fs.mkdirSync(path.join(d, 'wt'));
  const core = createFakeCore(); const m = createRunManager({ core, dataDir: fwd(d), runId: 'run-sk', paths: { claudeExe: FAKE, userSettings: USER_SETTINGS } });
  const s = sleeper();
  try {
    await core.worker.write({ id: 'w-o', run_id: 'run-sk', substrate: 'claude-code', pid: s.pid, pid_image: path.basename(process.execPath), state: 'running', session_id: 's', worktree: fwd(path.join(d, 'wt')), started_at: Date.now(), turns: 1 });
    const r = await m.stop({ worker_id: 'w-o', mode: 'kill', timeout_ms: 3000 });
    assert.strictEqual(r.killed, true);
    assert.match(r.descendants_not_killed, /descendants not killed: .*no recorded creation time/);
    await new Promise((res) => (s.exitCode !== null ? res() : s.once('exit', res)));
  } finally { if (running(s)) s.kill(); await m.shutdown(); cleanup(fwd(d)); }
});

test('manager.stop: a live worker whose pid_image differs from CIM\'s name (right creation time) is never marked stopped', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-stop-img-'));
  fs.mkdirSync(path.join(d, 'wt'));
  const core = createFakeCore(); const m = createRunManager({ core, dataDir: fwd(d), runId: 'run-sk', paths: { claudeExe: FAKE, userSettings: USER_SETTINGS } });
  const s = sleeper();
  try {
    await sleep(300);
    const made = await readCreated(s.pid);
    await core.worker.write({ id: 'w-i', run_id: 'run-sk', substrate: 'claude-code', pid: s.pid, pid_created: made.created, pid_image: 'not-the-name.exe', state: 'running', session_id: 's', worktree: fwd(path.join(d, 'wt')), started_at: Date.now(), turns: 1 });
    const r = await m.stop({ worker_id: 'w-i', mode: 'kill', timeout_ms: 3000 });
    assert.strictEqual(r.killed, false);
    assert.strictEqual(r.kind, 'unverifiable');
    assert.notStrictEqual(core.currentWorker('w-i').state, 'stopped', 'a worker that is still alive must not be written stopped');
    assert.strictEqual(running(s), true);
  } finally { s.kill(); await m.shutdown(); cleanup(fwd(d)); }
});
