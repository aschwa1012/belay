'use strict';
// methods-memory-mutation.test.cjs — claims of methods-memory.cjs that a mutation run showed no other test pins
// down: every core-set field is refused by name, the alpha lever honours its ends, the redact-off write keeps
// the title and body as given, and the embedder-failure hook gets the call it was told about.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Engine } = core('engine.cjs');
const { Store } = core('store.cjs');
const rows = core('rows.cjs');
const mm = core('methods-memory.cjs');

const SECRET = 'sk' + '-ant-api03-' + 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
let dir, store, E;
const call = (method, caller, args = {}) => E.handle(method, { caller, ...args });
const dbRow = (id) => store.p('SELECT * FROM memory_entries WHERE id = ?').get(id);
function fakeRun(id, levers) {
  rows.append(store, 'run', { id, epoch: 1, started_at: Date.now(), adapter_pid: process.pid }, 'operator');
  if (levers !== undefined) store.p('UPDATE run SET memory_levers = ? WHERE id = ?').run(levers, id);
}

before(() => {
  dir = sandbox();
  store = new Store(`${dir}/memory.db`, { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: null, owner: null, establishedBy: 'test' });
  fakeRun('r-off', JSON.stringify({ redact: false }));
  fakeRun('r-a0', JSON.stringify({ alpha: 0 }));
  fakeRun('r-a1', JSON.stringify({ alpha: 1 }));
  fakeRun('r-over', JSON.stringify({ alpha: 1.01 }));
  fakeRun('r-neg', JSON.stringify({ alpha: -0.01 }));
  fakeRun('r-str', JSON.stringify({ alpha: '0.3' }));
  fakeRun('r-bad', '{not json');
  fakeRun('r-none');
});
after(() => { store.close(); cleanup(dir); });

test('every field only the core sets is refused by name, for every role', async () => {
  const orch = callerFor('orchestrator');
  for (const field of ['run_id', 'status', 'status_receipt', 'status_by', 'status_at', 'redactions', 'text_hash', 'last_writer_id']) {
    await assert.rejects(call('memory.store', orch, { text: 'x', embed: false, [field]: 'v' }), (e) => {
      assert.strictEqual(e.code, 'E_ARGS', field);
      assert.strictEqual(e.detail.field, field);
      return true;
    });
  }
});

test('the alpha lever is honoured at 0 and 1 and ignored when out of range, not a number or unreadable', () => {
  const alpha = (runId) => mm.runAlpha(E, callerFor('orchestrator', { run_id: runId }));
  assert.strictEqual(alpha('r-a0'), 0);
  assert.strictEqual(alpha('r-a1'), 1);
  for (const id of ['r-over', 'r-neg', 'r-str', 'r-bad', 'r-none', 'r-missing']) assert.strictEqual(alpha(id), null, id);
});

test('with redaction off the text, title, body, tags and provenance are stored as given and the row says so', async () => {
  const c = callerFor('orchestrator', { run_id: 'r-off' });
  const r = await call('memory.store', c, { text: `plain ${SECRET}`, title: `T ${SECRET}`, body: { k: SECRET }, tags: [SECRET], provenance: `p ${SECRET}`, embed: false });
  const row = dbRow(r.id);
  assert.ok(row.text.includes(SECRET));
  assert.ok(row.title.includes(SECRET), 'the title is kept as written');
  assert.deepStrictEqual(JSON.parse(row.body), { k: SECRET });
  assert.deepStrictEqual(JSON.parse(row.tags), [SECRET]);
  assert.ok(row.provenance.includes(SECRET));
  assert.deepStrictEqual(JSON.parse(row.redactions), { disabled: 1 });
  const bare = await call('memory.store', c, { text: 'no title no body', embed: false });
  assert.strictEqual(dbRow(bare.id).title, null);
  assert.strictEqual(dbRow(bare.id).body, null);
});

test('with redaction on, every field is scrubbed, counted, and the counts are not lost on an empty text', async () => {
  const c = callerFor('orchestrator', { run_id: 'r-none' });
  const r = await call('memory.store', c, { text: `fact ${SECRET}`, title: `T ${SECRET}`, body: { k: SECRET }, tags: [`k:${SECRET}`], provenance: `p ${SECRET}`, embed: false });
  const row = dbRow(r.id);
  for (const col of ['text', 'title', 'body', 'tags', 'provenance']) assert.ok(!String(row[col]).includes(SECRET), col);
  assert.deepStrictEqual(JSON.parse(row.redactions), { anthropic_key: 5 });
  await assert.rejects(call('memory.store', c, { text: '<private>everything</private>', title: `T ${SECRET}`, embed: false }), (e) => {
    assert.strictEqual(e.code, 'E_ARGS');
    assert.strictEqual(e.detail.field, 'text');
    assert.strictEqual(e.detail.reason, 'empty after redaction');
    assert.deepStrictEqual(e.detail.redactions, { anthropic_key: 1, private: 1 });
    return true;
  });
});

test('the embedder-failure hook is told the call, the caller and the error, and a hook that throws or rejects changes nothing', async () => {
  const seen = [];
  const boom = Object.assign(new Error('embedder is down'), { code: 'E_MODEL_ABSENT' });
  const owner = { opts: { onEmbedderFailure: (x) => { seen.push(x); } }, noteWrite() {}, pipe: 'p' };
  const e1 = new Engine({ dataDir: dir, store, getEmbedder: async () => { throw boom; }, owner, establishedBy: 'test' });
  const c = callerFor('orchestrator', { run_id: 'r-none' });
  await assert.rejects(e1.handle('memory.store', { caller: c, text: 'needs a vector' }), (x) => x === boom);
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].call, 'memory.store');
  assert.strictEqual(seen[0].error, boom);
  assert.strictEqual(seen[0].caller, c);
  assert.strictEqual(seen[0].by, e1.writtenBy(c));
  for (const hook of [() => { throw new Error('hook broke'); }, () => Promise.reject(new Error('hook rejected'))]) {
    const e2 = new Engine({ dataDir: dir, store, getEmbedder: async () => { throw boom; }, owner: { opts: { onEmbedderFailure: hook }, noteWrite() {}, pipe: 'p' }, establishedBy: 'test' });
    await assert.rejects(e2.handle('memory.store', { caller: c, text: 'again' }), (x) => x === boom);
  }
  const e3 = new Engine({ dataDir: dir, store, getEmbedder: async () => { throw boom; }, owner: { opts: {}, noteWrite() {}, pipe: 'p' }, establishedBy: 'test' });
  await assert.rejects(e3.handle('memory.store', { caller: c, text: 'no hook' }), (x) => x === boom);
  assert.strictEqual(seen.length, 1);
});

test('projectOf and resolveNamespace: a run with no project and a caller with no run leave the literal namespace', async () => {
  fakeRun('r-proj');
  store.p('UPDATE run SET project = ? WHERE id = ?').run('acme', 'r-proj');
  assert.strictEqual(mm.projectOf(E, callerFor('orchestrator', { run_id: 'r-proj' })), 'acme');
  assert.strictEqual(mm.projectOf(E, callerFor('orchestrator', { run_id: 'r-none' })), null);
  assert.strictEqual(mm.projectOf(E, null), null);
  assert.strictEqual(mm.projectOf(E, { role: 'operator' }), null);
  assert.strictEqual(mm.resolveNamespace(E, callerFor('orchestrator', { run_id: 'r-proj' }), 'project'), 'project/acme');
  assert.strictEqual(mm.resolveNamespace(E, callerFor('orchestrator', { run_id: 'r-none' }), 'project'), 'project');
  assert.strictEqual(mm.resolveNamespace(E, callerFor('orchestrator', { run_id: 'r-proj' }), 'projects'), 'projects');
  assert.strictEqual(mm.nsFor(E, callerFor('orchestrator', { run_id: 'r-proj' }), {}), 'run/r-proj');
});
