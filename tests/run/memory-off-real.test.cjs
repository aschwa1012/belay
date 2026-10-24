'use strict';
// memory-off-real.test.cjs — memory-off-identity.test.cjs on the real store. One scripted worker turn pair runs through
// the run manager with every memory lever off, against the real core on the harness view, and the rows and events it
// leaves are compared by column with what the lever-off path wrote before ADR 0044: written_by is the one column that
// differs. The only stand-in is a fixed vector on each store, so no embedding model is needed.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { openCore } = require('../../src/core/index.cjs');
const { sandbox, cleanup, callerFor } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').split(path.sep).join('/');

// The columns of a lever-off turn row before the writer column existed. text and title carry the fake's echo.
const BEFORE = {
  namespace: 'run/test-run', worker_id: 'orchestrator', last_writer_id: 'orchestrator', type: 'turn',
  tags: ['w1', 'turn:1'], provenance: 'worker:w1', supersedes: null, ttl_at: null,
  status: 'unverified', status_receipt: null, status_by: null, status_at: null,
  run_id: 'test-run', task_id: null, turn: null, source: 'model', redactions: null,
};

test('levers off on the real store: the rows and events are those of the lever-off path, written_by apart', { timeout: 60000 }, async () => {
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
    try {
      await m.spawn({ substrate: 'claude-code', worktree: wt.split(path.sep).join('/'), prompt: 'one', worker_id: 'w1' });
      await m._waitTurn('w1', 8000);
      await m.message({ worker_id: 'w1', text: 'two' });
      await m._waitTurn('w1', 8000);
      await m._worker('w1').memoryQueue; // the turn writes are chained here: every one has landed once it settles
    } finally { try { await m.shutdown(); } catch { /* best effort */ } }

    const listed = await core.memory.list({ namespace: 'run/test-run', view: 'full', order: 'oldest', limit: 50 });
    const rows = listed.rows;
    assert.strictEqual(rows.length, 2, 'one turn row per turn, and nothing else');
    rows.forEach((r, i) => {
      const { id, text, title, created_at, updated_at, text_hash, written_by, ...cols } = r;
      assert.deepStrictEqual(cols, { ...BEFORE, tags: ['w1', `turn:${i + 1}`] });
      assert.match(text, /^echo: /);
      assert.strictEqual(title, text.split('\n')[0]);
      assert.strictEqual(written_by, 'harness', 'the one column that differs from the lever-off path');
    });
    const events = await core.memory.events({});
    assert.deepStrictEqual(events.events, [], 'no memory_event with every lever off');
  } finally {
    if (saved === undefined) delete process.env.FAKE_TOOL_USES; else process.env.FAKE_TOOL_USES = saved;
    try { await core.shutdownOwner(); } catch { /* best effort */ }
    await core.close();
    cleanup(dir);
  }
});
