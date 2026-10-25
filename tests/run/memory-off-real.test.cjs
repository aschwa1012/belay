'use strict';
// memory-off-real.test.cjs — memory-off-identity.test.cjs on the real store. One scripted worker turn pair runs through
// the run manager with every memory lever off, against the real core on the harness view, and the rows and events it
// leaves are compared by column with what the lever-off path wrote before ADR 0044: written_by differs, and the turn row
// now names the worker that took the turn, its number and the task of the lease it held (it read as the orchestrator's,
// with no task and no turn). The only stand-in is a fixed vector on each store, so no embedding model is needed.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { openCore } = require('../../src/core/index.cjs');
const { sandbox, cleanup, callerFor } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').split(path.sep).join('/');

// The columns of a lever-off turn row before the writer column existed, with the worker's own id in worker_id (it was
// 'orchestrator', as last_writer_id was, which the store sets from it). text and title carry the fake's echo.
const BEFORE = {
  namespace: 'run/test-run', worker_id: 'w1', last_writer_id: 'w1', type: 'turn',
  tags: ['w1', 'turn:1'], provenance: 'worker:w1', supersedes: null, ttl_at: null,
  status: 'unverified', status_receipt: null, status_by: null, status_at: null,
  run_id: 'test-run', task_id: null, turn: null, source: 'model', redactions: null,
};

// `script` drives the manager; `check` reads the store once the manager has shut down, which awaits every turn write.
async function withRun(script, check) {
  const dir = sandbox();
  const core = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  const saved = process.env.FAKE_TOOL_USES;
  process.env.FAKE_TOOL_USES = '0';
  try {
    await core.run.attach({ adapter_pid: process.pid });
    const h = core.harness();
    // the base path stores with the embedder; this fixed vector is the only difference from it
    const view = Object.create(h, { memory: { value: { ...h.memory, store: (a) => h.memory.store({ ...a, embedding: [1, 0], embedding_model: 'fixed', dim: 2 }) } } });
    const wt = path.join(dir, 'wt');
    fs.mkdirSync(wt, { recursive: true });
    const m = createRunManager({ core: view, dataDir: dir, runId: 'test-run', paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
    let made;
    try { made = await script({ core, m, wt: wt.split(path.sep).join('/') }); } finally { try { await m.shutdown(); } catch { /* best effort */ } }
    await check({ core, made });
  } finally {
    if (saved === undefined) delete process.env.FAKE_TOOL_USES; else process.env.FAKE_TOOL_USES = saved;
    try { await core.shutdownOwner(); } catch { /* best effort */ }
    await core.close();
    cleanup(dir);
  }
}

const turnRows = async (core) => (await core.memory.list({ namespace: 'run/test-run', view: 'full', order: 'oldest', limit: 50 })).rows;

test('levers off on the real store: the rows and events are those of the lever-off path, written_by and the worker apart', { timeout: 60000 }, () => withRun(async ({ m, wt }) => {
  await m.spawn({ substrate: 'claude-code', worktree: wt, prompt: 'one', worker_id: 'w1' });
  await m._waitTurn('w1', 8000);
  await m.message({ worker_id: 'w1', text: 'two' });
  await m._waitTurn('w1', 8000);
}, async ({ core }) => {
  const rows = await turnRows(core);
  assert.strictEqual(rows.length, 2, 'one turn row per turn, and nothing else');
  rows.forEach((r, i) => {
    const { id, text, title, created_at, updated_at, text_hash, written_by, ...cols } = r;
    assert.deepStrictEqual(cols, { ...BEFORE, tags: ['w1', `turn:${i + 1}`], turn: i + 1 }, 'no task held: task_id stays null');
    assert.match(text, /^echo: /);
    assert.strictEqual(title, text.split('\n')[0]);
    assert.strictEqual(written_by, 'harness', 'the writer column');
  });
  const events = await core.memory.events({});
  assert.deepStrictEqual(events.events, [], 'no memory_event with every lever off');
}));

test('a turn row carries the task of the lease its worker held at the turn\'s end: spawned with it, or given it later by assign', { timeout: 60000 }, () => withRun(async ({ core, m, wt }) => {
  const t1 = await core.task.create({ spec: 'first' });
  const t2 = await core.task.create({ spec: 'second' });
  await m.spawn({ substrate: 'claude-code', worktree: wt, prompt: 'one', worker_id: 'w1', task_id: t1.id });
  await m._waitTurn('w1', 8000);
  // The worker's first task is released, and it is given another by assign: its spawn-time task is no longer its work.
  const l1 = (await core.task.get({ task_id: t1.id })).lease;
  await core.task.cancel({ task_id: t1.id, reason: 'moved on' });
  await core.task.assign({ task_id: t2.id, worker_id: 'w1' });
  await m.message({ worker_id: 'w1', text: 'two' });
  await m._waitTurn('w1', 8000);
  return { t1, t2, l1 };
}, async ({ core, made: { t1, t2, l1 } }) => {
  const rows = await turnRows(core);
  assert.deepStrictEqual(rows.map((r) => [r.worker_id, r.turn, r.task_id]), [['w1', 1, t1.id], ['w1', 2, t2.id]]);
  assert.ok(l1 && l1.id, 'the first turn was taken under a lease');
}));
