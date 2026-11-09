'use strict';
// memory-index-bar.test.cjs — the first-message index's relevance bar (research 2026-11-09, provisional): a note is listed when its best cosine to the
// task's query vectors is at least index_min_relevance, or it matches the task by subject or path; at most index_max_notes; and the receipt logs each
// listed note's cosine and the best cosine that was cut. With no vector list (keyword-only), only the facts qualify.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Store } = core('store.cjs');
const { Engine } = core('engine.cjs');
const L = core('memory-levers.cjs');

let dir, store, E, n = 0;
const RUN = 'rn-bar', RUN_OFF = 'rn-bar-off';
const orch = (run = RUN) => callerFor('orchestrator', { run_id: run });
const index = (args, run) => E.handle('memory.index', { caller: orch(run), ...args });
const fresh = () => {
  const name = `bar-${++n}`;
  for (const id of [RUN, RUN_OFF]) {
    const cur = core('rows.cjs').current(store, 'run', id);
    store.p('UPDATE run SET project = ?, memory_levers = ? WHERE id = ? AND seq = ?').run(name, JSON.stringify({ ...JSON.parse(cur.memory_levers), project: name }), id, cur.seq);
  }
  return `project/${name}`;
};

before(async () => {
  dir = sandbox();
  store = new Store(`${dir}/memory.db`, { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: null, owner: null, establishedBy: 'test' });
  // The default levers of a notes run: the bar is on at 0.40, the cap 5. The second run turns the bar off with 0.
  await E.handle('run.attach', { caller: orch(), adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', notes: true }) });
  await E.handle('run.attach', { caller: orch(RUN_OFF), adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', notes: true, index_min_relevance: 0 }) });
});
after(() => { store.close(); cleanup(dir); });

function note(space, title, vec, subjects = []) {
  const r = store.storeIn({
    namespace: space, worker_id: 'w1', type: 'note', text: title, title,
    body: { kind: 'lesson', basis: 'inferred', evidence: [], applies_to: [], subjects, model: 'm', state: 'live', seen_in: [], seen_total: 0, reported_wrong: [] },
    embedding: vec, embedding_model: 'm', embedding_revision: 'r', dim: 3, run_id: 'old-run', task_id: null, source: 'model', written_by: 'worker:w1',
  });
  store.db.prepare('UPDATE memory_entries SET created_at = ? WHERE id = ?').run(1000 + n++, r.id);
  return r.id;
}
const Q = [1, 0, 0];

test('the levers: index_bytes 1600, index_min_relevance 0.40, index_max_notes 5, validated; the index follows notes', () => {
  const d = L.defaultLevers();
  assert.deepStrictEqual([d.index_bytes, d.index_min_relevance, d.index_max_notes], [1600, 0.4, 5]);
  assert.strictEqual(L.parseMemoryBlock({ project: 'p' }).value.first_message_index, true, 'on with notes');
  assert.strictEqual(L.parseMemoryBlock({ project: 'p', notes: false }).value.first_message_index, false, 'off with notes off');
  assert.strictEqual(L.parseMemoryBlock({ project: 'p', first_message_index: false }).value.first_message_index, false, 'a stated value wins');
  assert.strictEqual(L.parseMemoryBlock({ index_min_relevance: 0.5 }).value.index_min_relevance, 0.5);
  assert.match(L.parseMemoryBlock({ index_min_relevance: 1.5 }).error, /index_min_relevance must be a number from 0 to 1/);
  assert.match(L.parseMemoryBlock({ index_max_notes: 0 }).error, /index_max_notes must be an integer from 1 to 20/);
  assert.match(L.parseMemoryBlock({ index_max_notes: 21 }).error, /index_max_notes/);
});

test('a note under the bar is not listed; one at or over it is; the receipt logs each cosine and the best one cut', async () => {
  const space = fresh();
  const near = note(space, 'quokka habits near the task', [1, 0, 0]);
  const far = note(space, 'unrelated gadget claim', [0, 1, 0]);
  const mid = note(space, 'a middling claim', [0.3, 0.954, 0]); // cosine about 0.30
  const r = await index({ namespaces: [space], query_embedding: Q, embedding_model: 'm' });
  assert.deepStrictEqual(r.row_ids, [near]);
  assert.deepStrictEqual(r.bar.listed, [{ id: near, cos: 1, why: 'cos' }]);
  assert.strictEqual(r.bar.cut_by_floor, 2);
  assert.strictEqual(r.bar.cut_by_cap, 0);
  assert.ok(Math.abs(r.bar.best_cut_cos - 0.3) < 0.01, `best cut ${r.bar.best_cut_cos}`);
  assert.deepStrictEqual([r.bar.min_relevance, r.bar.max_notes, r.bar.by], [0.4, 5, 'cosine_or_facts']);
  assert.strictEqual(r.none_passed, false);
  assert.ok(far && mid);
});

test('a note that matches the task by subject is listed under the bar, whatever its cosine', async () => {
  const space = fresh();
  const fact = note(space, 'the widget cache rule', [0, 1, 0], ['widget cache']);
  note(space, 'unrelated gadget claim', [0, 0, 1]);
  const r = await index({ namespaces: [space], query: 'fix the widget cache', query_embedding: Q, embedding_model: 'm' });
  assert.deepStrictEqual(r.row_ids, [fact]);
  assert.strictEqual(r.bar.listed[0].why, 'subject');
});

test('at most index_max_notes are listed, the rest counted as cut by the cap', async () => {
  const space = fresh();
  for (let i = 0; i < 7; i++) note(space, `quokka claim ${i}`, [1, 0, 0]);
  const r = await index({ namespaces: [space], query_embedding: Q, embedding_model: 'm' });
  assert.strictEqual(r.row_ids.length, 5);
  assert.strictEqual(r.bar.cut_by_cap, 2);
  assert.strictEqual(r.bar.cut_by_floor, 0);
});

test('index_min_relevance 0 turns the bar off: rank order up to the cap, with or without vectors', async () => {
  const space = fresh();
  note(space, 'plain claim a', [0, 1, 0]);
  note(space, 'plain claim b', [0, 0, 1]);
  const r = await index({ namespaces: [space], query_embedding: Q, embedding_model: 'm' }, RUN_OFF);
  assert.strictEqual(r.row_ids.length, 2);
  assert.strictEqual(r.bar.by, 'off');
});

test('with no vector list (keyword only) only subject and path facts qualify, and the receipt says why', async () => {
  const space = fresh();
  const fact = note(space, 'the widget cache rule', [0, 1, 0], ['widget cache']);
  note(space, 'quokka claim', [1, 0, 0]);
  const r = await index({ namespaces: [space], query: 'fix the widget cache' });
  assert.deepStrictEqual(r.row_ids, [fact]);
  assert.strictEqual(r.bar.by, 'facts_only');
  assert.match(r.bar.reason, /keyword only/);
});

test('notes in scope and none passing: none_passed is set with the count; no notes at all: it is not', async () => {
  const space = fresh();
  note(space, 'unrelated gadget claim', [0, 1, 0]);
  note(space, 'another unrelated claim', [0, 0, 1]);
  const none = await index({ namespaces: [space], query_embedding: Q, embedding_model: 'm' });
  assert.deepStrictEqual([none.row_ids, none.bytes, none.none_passed, none.considered], [[], 0, true, 2]);
  const empty = await index({ namespaces: [fresh()], query_embedding: Q, embedding_model: 'm' });
  assert.strictEqual(empty.none_passed === undefined || empty.none_passed === false, true);
});
