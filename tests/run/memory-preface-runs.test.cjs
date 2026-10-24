'use strict';
// memory-preface-runs.test.cjs — ADR 0042 decision 3 across runs, on a real store: the index a worker was already
// shown is excluded from its next launch only within its own run. Worker ids are unique only within a run, so
// coder-1 of a second run is a new worker and gets the full index, not the first run's coder-1's exclusions.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { core, sandbox, cleanup, callerFor } = require('../core/helpers.cjs');
const { Engine } = core('engine.cjs');
const { Store } = core('store.cjs');
const MP = require('../../src/run/memory-preface.cjs');
const { DEFAULTS } = require('../../src/run/memory-levers.cjs');

test('index exclusions are scoped to the run: coder-1 of run 2 sees the row coder-1 of run 1 was shown', async () => {
  const dir = sandbox();
  const store = new Store(path.join(dir, 'memory.db'), { stamp: true });
  const E = new Engine({ dataDir: dir, store, getEmbedder: null, owner: null, establishedBy: 'test' });
  try {
    const coreFor = (runId) => {
      const caller = callerFor('orchestrator', { run_id: runId });
      const h = (m) => (a) => E.handle(m, { ...a, caller });
      return { caller, memory: { events: h('memory.events'), index: (a) => h('memory.index')({ ...a, namespaces: ['project/demo'] }), recordEvent: h('memory.recordEvent') } };
    };
    const c1 = coreFor('run-1');
    const row = await E.handle('memory.store', { namespace: 'project/demo', type: 'decision', text: 'use sqlite wal', embedding: [1, 0, 0], embedding_model: 'm', dim: 3, caller: c1.caller });
    const lv = { ...DEFAULTS, first_message_index: true, project: 'demo' };

    const r1 = await MP.memoryPreface({ id: 'coder-1' }, { core: c1, runId: 'run-1', memoryLevers: lv });
    assert.ok(r1.includes(row.id), 'run 1, first launch: the row is shown');
    const r1again = await MP.memoryPreface({ id: 'coder-1' }, { core: c1, runId: 'run-1', memoryLevers: lv });
    assert.ok(!r1again.includes(row.id), 'run 1, relaunch: the row already shown is excluded');

    const c2 = coreFor('run-2');
    const r2 = await MP.memoryPreface({ id: 'coder-1' }, { core: c2, runId: 'run-2', memoryLevers: lv });
    assert.ok(r2.includes(row.id), 'run 2, first launch of a worker with the same id: the row is shown');
    const shown = (await E.handle('memory.events', { run_id: 'run-2', worker_id: 'coder-1', kinds: ['index_injected'], caller: c2.caller })).events;
    assert.strictEqual(shown.length, 1);
    assert.deepStrictEqual(shown[0].row_ids, [row.id]);
  } finally {
    store.close();
    cleanup(dir);
  }
});
