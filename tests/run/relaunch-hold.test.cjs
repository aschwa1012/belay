'use strict';
// relaunch-hold.test.cjs — a worker launched again (restart, resume, a Codex turn) is first checked with the core: its task's
// files are held for this run, or nothing is launched (ADR 0046 decision 1). The fake core refuses task.ensureHold the way the
// real one refuses an overlap with another run's holding task, and the tests assert that no process started and no row was
// written, then that the same call goes through once the core allows it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRunManager } = require('../../src/run/index.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').split(path.sep).join('/');
const FAKE_CODEX = path.join(__dirname, 'fakes', 'fake-codex.cjs').split(path.sep).join('/');
const SLOW = 45000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-relaunch-hold-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { data: d.split(path.sep).join('/'), worktree: path.join(d, 'wt').split(path.sep).join('/') };
}
const mgr = (sb, core, exe = FAKE) => createRunManager({
  core, dataDir: sb.data, runId: 'run-hold-test',
  paths: { claudeExe: exe, codexExe: exe, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') },
});
const REFUSED = (e) => { assert.strictEqual(e.code, 'E_FILES_OVERLAP'); return true; };

test('restart of an adopted worker asks the core first, and a refusal launches nothing and writes no row', async () => {
  const sb = sandbox();
  const failing = {};
  const core = createFakeCore({ failing });
  const first = mgr(sb, core);
  const second = mgr(sb, core);
  try {
    const born = await first.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w-r', task_id: 't-r' });
    await first._waitTurn('w-r', SLOW);
    await first.stop({ worker_id: 'w-r', mode: 'kill', timeout_ms: 8000 });
    const rows = core.rowsFor('w-r').length;
    failing['task.ensureHold'] = 'E_FILES_OVERLAP';
    await assert.rejects(second.restart({ worker_id: 'w-r', first_turn_timeout_ms: SLOW }), REFUSED);
    assert.strictEqual(core.rowsFor('w-r').length, rows, 'a refused restart wrote no worker row');
    assert.strictEqual(core.currentWorker('w-r').pid, born.pid, 'and started no process');
    assert.deepStrictEqual(core.callsTo('task.ensureHold').length, 0, 'the refused call is not a recorded success');
    delete failing['task.ensureHold'];
    const r = await second.restart({ worker_id: 'w-r', first_turn_timeout_ms: SLOW });
    assert.ok(r.new_pid > 0 && r.new_pid !== born.pid);
    assert.deepStrictEqual(core.callsTo('task.ensureHold').map((c) => c.args), [{ task_id: 't-r', worker_id: 'w-r' }]);
  } finally {
    await second.shutdown().catch(() => {}); await first.shutdown().catch(() => {}); cleanup(sb.data);
  }
});

test('resume of a parked worker asks the core first, and a refusal leaves it parked with no process started', async () => {
  const sb = sandbox();
  const failing = {};
  const core = createFakeCore({ failing });
  const m = mgr(sb, core);
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w-p', task_id: 't-p' });
    await sleep(300);
    await m.pause({ worker_id: 'w-p', by: 'operator:1' });
    const rows = core.rowsFor('w-p').length;
    assert.strictEqual(core.currentWorker('w-p').state, 'paused');
    failing['task.ensureHold'] = 'E_FILES_OVERLAP';
    await assert.rejects(m.resume({ worker_id: 'w-p', by: 'operator:2' }), REFUSED);
    assert.strictEqual(core.rowsFor('w-p').length, rows, 'a refused resume wrote no worker row');
    assert.strictEqual(core.currentWorker('w-p').state, 'paused');
    delete failing['task.ensureHold'];
    const r = await m.resume({ worker_id: 'w-p', by: 'operator:2' });
    assert.strictEqual(r.resumed, true);
    assert.strictEqual(core.callsTo('task.ensureHold').length, 1);
  } finally {
    await m.shutdown().catch(() => {}); cleanup(sb.data);
  }
});

test('a Codex turn asks the core first, and a refusal sends no turn', async () => {
  const sb = sandbox();
  const failing = {};
  const core = createFakeCore({ failing });
  const m = mgr(sb, core, FAKE_CODEX);
  try {
    await m.spawn({ substrate: 'codex', worktree: sb.worktree, prompt: 'one', worker_id: 'w-c', task_id: 't-c' });
    await m._waitTurn('w-c', SLOW);
    const w = m._worker('w-c');
    const t0 = Date.now();
    while (!w.settled && Date.now() - t0 < 10000) await sleep(20);
    await w.queue;
    const rows = core.rowsFor('w-c').length, launches = w.launches;
    failing['task.ensureHold'] = 'E_FILES_OVERLAP';
    await assert.rejects(m.message({ worker_id: 'w-c', text: 'again' }), REFUSED);
    assert.strictEqual(core.rowsFor('w-c').length, rows);
    assert.strictEqual(w.launches, launches, 'no second process');
    delete failing['task.ensureHold'];
    const r = await m.message({ worker_id: 'w-c', text: 'again' });
    assert.strictEqual(r.channel, 'codex-resume');
    assert.strictEqual(w.launches, launches + 1);
  } finally {
    await m.shutdown().catch(() => {}); cleanup(sb.data);
  }
});
