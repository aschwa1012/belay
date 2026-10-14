'use strict';
// relaunch-restate.test.cjs — a relaunched worker's rows never carry the last process's end. About a second after
// each launch the process's creation time is read and the current row restated with it (ADR 0039). The restatement
// wrote `w.settledState || w.state`, and settledState (the last process's paused, stopped or dead) was never cleared
// on relaunch: a resumed worker's row read `paused` again with its new live pid, and messages were refused E_PAUSED.
// Each case waits for that restatement itself, then checks the stored row and that the worker still takes a message.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRunManager } = require('../../src/run/index.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-restate-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { data: d.replace(/\\/g, '/'), worktree: path.join(d, 'wt').replace(/\\/g, '/') };
}
function mgr(sb, core) {
  return createRunManager({
    core, dataDir: sb.data, runId: 'run-restate-test',
    paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') },
  });
}
async function until(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 20)); }
  return false;
}

// Relaunches w1 with `relaunch`, then waits for the new process's creation-time restatement and checks it.
async function relaunchAndCheck(name, end, relaunch) {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1' });
    assert.strictEqual((await m.wait({ worker_ids: ['w1'], timeout_ms: 8000 })).timed_out, false);
    await end(m);
    const r = await relaunch(m);
    const newPid = r.new_pid;
    const w = m._worker('w1');
    // The restatement is the row that first carries the new process's creation time.
    const restated = await until(() => core.rowsFor('w1').some((row) => row.pid === newPid && row.pid_created != null), 15000);
    assert.ok(restated, `${name}: the creation-time restatement for pid ${newPid} never landed`);
    await w.queue;
    const rows = core.rowsFor('w1').filter((row) => row.pid === newPid);
    const states = rows.map((row) => row.state);
    assert.ok(!states.some((s) => s === 'paused' || s === 'stopped' || s === 'dead'),
      `${name}: a row for the live pid ${newPid} carried the last process's end: ${JSON.stringify(states)}`);
    assert.strictEqual(w.state, 'running', `${name}: the record reads ${w.state}`);
    const sent = await m.message({ worker_id: 'w1', text: 'two' });
    assert.strictEqual(sent.channel, 'stdin');
  } finally {
    try { await m.shutdown(); } catch { /* best effort */ }
    cleanup(sb.data);
  }
}

test('a resumed worker is never restated paused after its relaunch', async () => {
  await relaunchAndCheck('resume', (m) => m.pause({ worker_id: 'w1', by: 'operator:1' }),
    (m) => m.resume({ worker_id: 'w1', by: 'operator:1' }));
});

test('a worker restarted after a stop is never restated stopped after its relaunch', async () => {
  await relaunchAndCheck('restart', (m) => m.stop({ worker_id: 'w1' }),
    (m) => m.restart({ worker_id: 'w1', first_turn_timeout_ms: 8000 }));
});
