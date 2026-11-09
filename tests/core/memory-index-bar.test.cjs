'use strict';
// memory-index-bar.test.cjs — the first-message index's relevance bar (provisional). Two scores per note, each with its own floor: `sub`, the best cosine to the
// task's search lines (any query not labelled `task`), and `spec`, the cosine to the whole task spec (label `task`). With search lines a note is listed when
// (sub >= index_min_relevance and sub is within 0.05 of the best sub) or spec >= index_min_relevance_spec; with none, when spec >= index_spec_only_floor.
// A subject or path match lists nothing. At most index_max_notes; the receipt logs both scores of each listed note and which leg passed.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Store } = core('store.cjs');
const { Engine } = core('engine.cjs');
const L = core('memory-levers.cjs');
const NANO = require('../../src/core/retrieval-profiles.cjs').NANO; // the model the relevance bar was measured on

let dir, store, E, n = 0;
const RUN = 'rn-bar', RUN_OFF = 'rn-bar-off', RUN_Z = 'rn-bar-zero';
const orch = (run = RUN) => callerFor('orchestrator', { run_id: run });
const index = (args, run) => E.handle('memory.index', { caller: orch(run), ...args });
const fresh = () => {
  const name = `bar-${++n}`;
  for (const id of [RUN, RUN_OFF, RUN_Z]) {
    const cur = core('rows.cjs').current(store, 'run', id);
    store.p('UPDATE run SET project = ?, memory_levers = ? WHERE id = ? AND seq = ?').run(name, JSON.stringify({ ...JSON.parse(cur.memory_levers), project: name }), id, cur.seq);
  }
  return `project/${name}`;
};

before(async () => {
  dir = sandbox();
  store = new Store(`${dir}/memory.db`, { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: null, owner: null, establishedBy: 'test' });
  // The default levers of a notes run. The second run turns the whole bar off with index_min_relevance 0; the third turns the two spec floors off.
  await E.handle('run.attach', { caller: orch(), adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', notes: true }) });
  await E.handle('run.attach', { caller: orch(RUN_OFF), adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', notes: true, index_min_relevance: 0 }) });
  await E.handle('run.attach', { caller: orch(RUN_Z), adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', notes: true, index_min_relevance_spec: 0, index_spec_only_floor: 0 }) });
});
after(() => { store.close(); cleanup(dir); });

function note(space, title, vec, subjects = [], model = NANO) {
  const r = store.storeIn({
    namespace: space, worker_id: 'w1', type: 'note', text: title, title,
    body: { kind: 'lesson', basis: 'inferred', evidence: [], applies_to: [], subjects, model: 'm', state: 'live', seen_in: [], seen_total: 0, reported_wrong: [] },
    embedding: vec, embedding_model: model, embedding_revision: 'r', dim: 3, run_id: 'old-run', task_id: null, source: 'model', written_by: 'worker:w1',
  });
  store.db.prepare('UPDATE memory_entries SET created_at = ? WHERE id = ?').run(1000 + n++, r.id);
  return r.id;
}
const nv = (c, d) => [c, d, Math.sqrt(1 - c * c - d * d)]; // a unit vector whose cosine to X is c and to Y is d
const at = (c) => [c, Math.sqrt(1 - c * c), 0]; // a unit vector whose cosine to X is c
const X = [1, 0, 0], Y = [0, 1, 0];
const spec = (v) => ({ vector: v, model: NANO, label: 'task' });
const line = (v, i = 1) => ({ vector: v, model: NANO, label: `q:${i}` });
const ids = (r) => r.bar.listed.map((x) => x.id);

test('the levers: index_bytes 1600, index_min_relevance 0.45, spec 0.60, spec-only 0.55, index_max_notes 3, validated; the index follows notes', () => {
  const d = L.defaultLevers();
  assert.deepStrictEqual([d.index_bytes, d.index_min_relevance, d.index_min_relevance_spec, d.index_spec_only_floor, d.index_max_notes], [1600, 0.45, 0.6, 0.55, 3]);
  assert.strictEqual(L.parseMemoryBlock({ project: 'p' }).value.first_message_index, true, 'on with notes');
  assert.strictEqual(L.parseMemoryBlock({ project: 'p', notes: false }).value.first_message_index, false, 'off with notes off');
  assert.strictEqual(L.parseMemoryBlock({ project: 'p', first_message_index: false }).value.first_message_index, false, 'a stated value wins');
  assert.strictEqual(L.parseMemoryBlock({ index_min_relevance: 0.5 }).value.index_min_relevance, 0.5);
  assert.strictEqual(L.parseMemoryBlock({ index_min_relevance_spec: 0.7, index_spec_only_floor: 0 }).value.index_min_relevance_spec, 0.7);
  assert.match(L.parseMemoryBlock({ index_min_relevance: 1.5 }).error, /index_min_relevance must be a number from 0 to 1/);
  assert.match(L.parseMemoryBlock({ index_min_relevance_spec: 1.5 }).error, /index_min_relevance_spec must be a number from 0 to 1/);
  assert.match(L.parseMemoryBlock({ index_spec_only_floor: -0.1 }).error, /index_spec_only_floor must be a number from 0 to 1/);
  assert.match(L.parseMemoryBlock({ index_max_notes: 0 }).error, /index_max_notes must be an integer from 1 to 20/);
  assert.match(L.parseMemoryBlock({ index_max_notes: 21 }).error, /index_max_notes/);
  assert.deepStrictEqual(['index_min_relevance_spec', 'index_spec_only_floor'].map((k) => L.TYPES[k].type), ['number', 'number'], 'settable like the others');
});

test('with no search lines the spec alone is judged, against index_spec_only_floor; the receipt logs both scores, the leg and the best cut', async () => {
  const space = fresh();
  const near = note(space, 'quokka habits near the task', X);
  const between = note(space, 'a claim at 0.58', at(0.58)); // over the spec-only floor 0.55
  note(space, 'a claim at 0.50', at(0.5));
  const r = await index({ namespaces: [space], query_embeddings: [spec(X)] });
  assert.deepStrictEqual([...r.row_ids].sort(), [near, between].sort());
  assert.deepStrictEqual(r.bar.listed.find((x) => x.id === near), { id: near, sub: null, spec: 1, why: 'spec_only' });
  assert.deepStrictEqual([r.bar.subqueries, r.bar.spec_only, r.bar.by, r.bar.cut_by_floor, r.bar.best_cut_sub], [0, true, 'cosine', 1, null]);
  assert.ok(Math.abs(r.bar.best_cut_spec - 0.5) < 0.01, `best cut ${r.bar.best_cut_spec}`);
  assert.deepStrictEqual([r.bar.min_relevance, r.bar.min_relevance_spec, r.bar.spec_only_floor, r.bar.max_notes], [0.45, 0.6, 0.55, 3]);
});

test('with search lines each leg has its own floor: sub 0.45 within 0.05 of the best line, spec 0.60; a spec cosine of 0.58 is under the spec leg', async () => {
  const space = fresh();
  const best = note(space, 'matches the line exactly', nv(1, 0)); // sub 1
  const close = note(space, 'matches the line closely', nv(0.97, 0.1)); // within 0.05 of the best line cosine
  note(space, 'matches the line less well', nv(0.8, 0.2)); // over 0.45 but 0.2 under the best: the relative cut
  note(space, 'matches the line poorly', nv(0.3, 0.2)); // under the floor
  const bySpec = note(space, 'matches the spec', nv(0.1, 0.99)); // sub 0.1, spec 0.99
  note(space, 'spec 0.58 only', nv(0.1, 0.58)); // over the spec-only floor, under the spec leg's
  const r = await index({ namespaces: [space], query_embeddings: [spec(Y), line(X)] });
  assert.strictEqual(r.bar.cut_by_floor, 3, 'the 0.8 line, the 0.3 line and the 0.58 spec');
  assert.deepStrictEqual([r.bar.subqueries, r.bar.spec_only], [1, false]);
  assert.strictEqual(r.bar.listed.length, 3);
  assert.deepStrictEqual(r.bar.listed.map((x) => x.id).sort(), [best, close, bySpec].sort());
  for (const x of r.bar.listed) assert.strictEqual(x.why, x.id === bySpec ? 'spec' : 'sub');
  assert.ok(r.bar.best_cut_sub !== null && Math.abs(r.bar.best_cut_sub - 0.8) < 0.01, `best cut sub ${r.bar.best_cut_sub}`);
  assert.ok(Math.abs(r.bar.best_cut_spec - 0.58) < 0.01, `best cut spec ${r.bar.best_cut_spec}`);
});

test('search lines are scored by the max over the lines, and a note is not listed on a spec cosine under the spec leg\'s floor', async () => {
  const space = fresh();
  const hit = note(space, 'matches the second line', Y);
  note(space, 'matches nothing', [0, 0, 1]);
  const r = await index({ namespaces: [space], query_embeddings: [spec(at(0.58)), line(X, 1), line(Y, 2)] });
  assert.deepStrictEqual(r.row_ids, [hit]);
  assert.deepStrictEqual(r.bar.listed, [{ id: hit, sub: 1, spec: Math.round(Math.sqrt(1 - 0.58 * 0.58) * 1000) / 1000, why: 'sub' }]);
  assert.strictEqual(r.bar.subqueries, 2);
});

test('at most index_max_notes (3) are listed, the rest counted as cut by the cap', async () => {
  const space = fresh();
  for (let i = 0; i < 5; i++) note(space, `quokka claim ${i}`, X);
  const r = await index({ namespaces: [space], query_embeddings: [spec(X)] });
  assert.strictEqual(r.row_ids.length, 3);
  assert.strictEqual(r.bar.cut_by_cap, 2);
  assert.strictEqual(r.bar.cut_by_floor, 0);
});

test('index_min_relevance 0 turns the bar off: rank order up to the cap, with or without vectors', async () => {
  const space = fresh();
  note(space, 'plain claim a', Y);
  note(space, 'plain claim b', [0, 0, 1]);
  const r = await index({ namespaces: [space], query_embeddings: [spec(X)] }, RUN_OFF);
  assert.strictEqual(r.row_ids.length, 2);
  assert.strictEqual(r.bar.by, 'off');
});

test('a spec floor of 0 turns that leg off: with search lines every note passes the spec leg, with none every note passes the spec-only bar', async () => {
  const space = fresh();
  note(space, 'plain claim a', at(0.2));
  note(space, 'plain claim b', at(0.1));
  const withLines = await index({ namespaces: [space], query_embeddings: [spec(X), line(X)] }, RUN_Z);
  assert.strictEqual(withLines.row_ids.length, 2);
  assert.deepStrictEqual(withLines.bar.listed.map((x) => x.why), ['spec', 'spec']);
  const noLines = await index({ namespaces: [space], query_embeddings: [spec(X)] }, RUN_Z);
  assert.strictEqual(noLines.row_ids.length, 2);
  assert.deepStrictEqual(noLines.bar.listed.map((x) => x.why), ['spec_only', 'spec_only']);
});

test('a subject match lists nothing: a note matching the task text by subject, with a cosine under every floor, is not listed', async () => {
  const space = fresh();
  note(space, 'the widget cache rule', Y, ['widget cache']);
  note(space, 'quokka claim', at(0.2));
  const r = await index({ namespaces: [space], query: 'fix the widget cache', query_embeddings: [spec(X)] });
  assert.deepStrictEqual(r.row_ids, []);
  assert.strictEqual(r.none_passed, true);
});

test('with no vector list (keyword only) no note qualifies by the bar, and the receipt says why', async () => {
  const space = fresh();
  note(space, 'the widget cache rule', Y, ['widget cache']);
  note(space, 'quokka claim', X);
  const r = await index({ namespaces: [space], query: 'fix the widget cache' });
  assert.deepStrictEqual(r.row_ids, []);
  assert.strictEqual(r.bar.by, 'none');
  assert.match(r.bar.reason, /keyword only/);
  assert.strictEqual(r.none_passed, true);
});

test('notes in scope and none passing: none_passed is set with the count; no notes at all: it is not', async () => {
  const space = fresh();
  note(space, 'unrelated gadget claim', Y);
  note(space, 'another unrelated claim', [0, 0, 1]);
  const none = await index({ namespaces: [space], query_embeddings: [spec(X)] });
  assert.deepStrictEqual([none.row_ids, none.bytes, none.none_passed, none.considered], [[], 0, true, 2]);
  const empty = await index({ namespaces: [fresh()], query_embeddings: [spec(X)] });
  assert.strictEqual(empty.none_passed === undefined || empty.none_passed === false, true);
});

test('the nano gate is the namespace\'s stored embedding model, not the caller\'s routing: notes embedded with another model list nothing by the bar, naming the model', async () => {
  const space = fresh();
  note(space, 'the widget cache rule', Y, ['widget cache'], 'heavy-model-x');
  note(space, 'quokka claim', X, [], 'heavy-model-x');
  const r = await index({ namespaces: [space], query: 'fix the widget cache' }); // keyword only: the heavy vectors cannot be compared with a nano query
  assert.deepStrictEqual(r.row_ids, []);
  assert.strictEqual(r.bar.by, 'none');
  assert.match(r.bar.reason, /embedded with heavy-model-x/);
  // and notes stored under nano use the cosine whoever asks
  const space2 = fresh();
  const near = note(space2, 'near the task', X);
  const again = await index({ namespaces: [space2], query_embeddings: [spec(X)] });
  assert.deepStrictEqual(again.row_ids, [near]);
  assert.strictEqual(again.bar.by, 'cosine');
});

test('under the default bar a held or refuted note is not listed, whatever its cosine', async () => {
  const space = fresh();
  const ok = note(space, 'a live claim near the task', X);
  const refuted = note(space, 'a refuted claim near the task', X);
  store.db.prepare("UPDATE memory_entries SET status = 'refuted' WHERE id = ?").run(refuted);
  const r = await index({ namespaces: [space], query_embeddings: [spec(X)] });
  assert.deepStrictEqual(ids(r), [ok]);
});
