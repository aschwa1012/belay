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

// ---- the sinking penalty ----

function misses(noteId, count, over = {}) {
  const facts = { route: 'index', area: true, applied_reported: true, used: false, ...over };
  for (let i = 0; i < count; i++) {
    store.db.prepare(`INSERT INTO memory_event (id, run_id, worker_id, task_id, kind, key, row_ids, ok, message, written_at, written_by) VALUES (?, 'old-run', 'w1', ?, 'note_chance', ?, ?, 1, ?, ?, 'harness')`)
      .run(`me-${noteId}-${i}-${n++}`, `t${i}`, `k-${noteId}-${i}-${n}`, JSON.stringify([noteId]), JSON.stringify(facts), Date.now());
  }
}
// Two notes equal in every signal; the newer one leads until the lever demotes it.
function pair() {
  const space = fresh();
  const older = note(space, 'equal claim a gadget', [1, 0, 0], { created_at: 10 });
  const newer = note(space, 'equal claim a gadget too', [1, 0, 0], { created_at: 20 });
  return { space, older, newer };
}
const args = (space) => ({ namespaces: [space], query_embedding: [1, 0, 0], embedding_model: 'm' });

test('sink penalty: more than 8 misses demotes a note by 0.85; 8 do not; record and off leave the ranking untouched', async () => {
  const { space, older, newer } = pair();
  const base = await index('on', args(space));
  assert.deepStrictEqual(base.row_ids, [newer, older], 'the newer note leads on a tie');
  misses(newer, 8);
  assert.deepStrictEqual((await index('penalty', args(space))).row_ids, [newer, older], 'eight misses are not more than eight');
  misses(newer, 1);
  const pen = await index('penalty', args(space));
  assert.deepStrictEqual(pen.row_ids, [older, newer], 'nine misses demote it');
  assert.deepStrictEqual(pen.sunk, [newer]);
  for (const k of ['on', 'off', 'record']) {
    const r = await index(k, args(space));
    assert.strictEqual(r.text, base.text, `lever ${k}: byte-identical`);
    assert.deepStrictEqual(r.row_ids, base.row_ids);
    assert.strictEqual(r.sunk, undefined);
  }
});

test('sink penalty counts only relevant, reported, unused chances (the recorded facts), and the factor is 0.85', async () => {
  const { space, older, newer } = pair();
  misses(newer, 9, { used: true });
  misses(newer, 9, { area: false });
  misses(newer, 9, { applied_reported: false });
  assert.deepStrictEqual((await index('penalty', args(space))).row_ids, [newer, older], 'chances that are not misses never demote');
  assert.strictEqual(R.SINK_FACTOR, 0.85);
  assert.strictEqual(R.SINK_MISSES, 8);
  // A demoted note keeps ranking by 0.85 x its score: a clearly more relevant note still leads.
  const space2 = fresh();
  const strong = note(space2, 'gadget gadget quokkas strong', [1, 0, 0], { created_at: 10 });
  const weak = note(space2, 'something else entirely', [0.2, 1, 0], { created_at: 20 });
  misses(strong, 20);
  const r = await index('penalty', { namespaces: [space2], query: 'gadget quokkas', query_embedding: [1, 0, 0], embedding_model: 'm' });
  assert.deepStrictEqual(r.sunk, [strong]);
  assert.strictEqual(r.row_ids[0], strong, 'a demotion, not a deletion');
  assert.ok(r.row_ids.includes(weak));
});
