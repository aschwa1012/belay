'use strict';
// memory-gaps.test.cjs — two small contracts: `memory.search` reads the run's `memory.alpha` lever as its default
// weight (the call's own alpha wins; no run, no lever or an invalid one means 0.5), and `memory.store` redacts
// `tags` and `provenance` under the `memory.redact` lever without letting either enter the dedup hash.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Engine } = core('engine.cjs');
const { Store, hashText } = core('store.cjs');
const rows = core('rows.cjs');

const SECRET = 'sk' + '-ant-api03-' + 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const MARK = '[REDACTED:anthropic_key]';
let dir, store, E;
const call = (method, caller, args = {}) => E.handle(method, { caller, ...args });
function fakeRun(id, levers) {
  rows.append(store, 'run', { id, epoch: 1, started_at: Date.now(), adapter_pid: process.pid }, 'operator');
  if (levers !== undefined) store.p('UPDATE run SET memory_levers = ? WHERE id = ?').run(levers, id);
}
const dbRow = id => store.p('SELECT * FROM memory_entries WHERE id = ?').get(id);

before(() => {
  dir = sandbox();
  store = new Store(path.join(dir, 'memory.db'), { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: async () => null, owner: null, establishedBy: 'test' });
  fakeRun('run-a', JSON.stringify({ alpha: 0.25 }));
  fakeRun('run-b', JSON.stringify({ redact: false }));
  fakeRun('run-c', JSON.stringify({ alpha: 7 }));
});
after(() => { store.close(); cleanup(dir); });

test('memory.search takes its default alpha from the run lever, and the call overrides it', async () => {
  const embedding = { embedding: [1, 0], embedding_model: 'm', dim: 2 };
  const put = (c, text) => call('memory.store', c, { namespace: 'n', text, embedding: embedding.embedding, embedding_model: 'm', dim: 2 });
  await put(callerFor('orchestrator', { run_id: 'run-a' }), 'gadget alpha lever row');
  const q = { namespace: 'n', query: 'gadget', query_embedding: [1, 0], embedding_model: 'm', mode: 'hybrid' };
  const alphaOf = async (runId, extra = {}) => (await call('memory.search', callerFor('orchestrator', { run_id: runId }), { ...q, ...extra })).fusion.alpha;
  assert.strictEqual(await alphaOf('run-a'), 0.25, 'the lever is the default');
  assert.strictEqual(await alphaOf('run-a', { alpha: 0.9 }), 0.9, 'the call wins');
  assert.strictEqual(await alphaOf('run-b'), 0.3, 'a run with no alpha lever uses the built-in default');
  assert.strictEqual(await alphaOf('run-c'), 0.3, 'an invalid stored alpha falls back rather than failing the search');
  assert.strictEqual(await alphaOf('no-such-run'), 0.3, 'no run row means the default');
});

test('tags and provenance are redacted, counted, and kept out of the dedup hash', async () => {
  const c = callerFor('orchestrator', { run_id: 'run-a' });
  const r = await call('memory.store', c, { namespace: 'tp', text: 'fact one', tags: ['plain', `key:${SECRET}`], provenance: `from ${SECRET}`, embed: false });
  const row = dbRow(r.id);
  assert.ok(!JSON.stringify(row).includes(SECRET), 'the secret is nowhere in the row');
  assert.deepStrictEqual(JSON.parse(row.tags), ['plain', `key:${MARK}`]);
  assert.strictEqual(row.provenance, `from ${MARK}`);
  assert.ok(r.redactions.anthropic_key >= 2);
  assert.strictEqual(row.text_hash, hashText('fact one'), 'tags and provenance do not change the hash');
  const again = await call('memory.store', c, { namespace: 'tp', text: 'fact one', tags: ['other'], embed: false });
  assert.strictEqual(again.id, r.id, 'same namespace and text is the same row whatever the tags');
});

test('with redact off, tags and provenance are stored as given', async () => {
  const r = await call('memory.store', callerFor('orchestrator', { run_id: 'run-b' }), { namespace: 'tp2', text: 'fact two', tags: [SECRET], provenance: SECRET, embed: false });
  const row = dbRow(r.id);
  assert.deepStrictEqual(JSON.parse(row.tags), [SECRET]);
  assert.strictEqual(row.provenance, SECRET);
});
