'use strict';
// stop-background.test.cjs — a graceful stop first stops the worker's open background tasks (as a park does), so a worker that a
// hung background shell keeps alive after stdin closes still exits gracefully; a stop that has to kill says why and names the
// processes it killed. A real RunManager over the fake executable (FAKE_BG_BLOCKS_EXIT: no exit on stdin close while a task runs).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRunManager } = require('../../src/run/index.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').split(path.sep).join('/');
const fwd = (p) => p.split(path.sep).join('/');

async function withWorker(env, fn) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-stopbg-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  const saved = {};
  for (const [k, v] of Object.entries({ FAKE_BG_TASK: '1', FAKE_BG_TASK_MS: '600000', FAKE_BG_BLOCKS_EXIT: '1', ...env })) { saved[k] = process.env[k]; process.env[k] = v; }
  const m = createRunManager({ core: createFakeCore(), dataDir: fwd(d), runId: 'run-stopbg', paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
  try {
    await m.spawn({ substrate: 'claude-code', worktree: fwd(path.join(d, 'wt')), prompt: 'one', worker_id: 'w1' });
    await m._waitTurn('w1', 8000);
    assert.strictEqual(m._worker('w1').bgTasks.size, 1, 'the worker holds one open background task');
    return await fn(m);
  } finally {
    try { await m.shutdown(); } catch { /* best effort */ }
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    cleanup(fwd(d));
  }
}

test('a worker holding an open background task stops gracefully: the task is stopped before stdin closes', { timeout: 60000 }, async () => {
  await withWorker({}, async (m) => {
    const r = await m.stop({ worker_id: 'w1', timeout_ms: 10000 });
    assert.strictEqual(r.graceful, true, JSON.stringify(r));
    assert.strictEqual(r.killed, false);
    assert.deepStrictEqual(r.background_tasks_stopped.map((t) => t.status_after), ['killed']);
    assert.ok(!('blocked_by' in r) && !('graceful_timed_out_ms' in r));
  });
});

test('a stop that still times out says why and names the processes it killed', { timeout: 60000 }, async () => {
  await withWorker({ FAKE_STOP_TASK_UNSUPPORTED: '1' }, async (m) => {
    const pid = m._worker('w1').pid;
    const r = await m.stop({ worker_id: 'w1', timeout_ms: 1500 });
    assert.strictEqual(r.graceful, false, JSON.stringify(r));
    assert.strictEqual(r.killed, true);
    assert.ok(r.graceful_timed_out_ms >= 1400, String(r.graceful_timed_out_ms));
    assert.ok(r.graceful_timed_out_ms < 2000, `the background phase comes out of timeout_ms, not on top of it: ${r.graceful_timed_out_ms}`);
    assert.deepStrictEqual(r.blocked_by.map((t) => t.task_id), ['bgtask_1']);
    assert.ok(r.blocked_by[0].description, 'the task is described');
    const k = r.killed_processes.find((p) => p.pid === pid);
    assert.ok(k, `the worker's pid ${pid} is named in ${JSON.stringify(r.killed_processes)}`);
    assert.ok(k.image, 'with its image from the snapshot taken before the kill');
  });
});
