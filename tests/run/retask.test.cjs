'use strict';
// retask.test.cjs — a task_assign to a running worker moves the run manager's record of the worker's task (manager.retask), so a
// restart, a park-resume and the worker's rows use the task it holds now, not the one it was spawned for.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRunManager } = require('../../src/run/index.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').split(path.sep).join('/');

async function withWorker(fn) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-retask-')).split(path.sep).join('/');
  const worktree = `${data}/wt`;
  fs.mkdirSync(worktree, { recursive: true });
  const core = createFakeCore({ runId: 'run-rt' });
  const m = createRunManager({ core, dataDir: data, runId: 'run-rt', paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
  try {
    await m.spawn({ substrate: 'claude-code', worktree, prompt: 'go', worker_id: 'w1', task_id: 't1' });
    await m._waitTurn('w1', 8000);
    await fn({ m, core });
  } finally { await m.shutdown(); cleanup(data); }
}

test('retask follows a task_assign: the worker record names the new task, and a worker not launched here is left alone', async () => {
  await withWorker(async ({ m }) => {
    assert.strictEqual(m.retask({ worker_id: 'nobody', task_id: 't2' }), false);
    assert.strictEqual(m.retask({ worker_id: 'w1', task_id: 't2', spec: 'second', rule: '\n\nRULE2' }), true);
    const w = m._worker('w1');
    assert.deepStrictEqual([w.taskId, w.taskSpec, w.handbackRule, w.review], ['t2', 'second', '\n\nRULE2', null]);
  });
});

test('reassigned, then restarted: the relaunch holds the new task\'s lease, not the old one\'s', async () => {
  await withWorker(async ({ m, core }) => {
    m.retask({ worker_id: 'w1', task_id: 't2' });
    const seen = core.callsTo('task.ensureHold').length;
    await m.restart({ worker_id: 'w1' });
    const holds = core.callsTo('task.ensureHold').slice(seen).map((c) => c.args.task_id);
    assert.deepStrictEqual(holds, ['t2']);
  });
});

test('reassigned, then the process dies: the worker rows name the new task', async () => {
  await withWorker(async ({ m, core }) => {
    m.retask({ worker_id: 'w1', task_id: 't2' });
    await m.stop({ worker_id: 'w1' });
    const last = core.rowsFor('w1').pop();
    assert.strictEqual(last.task_id, 't2');
  });
});

test('reassigned, then parked and resumed: the resume line is the new task\'s', async () => {
  await withWorker(async ({ m, core }) => {
    m.retask({ worker_id: 'w1', task_id: 't2' });
    await m.pause({ worker_id: 'w1', by: 'operator:1' });
    const seen = core.callsTo('continuity.resumeLine').length;
    await m.resume({ worker_id: 'w1', by: 'operator:1' });
    const asked = core.callsTo('continuity.resumeLine').slice(seen).map((c) => c.args.task_id).filter(Boolean);
    assert.ok(asked.length && asked.every((t) => t === 't2'), JSON.stringify(asked));
  });
});
