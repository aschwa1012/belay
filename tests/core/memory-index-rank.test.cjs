'use strict';
// memory-index-rank.test.cjs — the notes index's candidates (a vector top-200 and a keyword top-200 over the whole live scope, not the
// newest 1,000), their order (hybrid relevance first) and the sinking penalty (memory.notes_sink: penalty).

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Store } = core('store.cjs');
const { Engine } = core('engine.cjs');
const R = core('memory-index-rank.cjs');

let dir, store, E;
const RUNS = { on: 'rn-rank', record: 'rn-record', penalty: 'rn-penalty', off: 'rn-sink-off' };
const LEVERS = {
  on: { project: 'acme', notes: true }, off: { project: 'acme', notes: true, notes_sink: 'off' },
  record: { project: 'acme', notes: true, notes_sink: 'record' }, penalty: { project: 'acme', notes: true, notes_sink: 'penalty' },
};
const orch = (k) => callerFor('orchestrator', { run_id: RUNS[k] });
const index = (k, args) => E.handle('memory.index', { caller: orch(k), ...args });
let n = 0;
const fresh = () => `project/rank-${++n}`;

before(async () => {
  dir = sandbox();
  store = new Store(`${dir}/memory.db`, { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: null, owner: null, establishedBy: 'test' });
  for (const k of Object.keys(RUNS)) await E.handle('run.attach', { caller: orch(k), adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify(LEVERS[k]) });
});
after(() => { store.close(); cleanup(dir); });

function note(space, title, vec, over = {}) {
  const r = store.storeIn({
    namespace: space, worker_id: 'w1', type: 'note', text: title, title,
    body: { kind: 'lesson', basis: 'inferred', evidence: [], applies_to: [], subjects: [], model: 'm', state: 'live', seen_in: [], seen_total: 0, reported_wrong: [] },
    embedding: vec, embedding_model: 'm', embedding_revision: 'r', dim: 3, run_id: 'old-run', task_id: null, source: 'model', written_by: 'worker:w1',
  });
  store.db.prepare('UPDATE memory_entries SET created_at = ? WHERE id = ?').run(over.created_at || 1000 + n++, r.id);
  return r.id;
}
function crowd(space, count) { // `count` newer filler notes, all pointing at [1,0,0]
  store.db.exec('BEGIN');
  for (let i = 0; i < count; i++) note(space, `filler ${i} ordinary words`, [1, 0, 0], { created_at: 100000 + i });
  store.db.exec('COMMIT');
}

test('a note older than the newest 1,000 is a candidate: the vector top-200 finds it', async () => {
  const space = fresh();
  const target = note(space, 'the old claim about widgets', [0, 1, 0], { created_at: 5 });
  crowd(space, 1100);
  const r = await index('on', { namespaces: [space], query_embedding: [0, 1, 0], embedding_model: 'm' });
  assert.strictEqual(r.row_ids[0], target);
  assert.strictEqual(r.candidates.source, 'vector');
  assert.strictEqual(r.candidates.scope, 1101);
  assert.ok(r.candidates.vector <= R.TOP && r.candidates.total <= 2 * R.TOP + R.TOP, 'bounded');
  assert.strictEqual(r.candidates.padding > 0, true, 'the newest notes pad the union');
});

test('a note older than the newest 1,000 is a candidate: the keyword top-200 finds it', async () => {
  const space = fresh();
  const target = note(space, 'quokkas remember the rare setting', [1, 0, 0], { created_at: 5 });
  crowd(space, 1100);
  const r = await index('on', { namespaces: [space], query: 'quokkas' });
  assert.strictEqual(r.row_ids[0], target);
  assert.strictEqual(r.candidates.source, 'keyword');
  assert.strictEqual(r.candidates.keyword, 1);
});

test('hybrid: the receipt names the source and the counts; relevance orders, the newest is not first', async () => {
  const space = fresh();
  const hit = note(space, 'quokkas and the widget loader', [0, 1, 0], { created_at: 5 });
  crowd(space, 30);
  const r = await index('on', { namespaces: [space], query: 'quokkas', query_embedding: [0, 1, 0], embedding_model: 'm' });
  assert.deepStrictEqual(Object.keys(r.candidates), ['source', 'scope', 'vector', 'keyword', 'union', 'padding', 'total']);
  assert.strictEqual(r.candidates.source, 'hybrid');
  assert.strictEqual(r.row_ids[0], hit);
  assert.strictEqual(r.relevance.fusion.method, 'rrf');
});

test('no signal: the newest notes, source newest', async () => {
  const space = fresh();
  note(space, 'plain claim', [1, 0, 0]);
  const r = await index('on', { namespaces: [space] });
  assert.strictEqual(r.candidates.source, 'newest');
  assert.strictEqual(r.candidates.total, 1);
});

// ---- the sinking seam ----

test('sinkFactor is a no-op: the ranking and the bytes are identical for notes_sink off, record and penalty, whatever was recorded', async () => {
  const space = fresh();
  const older = note(space, 'equal claim a gadget', [1, 0, 0], { created_at: 10 });
  const newer = note(space, 'equal claim a gadget too', [1, 0, 0], { created_at: 20 });
  for (let i = 0; i < 20; i++) {
    store.db.prepare("INSERT INTO memory_event (id, run_id, worker_id, task_id, kind, key, row_ids, ok, message, written_at, written_by) VALUES (?, 'old-run', 'w1', ?, 'note_chance', ?, ?, 1, ?, ?, 'harness')")
      .run(`me-${i}-${n++}`, `t${i}`, `k${i}-${n}`, JSON.stringify([newer]), JSON.stringify({ route: 'index', area: true, applied_reported: true, used: false }), Date.now());
  }
  const args = { namespaces: [space], query_embedding: [1, 0, 0], embedding_model: 'm' };
  const base = await index('on', args);
  assert.deepStrictEqual(base.row_ids, [newer, older]);
  for (const k of ['off', 'record', 'penalty']) {
    const r = await index(k, args);
    assert.strictEqual(r.text, base.text, `notes_sink ${k}`);
    assert.deepStrictEqual(r.row_ids, base.row_ids);
  }
  assert.strictEqual(R.sinkFactor({ id: newer, b: {} }, { lv: LEVERS.penalty, runId: 'x' }), 1);
});
