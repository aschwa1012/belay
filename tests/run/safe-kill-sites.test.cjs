'use strict';
// safe-kill-sites.test.cjs — ADR 0039 decision 4 on the run side. At each site that used to kill a pid it
// read from a row or kept after the child's exit, a DIFFERENT live process (a sleeper this test spawned)
// holds the pid, planted with a creation time that is not its own. The kill must refuse and the sleeper must
// survive. Every sleeper is stopped through its own handle.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { createRunManager } = require('../../src/run/index.cjs');
const { createStopControl } = require('../../src/run/stop.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const PI = require('../../src/run/pid-identity.cjs');
const P = require('../../src/run/process.cjs');
const { cleanup } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');
const USER_SETTINGS = path.join(__dirname, 'fixtures', 'user-settings.json').replace(/\\/g, '/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sleeper = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { windowsHide: true, stdio: 'ignore' });
const running = (c) => c.exitCode === null && c.signalCode === null;
const WRONG_CREATED = 1; // 1970: no live process was created then

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-safekill-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { data: d.replace(/\\/g, '/'), worktree: path.join(d, 'wt').replace(/\\/g, '/') };
}
const mgr = (sb, core) => createRunManager({ core, dataDir: sb.data, runId: 'run-sk', paths: { claudeExe: FAKE, userSettings: USER_SETTINGS } });
const planted = (s, extra = {}) => ({ id: 'w-planted', run_id: 'run-sk', substrate: 'claude-code', pid: s.pid, pid_created: WRONG_CREATED, state: 'running', session_id: 'sess-1', worktree: null, started_at: Date.now(), turns: 1, ...extra });

test('manager.stop on an adopted worker whose pid another process now holds refuses the kill and the bystander survives', async () => {
  const sb = sandbox(); const core = createFakeCore(); const m = mgr(sb, core); const s = sleeper();
  try {
    await core.worker.write(planted(s, { worktree: sb.worktree }));
    const r = await m.stop({ worker_id: 'w-planted', mode: 'kill', timeout_ms: 3000 });
    assert.strictEqual(r.killed, false, 'the kill was refused, so the receipt must not say it killed');
    assert.strictEqual(r.refused, 'identity');
    assert.ok(r.tree_kill && r.tree_kill.refused === 'identity', JSON.stringify(r.tree_kill));
    await sleep(300);
    assert.strictEqual(running(s), true, 'the bystander holding the pid must still be running');
  } finally { s.kill(); await m.shutdown(); cleanup(sb.data); }
});

test('manager.restart of an adopted record whose pid another process holds refuses the orphan kill and the bystander survives', async () => {
  const sb = sandbox(); const core = createFakeCore(); const m = mgr(sb, core); const s = sleeper();
  try {
    await core.worker.write(planted(s, { worktree: sb.worktree, last_event_at: Date.now() }));
    await m.restart({ worker_id: 'w-planted', first_turn_timeout_ms: 8000 }).catch(() => null);
    assert.strictEqual(running(s), true, 'the bystander holding the old pid must still be running');
    const w = m._worker('w-planted');
    assert.ok(w.adoptedKill && w.adoptedKill.refused === 'identity', JSON.stringify(w.adoptedKill));
  } finally { s.kill(); await m.shutdown(); cleanup(sb.data); }
});

test('killWorker: a record with a wrong creation time, or whose child already exited, refuses and kills nothing', async () => {
  const s = sleeper();
  try {
    const adopted = await PI.killWorker({ pid: s.pid, pidCreated: WRONG_CREATED, substrate: 'claude-code', child: null });
    assert.strictEqual(adopted.refused.refused, 'identity', JSON.stringify(adopted));
    const spent = await PI.killWorker({ pid: s.pid, pidCreated: null, substrate: 'codex', child: { pid: s.pid, exitCode: 0, signalCode: null } });
    assert.strictEqual(spent.refused.refused, 'identity', JSON.stringify(spent));
    const noTime = await PI.killWorker({ pid: s.pid, pidCreated: null, substrate: 'codex', child: null });
    assert.strictEqual(noTime.tree.refused, 'identity', 'a null pid_created is never tree-killed');
    assert.strictEqual(noTime.refused.refused, 'identity', 'and the single kill needs the expected image (codex.exe), not node.exe');
    await sleep(200);
    assert.strictEqual(running(s), true);
  } finally { s.kill(); }
});

test('belay stop: the worker phase refuses to kill a row whose pid another process holds, and reports the refusal', async () => {
  const s = sleeper();
  try {
    const row = { id: 'w1', run_id: 'r1', state: 'running', substrate: 'claude-code', pid: s.pid, pid_created: WRONG_CREATED, pid_alive: true, seq: 1, exit_code: null, exit_signal: null, death_established_by: null, mid_turn: 0 };
    const core = { worker: { list: async () => ({ workers: [row] }) } };
    const sc = createStopControl({ runId: 'r1', core, closeGraceMs: 300 });
    sc.attach({ pid: 1, exited: () => null, stop: async () => ({ pid: 1, exit_code: 0, exit_signal: null, killed_after_close: false, ended_by: 'test' }) });
    const res = await sc.handle({ run_id: 'r1', caller: { pid: process.pid } });
    const killed = res.workers[0].killed;
    assert.strictEqual(killed.refused, 'identity', JSON.stringify(killed));
    assert.strictEqual(killed.pid.signalled, false);
    await sleep(200);
    assert.strictEqual(running(s), true);
  } finally { s.kill(); }
});

test('park: a snapshotted descendant whose identity no longer matches is refused, not killed, and the receipt names it', async () => {
  const sb = sandbox(); const core = createFakeCore(); const m = mgr(sb, core); const bystander = sleeper();
  const saved = { dt: P.descendantTargets, cp: P.childPids };
  process.env.FAKE_ANSWER_DELAY_MS = '8000';
  try {
    // The pid a descendant snapshot named is, by the time of the kill, another process (the bystander).
    P.descendantTargets = async () => [{ pid: bystander.pid, created: WRONG_CREATED, image: 'node.exe' }];
    P.childPids = async () => [bystander.pid];
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1' });
    await sleep(300);
    const r = await m.pause({ worker_id: 'w1', by: 'operator:1' });
    assert.strictEqual(r.paused, true);
    assert.deepStrictEqual(r.descendants.killed_after_exit, []);
    assert.deepStrictEqual(r.descendants.refused_after_exit.map((d) => d.pid), [bystander.pid]);
    assert.strictEqual(running(bystander), true, 'the process that took over the pid must survive the park');
  } finally {
    P.descendantTargets = saved.dt; P.childPids = saved.cp; delete process.env.FAKE_ANSWER_DELAY_MS;
    bystander.kill(); await m.shutdown(); cleanup(sb.data);
  }
});

test('failNoReady and killSurvivor kill only through the live child handle: a settled record is never killed by its pid', async () => {
  const s = sleeper();
  try {
    // killSurvivor's own guard is `ours`; its kill is P.killProcess(w.child). A handle that exited refuses even if the pid is held.
    const r = await P.killProcess({ pid: s.pid, exitCode: 0, signalCode: null });
    assert.strictEqual(r.refused.refused, 'identity');
    assert.strictEqual(running(s), true);
  } finally { s.kill(); }
});
