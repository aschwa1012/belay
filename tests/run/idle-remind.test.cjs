'use strict';
// idle-remind.test.cjs — ADR 0058, the idle-workers amendment (proposed): worker_wait's answer names the workers left idle with no task;
// a wake does not (an idle coder may be kept for a fix round). The real core and run manager with the fake substrate.
// The threshold is a parameter here, and BELAY_IDLE_REMIND_MS (test mode only) for the run manager: nothing waits it out.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { wakeText } = require('../../src/run/wake.cjs');
const { WAKE_TEXT_MAX } = require('../../src/run/release-eval.cjs');
const { createRunManager } = require('../../src/run/index.cjs');
const { openCore } = require('../../src/core/index.cjs');
const { sandbox, cleanup, callerFor } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').split(path.sep).join('/');
const RUN = 'idle-remind-run';

const row = (id, over = {}) => ({ id, run_id: RUN, state: 'running', mid_turn: 0, pid_alive: true, last_event_age_ms: 5000, turns: 1, ...over });
const coreWith = (tasks) => ({ task: { list: async () => ({ tasks }) } });
const leaseOf = (holder) => ({ id: `t-${holder}`, state: 'assigned', lease: { holder, holder_role: 'worker' } });

test('worker_wait names the idle worker that holds no lease, and not the one that does', { timeout: 90000 }, async () => {
  const dir = sandbox();
  const core = await openCore({ dataDir: dir, caller: callerFor('orchestrator', { run_id: RUN }), embed: false });
  const wt = path.join(dir, 'wt');
  fs.mkdirSync(wt, { recursive: true });
  const saved = { mode: process.env.BELAY_TEST_MODE, ms: process.env.BELAY_IDLE_REMIND_MS };
  let m = null;
  try {
    await core.run.attach({ adapter_pid: process.pid });
    const task = await core.task.create({ spec: 'held', files_owned: [] });
    m = createRunManager({ core: core.harness(), dataDir: dir, runId: RUN, paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
    const opts = { substrate: 'claude-code', worktree: wt.split(path.sep).join('/'), prompt: 'one' };
    await m.spawn({ ...opts, worker_id: 'free' });
    await m.spawn({ ...opts, worker_id: 'held', task_id: task.id });
    for (const id of ['free', 'held']) await m.wait({ worker_ids: [id], timeout_ms: 30000 }); // both first turns ended
    process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_IDLE_REMIND_MS = '0';
    const ans = await m.wait({ worker_ids: ['held'], timeout_ms: 5000 });
    assert.deepStrictEqual(ans.idle_without_task, ['free'], JSON.stringify(ans));
    process.env.BELAY_IDLE_REMIND_MS = '3600000';
    assert.strictEqual((await m.wait({ worker_ids: ['held'], timeout_ms: 5000 })).idle_without_task, undefined, 'under the threshold nothing is named');
  } finally {
    for (const [k, v] of [['BELAY_TEST_MODE', saved.mode], ['BELAY_IDLE_REMIND_MS', saved.ms]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (m) { try { await m.shutdown(); } catch { /* best effort */ } }
    try { await core.shutdownOwner(); } catch { /* best effort */ }
    await core.close();
    cleanup(dir);
  }
});

test('the interactive wake publisher names no idle worker on the wake it publishes', { timeout: 30000 }, async () => {
  const net = require('node:net');
  const crypto = require('node:crypto');
  const os = require('node:os');
  const { startWakePublisher } = require('../../src/run/wake-pipe.cjs');
  const pipe = process.platform === 'win32' ? `//./pipe/belay-test-idle-${crypto.randomBytes(5).toString('hex')}` : path.join(os.tmpdir(), `belay-test-idle-${crypto.randomBytes(5).toString('hex')}.sock`);
  const rows = { now: [row('w1', { turns: 0, seq: 1, last_event_age_ms: 10 }), row('idle', { turns: 0, seq: 2 })] };
  let polls = 0; let polled = null;
  const core = {
    worker: { list: async () => { polls += 1; if (polled) polled(); return { workers: rows.now.map((r) => ({ ...r })) }; } },
    task: { list: async () => ({ tasks: [] }) },
  };
  const saved = { mode: process.env.BELAY_TEST_MODE, ms: process.env.BELAY_IDLE_REMIND_MS };
  process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_IDLE_REMIND_MS = '1000';
  const pub = startWakePublisher({ core, runId: RUN, pipeName: pipe, pollMs: 10 });
  let sock = null;
  try {
    await pub.listening;
    await new Promise((r) => { polled = r; }); // the baseline poll
    polled = null;
    rows.now = [row('w1', { turns: 1, seq: 3, last_event_age_ms: 10 }), row('idle', { turns: 0, seq: 2 })];
    const got = new Promise((resolve) => {
      let buf = '';
      sock = net.connect(pipe);
      sock.on('error', () => {});
      sock.on('data', (d) => { buf += d.toString('utf8'); for (const l of buf.split('\n')) { try { const j = JSON.parse(l); if (j.id) resolve(j); } catch { /* partial */ } } });
    });
    const w = await got;
    assert.strictEqual(w.text, wakeText({ worker_id: 'w1', event: 'turn_end', turn: 1 }), 'the wake is the plain text, with no idle clause');
    assert.ok(Buffer.byteLength(w.text, 'utf8') <= WAKE_TEXT_MAX);
  } finally {
    for (const [k, v] of [['BELAY_TEST_MODE', saved.mode], ['BELAY_IDLE_REMIND_MS', saved.ms]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (sock) sock.destroy();
    await pub.stop();
  }
});

test('the headless orchestrator writes the plain wake to its stdin, with no idle clause', { timeout: 60000 }, async () => {
  const os = require('node:os');
  const { runOrchestrator } = require('../../src/run/orchestrator.cjs');
  const { createFakeCore } = require('./fake-core.cjs');
  const fwd = (p) => String(p).split(path.sep).join('/');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-idle-headless-'));
  const sb = { worktree: fwd(path.join(root, 'wt')), dataDir: fwd(path.join(root, '.belay')), orchestratorDir: fwd(path.join(root, 'orch')) };
  fs.mkdirSync(sb.worktree, { recursive: true });
  fs.mkdirSync(sb.dataDir, { recursive: true });
  const core = createFakeCore();
  // w1 has finished turn 1 just now; `idle` has sat between turns for a minute and holds no lease.
  core.worker = { ...core.worker, list: async () => ({ workers: [
    { id: 'w1', run_id: RUN, state: 'running', turns: 1, seq: 2, pid: process.pid, pid_alive: true, mid_turn: 0, last_event_age_ms: 5 },
    { id: 'idle', run_id: RUN, state: 'running', turns: 0, seq: 1, pid: process.pid, pid_alive: true, mid_turn: 0, last_event_age_ms: 60000 },
  ] }) };
  core.task = { ...(core.task || {}), list: async () => ({ tasks: [] }) };
  const saved = { exe: process.env.BELAY_CLAUDE_EXE, mode: process.env.BELAY_TEST_MODE, ms: process.env.BELAY_IDLE_REMIND_MS };
  process.env.BELAY_CLAUDE_EXE = FAKE; process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_IDLE_REMIND_MS = '1000';
  try {
    const out = await runOrchestrator({ core, runId: RUN, dataDir: sb.dataDir, onAttached: async () => ({ ok: true }), spec: {
      worktree: sb.worktree, promptText: 'hello', orchestratorDir: sb.orchestratorDir, model: 'claude-sonnet-5', allowedTools: null,
      startupTimeoutMs: 8000, timeoutMs: 30000, mcpToolTimeoutMs: 60000, pollMs: 50, closeGraceMs: 3000,
    } });
    const w1 = out.wakes.filter((w) => w.worker_id === 'w1');
    assert.strictEqual(w1.length, 1, JSON.stringify(out.wakes));
    const plain = wakeText({ worker_id: 'w1', event: 'turn_end', turn: 1 });
    assert.strictEqual(w1[0].bytes, Buffer.byteLength(plain, 'utf8'), 'the wake written to stdin is the plain text');
    assert.ok(w1[0].bytes <= WAKE_TEXT_MAX);
  } finally {
    for (const [k, v] of [['BELAY_CLAUDE_EXE', saved.exe], ['BELAY_TEST_MODE', saved.mode], ['BELAY_IDLE_REMIND_MS', saved.ms]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    cleanup(root);
  }
});

test('a worker_wait that times out still names the idle worker with no task', { timeout: 90000 }, async () => {
  const dir = sandbox();
  const core = await openCore({ dataDir: dir, caller: callerFor('orchestrator', { run_id: RUN }), embed: false });
  const wt = path.join(dir, 'wt');
  fs.mkdirSync(wt, { recursive: true });
  const gate = path.join(dir, 'gate').split(path.sep).join('/');
  const saved = { mode: process.env.BELAY_TEST_MODE, ms: process.env.BELAY_IDLE_REMIND_MS, gate: process.env.FAKE_ANSWER_GATE_FILE };
  let m = null;
  try {
    await core.run.attach({ adapter_pid: process.pid });
    m = createRunManager({ core: core.harness(), dataDir: dir, runId: RUN, paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
    const opts = { substrate: 'claude-code', worktree: wt.split(path.sep).join('/'), prompt: 'one' };
    await m.spawn({ ...opts, worker_id: 'free' });
    await m.wait({ worker_ids: ['free'], timeout_ms: 30000 });
    process.env.FAKE_ANSWER_GATE_FILE = gate; // `busy` holds its first turn open until the gate file exists
    await m.spawn({ ...opts, worker_id: 'busy' });
    process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_IDLE_REMIND_MS = '0';
    const ans = await m.wait({ worker_ids: ['busy'], timeout_ms: 200 });
    assert.deepStrictEqual([ans.timed_out, ans.idle_without_task], [true, ['free']], JSON.stringify(ans));
  } finally {
    fs.writeFileSync(gate, 'go');
    for (const [k, v] of [['BELAY_TEST_MODE', saved.mode], ['BELAY_IDLE_REMIND_MS', saved.ms], ['FAKE_ANSWER_GATE_FILE', saved.gate]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (m) { try { await m.shutdown(); } catch { /* best effort */ } }
    try { await core.shutdownOwner(); } catch { /* best effort */ }
    await core.close();
    cleanup(dir);
  }
});
