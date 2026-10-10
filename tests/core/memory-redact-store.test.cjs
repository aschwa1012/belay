'use strict';
// memory-redact-store.test.cjs — ADR 0040 §3 on the write path: text, title and body are redacted before they
// are hashed or embedded; a write with the secret and a write with its marker are one row; an empty text after
// redaction is refused; the `memory.redact` lever, read from the caller's run row, turns it off and says so.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Store, hashText } = core('store.cjs');
const { Engine } = core('engine.cjs');
const rows = core('rows.cjs');

const SECRET = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const MARK = '[REDACTED:anthropic_key]';
let dir, store, E, embedded;
const orch = callerFor('orchestrator');
const call = (method, caller, args = {}) => E.handle(method, { caller, ...args });
// rows.append writes only the run columns the table lists; the lever column is set the way run.attach does.
function fakeRun(id, levers) {
  rows.append(store, 'run', { id, epoch: 1, started_at: Date.now(), adapter_pid: process.pid }, 'operator');
  store.p('UPDATE run SET memory_levers = ? WHERE id = ?').run(levers, id);
}
const dbRow = id => store.p('SELECT * FROM memory_entries WHERE id = ?').get(id);
const getEmbedder = async () => ({ embed: async (text) => { embedded.push(text); return { embedding: [1, 0], embedding_model: 'fake', embedding_revision: 'r', dim: 2 }; } });

before(() => {
  dir = sandbox();
  store = new Store(`${dir}/memory.db`, { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder, owner: null, establishedBy: 'test' });
});
after(() => { store.close(); cleanup(dir); });

test('a secret in text, title and body never reaches the row; the counts are recorded and merged', async () => {
  const r = await call('memory.store', orch, {
    text: `deploy with ${SECRET} now`, title: `key ${SECRET}`, body: { cmd: [`export ANTHROPIC_API_KEY=${SECRET}`], nested: { k: SECRET } }, embed: false,
  });
  const row = dbRow(r.id);
  const everything = JSON.stringify(row);
  assert.ok(!everything.includes(SECRET), 'the secret is nowhere in the stored row');
  assert.ok(row.text.includes(MARK));
  assert.ok(row.title.includes(MARK));
  assert.strictEqual(row.text_hash, hashText(row.text), 'the hash is of the redacted text');
  assert.ok(r.redactions.anthropic_key >= 3, JSON.stringify(r.redactions));
  assert.deepStrictEqual(JSON.parse(row.redactions), r.redactions);
});

test('two writes, one with the secret and one with its marker, dedup to one row', async () => {
  const a = await call('memory.store', orch, { text: `rotate ${SECRET} before friday`, embed: false });
  const b = await call('memory.store', orch, { text: `rotate ${MARK} before friday`, embed: false });
  assert.strictEqual(a.action, 'inserted');
  assert.strictEqual(b.action, 'updated');
  assert.strictEqual(b.id, a.id);
  assert.strictEqual(a.text_hash, b.text_hash);
  assert.deepStrictEqual(a.redactions, { anthropic_key: 1 });
  assert.deepStrictEqual(b.redactions, { anthropic_key: 1 }, 'the row keeps the counts it was written with');
});

test('an ADR 0033 style re-run of the same write converges on the same row', async () => {
  const args = { text: `retry ${SECRET} please`, title: 'retry', body: { k: SECRET }, embed: false };
  const first = await call('memory.store', orch, args);
  const rerun = await call('memory.store', orch, args);
  assert.strictEqual(rerun.id, first.id);
  assert.strictEqual(rerun.action, 'updated');
  assert.strictEqual(store.p('SELECT COUNT(*) n FROM memory_entries WHERE text_hash = ?').get(first.text_hash).n, 1);
});

test('the embedder is given the redacted text, never the raw one', async () => {
  embedded = [];
  await call('memory.store', orch, { text: `embed me ${SECRET} please` });
  assert.deepStrictEqual(embedded, [`embed me ${MARK} please`]);
});

test('a <private> span is removed, and a text empty after redaction is E_ARGS with the reason, writing nothing', async () => {
  const kept = await call('memory.store', orch, { text: 'visible <private>hidden thing</private> end', embed: false });
  assert.ok(!dbRow(kept.id).text.includes('hidden thing'));
  assert.deepStrictEqual(kept.redactions, { private: 1 });
  const n = store.count();
  await assert.rejects(call('memory.store', orch, { text: '<private>everything</private>', embed: false }), e => {
    assert.strictEqual(e.code, 'E_ARGS');
    assert.strictEqual(e.detail.reason, 'empty after redaction');
    return true;
  });
  assert.strictEqual(store.count(), n);
});

test('the memory.redact lever off, read from the run row, stores the text as given and records disabled', async () => {
  const off = callerFor('orchestrator', { run_id: 'run-redact-off' });
  fakeRun('run-redact-off', JSON.stringify({ redact: false }));
  const r = await call('memory.store', off, { text: `kept raw ${SECRET}`, embed: false });
  assert.deepStrictEqual(r.redactions, { disabled: 1 });
  assert.ok(dbRow(r.id).text.includes(SECRET), 'with the lever off the text is untouched');
  assert.deepStrictEqual(JSON.parse(dbRow(r.id).redactions), { disabled: 1 });

  const onRun = callerFor('orchestrator', { run_id: 'run-redact-on' });
  fakeRun('run-redact-on', JSON.stringify({ redact: true, rules: false }));
  assert.ok(!dbRow((await call('memory.store', onRun, { text: `scrubbed ${SECRET}`, embed: false })).id).text.includes(SECRET));
});

test('an unreadable lever, or no run row at all, leaves redaction on', async () => {
  fakeRun('run-garbled', '{not json');
  for (const run_id of ['run-garbled', 'run-with-no-row']) {
    const r = await call('memory.store', callerFor('orchestrator', { run_id }), { text: `scrub me ${SECRET} ${run_id}`, embed: false });
    assert.ok(!dbRow(r.id).text.includes(SECRET), run_id);
    assert.deepStrictEqual(r.redactions, { anthropic_key: 1 });
  }
});
