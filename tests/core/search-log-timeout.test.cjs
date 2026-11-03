'use strict';
// search-log-timeout.test.cjs — the owner's in-process timeout (src/core/index.cjs) reaches the search log: a refused hybrid search is a row with
// its code, and the keyword re-run's row names the semantic stage that failed. Seams only: an embed that never resolves and a limit of 20 ms.

const { test } = require('node:test');
const assert = require('node:assert');
const { setup, PROJECT } = require('./lifecycle-env.cjs');
const { core } = require('./helpers.cjs');
const { Engine } = core('engine.cjs');
const { openCore } = core('index.cjs');
const { createEmbedderGuard } = require('../../src/run/embedder-guard.cjs');

async function owned(mode, fn) {
  const T = await setup({ levers: { plain: { search_log: true } } });
  let c;
  try {
    const guard = createEmbedderGuard({ mode, pauseRun: async () => ({}), stopRun: async () => {} });
    const owner = { stopped: false, opts: { embedderMode: () => guard.mode(), memoryOff: () => guard.memoryOff(), onEmbedderFailure: (ev) => guard.onFailure(ev) } };
    const hung = async () => ({ embed: () => new Promise(() => {}) });
    owner.engine = new Engine({ dataDir: T.dir, store: T.store, getEmbedder: hung, owner, establishedBy: 'owner' });
    const caller = T.who.tool('plain');
    c = await openCore({ dataDir: T.dir, caller, embed: false });
    c.owner = owner;
    c.vectorLimitMs = 20;
    const rows = () => T.store.db.prepare("SELECT * FROM memory_event WHERE kind = 'search' ORDER BY seq").all();
    await fn({ c, caller, rows, guard });
  } finally { if (c) { c.owner = null; await c.close(); } await T.close(); }
}
const hybrid = (c, caller) => c.handle('memory.search', { caller, namespace: `project/${PROJECT}`, query: 'owner pipe', mode: 'hybrid' });

test('required: the search the timeout refuses is a log row with ok 0, the refusal code and a refused entry', async () => {
  await owned('required', async ({ c, caller, rows, guard }) => {
    const e = await hybrid(c, caller).then(() => null, (x) => x);
    assert.ok(e && e.code, 'refused');
    await guard.settled();
    const all = rows();
    assert.strictEqual(all.length, 1, 'one row');
    assert.strictEqual(all[0].ok, 0);
    assert.strictEqual(all[0].code, e.code);
    const d = JSON.parse(all[0].message);
    assert.strictEqual(d.query, 'owner pipe');
    assert.deepStrictEqual(d.fallback.failed.map((f) => [f.mode, f.code]), [['refused', e.code]]);
  });
});

test('keyword: the keyword re-run is one row that names the semantic stage the timeout found failed', async () => {
  await owned('keyword', async ({ c, caller, rows }) => {
    const r = await hybrid(c, caller);
    assert.deepStrictEqual(r.modes_failed.map((f) => f.mode), ['semantic'], 'the answer names it once');
    const all = rows();
    assert.strictEqual(all.length, 1, 'the abandoned search wrote nothing');
    const d = JSON.parse(all[0].message);
    assert.strictEqual(d.mode, 'keyword');
    assert.deepStrictEqual(d.fallback.failed.map((f) => [f.mode, f.code]), [['semantic', 'E_TIMEOUT']]);
  });
});
