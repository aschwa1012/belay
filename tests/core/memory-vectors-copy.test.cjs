'use strict';
// memory-vectors-copy.test.cjs — a verified copy into the project keeps the template its vector was made under, so the copy's
// vector is cached under the same key as the source's and the two share it.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Store } = core('store.cjs');
const { Engine } = core('engine.cjs');

let dir, store, E;
const proj = callerFor('orchestrator', { run_id: 'r-copy' });
before(async () => {
  dir = sandbox();
  store = new Store(`${dir}/memory.db`, { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: null, owner: null, establishedBy: 'test' });
  await E.handle('run.attach', { caller: proj, adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', notes: false, project_writes: true }) });
});
after(() => { store.close(); cleanup(dir); });

test('a verified copy of a v2 row keeps text_template v2 and shares the source\'s cached vector', async () => {
  const when = 'a deploy is being shipped';
  const title = 'the ship script needs a tag';
  const src = store.storeIn({ namespace: 'run/r-copy', worker_id: 'w', type: 'fact', text: `${title}\nWhen: ${when}`, title, body: { when }, run_id: 'r-copy',
    embedding: [1, 0], embedding_model: 'fake', embedding_revision: 'r', dim: 2, text_template: 'v2' });
  const out = await E.handle('memory.setStatus', { caller: proj, id: src.id, status: 'verified', receipt: 'commit:abc1234' });
  assert.strictEqual(out.project_copy.ok, true);
  const copy = store.p('SELECT text_template, embedding_model FROM memory_entries WHERE id = ?').get(out.project_copy.id);
  assert.strictEqual(copy.text_template, 'v2');
  assert.strictEqual(Number(store.p('SELECT COUNT(*) AS n FROM memory_vectors').get().n), 1, 'one cached vector, shared by both rows');
});
