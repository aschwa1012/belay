'use strict';
// `worker stop` of an adopted worker whose kill was sent (not refused) but whose pid is still alive at the wait's deadline
// must not report a stop: the receipt says not_stopped / may_be_live, killed is false, and no terminal row is written.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createRunManager } = require('../../src/run/index.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs');
const USER_SETTINGS = path.join(__dirname, 'fixtures', 'user-settings.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const running = (c) => c.exitCode === null && c.signalCode === null;

test('a stop whose kill was sent but left the pid alive is reported as not stopped, with the pid named', async () => {
  const PI = require('../../src/run/pid-identity.cjs');
  const P = require('../../src/run/process.cjs');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-ksa-'));
  const wt = path.join(d, 'wt'); fs.mkdirSync(wt, { recursive: true });
  const data = d.replace(/\\/g, '/');
  const core = createFakeCore();
  const m = createRunManager({ core, dataDir: data, runId: 'run-ksa', paths: { claudeExe: FAKE, userSettings: USER_SETTINGS } });
  const s = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { windowsHide: true, stdio: 'ignore' });
  const realKill = PI.killWorker; const realWait = P.waitPidGone;
  // The kill seam ignores the kill (answers "not refused"), and the wait is cut to its deadline answer.
  PI.killWorker = async () => ({ tree: null, pidKill: { signalled: true }, identity: null, refused: null });
  P.waitPidGone = async () => null;
  try {
    await core.worker.write({ id: 'w-k', run_id: 'run-ksa', substrate: 'claude-code', pid: s.pid, state: 'running', session_id: 'sess-1', worktree: wt.replace(/\\/g, '/'), started_at: Date.now(), turns: 1, last_event_at: Date.now(), pid_created: null });
    const r = await m.stop({ worker_id: 'w-k', mode: 'kill', timeout_ms: 2000 });
    assert.strictEqual(r.killed, false, 'a kill that left the pid alive is not a kill');
    assert.strictEqual(r.not_stopped, true);
    assert.strictEqual(r.may_be_live, true);
    assert.match(r.note, new RegExp(`the kill was sent but pid ${s.pid} is still running`));
    assert.strictEqual(r.row_state, 'running', 'the row goes back to its prior state, not a terminal one');
    await sleep(100);
    assert.strictEqual(running(s), true);
  } finally { PI.killWorker = realKill; P.waitPidGone = realWait; s.kill(); await m.shutdown(); cleanup(data); }
});

test('a stop whose wait times out while another process holds the pid (a different creation time) is a stop', async () => {
  const PI = require('../../src/run/pid-identity.cjs');
  const P = require('../../src/run/process.cjs');
  const ID = require('../../src/core/proc-identity.cjs');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-ksb-'));
  const wt = path.join(d, 'wt'); fs.mkdirSync(wt, { recursive: true });
  const data = d.replace(/\\/g, '/');
  const core = createFakeCore();
  const m = createRunManager({ core, dataDir: data, runId: 'run-ksb', paths: { claudeExe: FAKE, userSettings: USER_SETTINGS } });
  const s = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { windowsHide: true, stdio: 'ignore' });
  const realKill = PI.killWorker; const realWait = P.waitPidGone; const realSnap = ID.snapshotShared;
  // The kill was identity-proven and sent; the bare-pid wait reaches its deadline because the pid now belongs to another process.
  PI.killWorker = async () => ({ tree: null, pidKill: { signalled: true }, identity: { via: 'created' }, refused: null });
  P.waitPidGone = async () => null;
  ID.snapshotShared = async () => ({ snap: new Map([[s.pid, { created: 222, image: 'node.exe', ppid: 1 }]]), startSeq: Infinity });
  try {
    await core.worker.write({ id: 'w-k', run_id: 'run-ksb', substrate: 'claude-code', pid: s.pid, state: 'running', session_id: 'sess-1', worktree: wt.replace(/\\/g, '/'), started_at: Date.now(), turns: 1, last_event_at: Date.now(), pid_created: 111 });
    const r = await m.stop({ worker_id: 'w-k', mode: 'kill', timeout_ms: 2000 });
    assert.strictEqual(r.killed, true, JSON.stringify(r));
    assert.ok(!r.not_stopped && !r.may_be_live, 'a reused pid is not the worker alive');
  } finally { PI.killWorker = realKill; P.waitPidGone = realWait; ID.snapshotShared = realSnap; s.kill(); await m.shutdown(); cleanup(data); }
});
