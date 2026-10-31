'use strict';
// restart of an adopted worker whose old process cannot be proven (no creation time at spawn, or no time and the wrong image)
// must refuse and launch nothing: a second process on the same session would race the one that may still be running.
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
const sleeper = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { windowsHide: true, stdio: 'ignore' });
const running = (c) => c.exitCode === null && c.signalCode === null;

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-unv-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { data: d.replace(/\\/g, '/'), worktree: path.join(d, 'wt').replace(/\\/g, '/') };
}

for (const variant of ['pid_created_error', 'pid_created_null_wrong_image']) {
  test(`restart of an adopted worker, ${variant}, refuses and launches nothing`, async () => {
    const sb = sandbox(); const core = createFakeCore();
    const m = createRunManager({ core, dataDir: sb.data, runId: 'run-unv', paths: { claudeExe: FAKE, userSettings: USER_SETTINGS } });
    const s = sleeper();
    try {
      const extra = variant === 'pid_created_error' ? { pid_created: null, pid_created_error: 'the process snapshot was unreadable at spawn' } : { pid_created: null };
      await core.worker.write({ id: 'w-p', run_id: 'run-unv', substrate: 'claude-code', pid: s.pid, state: 'running', session_id: 'sess-1', worktree: sb.worktree, started_at: Date.now(), turns: 1, last_event_at: Date.now(), ...extra });
      let err = null; let r = null;
      try { r = await m.restart({ worker_id: 'w-p', first_turn_timeout_ms: 8000 }); } catch (e) { err = e; }
      assert.strictEqual(r, null, `restart must not return a receipt: ${JSON.stringify(r && { old_pid: r.old_pid, new_pid: r.new_pid })}`);
      assert.ok(err, 'restart must refuse');
      assert.strictEqual(err.code, 'E_PRECONDITION');
      assert.match(err.message, new RegExp(`pid ${s.pid}`));
      assert.match(err.message, /could not be proven/);
      assert.match(err.message, /nothing was launched/);
      assert.strictEqual(err.detail && err.detail.old_process_may_be_live, true);
      const w = m._worker('w-p');
      assert.ok(!w.child, 'no new process was launched');
      assert.strictEqual(w.pid, s.pid, 'the record still names the old pid');
      await sleep(200);
      assert.strictEqual(running(s), true, 'the unproven old process was not touched');
    } finally { s.kill(); await m.shutdown(); cleanup(sb.data); }
  });
}

test('restart of an adopted worker whose kill was sent but did not end the process refuses and launches nothing', async () => {
  const PI = require('../../src/run/pid-identity.cjs');
  const P = require('../../src/run/process.cjs');
  const sb = sandbox(); const core = createFakeCore();
  const m = createRunManager({ core, dataDir: sb.data, runId: 'run-unv', paths: { claudeExe: FAKE, userSettings: USER_SETTINGS } });
  const s = sleeper();
  const realKill = PI.killWorker; const realWait = P.waitPidGone;
  // The kill seam ignores the kill: the answer is "not refused", and the sleeper stays alive. The wait is cut to its deadline.
  PI.killWorker = async () => ({ tree: null, pidKill: { signalled: true }, identity: null, refused: null });
  P.waitPidGone = async () => null;
  try {
    await core.worker.write({ id: 'w-p', run_id: 'run-unv', substrate: 'claude-code', pid: s.pid, state: 'running', session_id: 'sess-1', worktree: sb.worktree, started_at: Date.now(), turns: 1, last_event_at: Date.now(), pid_created: null });
    let err = null; let r = null;
    try { r = await m.restart({ worker_id: 'w-p', first_turn_timeout_ms: 8000 }); } catch (e) { err = e; }
    assert.strictEqual(r, null, 'restart must not return a receipt');
    assert.ok(err, 'restart must refuse');
    assert.strictEqual(err.code, 'E_PRECONDITION');
    assert.match(err.message, /did not end after the kill was sent/);
    assert.match(err.message, /nothing was launched/);
    assert.strictEqual(err.detail.kill_sent, true);
    assert.strictEqual(err.detail.old_process_may_be_live, true);
    assert.ok(!m._worker('w-p').child, 'no new process was launched');
    await sleep(100);
    assert.strictEqual(running(s), true);
  } finally { PI.killWorker = realKill; P.waitPidGone = realWait; s.kill(); await m.shutdown(); cleanup(sb.data); }
});
