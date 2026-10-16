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
  assert.deepStrictEqual(Object.keys(r.candidates), ['source', 'scope', 'vector', 'keyword', 'path', 'union', 'padding', 'total', 'path_mode']);
  assert.strictEqual(r.candidates.source, 'hybrid');
  assert.strictEqual(r.row_ids[0], hit);
  assert.strictEqual(r.relevance.fusion.method, 'rrf');
});

// ---- path candidates ----

const task = async (k, spec, owned) => (await E.handle('task.create', { caller: orch(k), spec, files_owned: owned })).id;
function anchored(space, title, paths, over = {}) {
  const r = store.storeIn({
    namespace: space, worker_id: 'w1', type: 'note', text: title, title,
    body: { kind: 'lesson', basis: 'inferred', evidence: [], applies_to: paths, subjects: [], model: 'm', state: 'live', seen_in: [], seen_total: 0, reported_wrong: [] },
    embedding: [1, 0, 0], embedding_model: 'm', embedding_revision: 'r', dim: 3, run_id: 'old-run', task_id: null, source: 'model', written_by: 'worker:w1',
  });
  store.db.prepare('UPDATE memory_entries SET created_at = ? WHERE id = ?').run(over.created_at || 1000 + n++, r.id);
  return r.id;
}

test('a note anchored to the task files is a candidate although no text of the task matches it, and leads under no relevance signal', async () => {
  const space = fresh();
  const target = anchored(space, 'zzqx unrelated words', ['src/special/thing.cjs'], { created_at: 5 });
  crowd(space, 900);
  const t = await task('on', 'ok', ['src/special/thing.cjs']);
  const r = await index('on', { namespaces: [space], task_id: t });
  assert.strictEqual(r.row_ids[0], target);
  assert.strictEqual(r.candidates.source, 'path');
  assert.strictEqual(r.candidates.path, 1);
  assert.strictEqual(r.candidates.scope, 901);
});

test('path idf is taken over the store, not over the candidates', async () => {
  const space = fresh();
  const common = 'src/common/x.cjs';
  anchored(space, 'target by a rare path', ['src/rare/y.cjs'], { created_at: 5 });
  for (let i = 0; i < 300; i++) anchored(space, `hub note ${i}`, [common], { created_at: 100 + i });
  const t = await task('on', 'ok', ['src/rare/y.cjs', common]);
  const r = await index('on', { namespaces: [space], task_id: t });

  assert.ok(r.candidates.path <= 200, 'the path list is cut to 200');

  const first = r.text.split('\n')[1];
  assert.match(first, /target by a rare path/, 'the rare path outranks 300 notes on a common one');
});

test('path_mode rrf fuses the path list with relevance; tiebreak leaves relevance first; a bad mode is refused', async () => {
  const space = fresh();
  const text = note(space, 'quokkas loader text match', [1, 0, 0], { created_at: 10 });
  const pathNote = anchored(space, 'other claim', ['src/q.cjs'], { created_at: 20 });
  const t = await task('on', 'quokkas loader', ['src/q.cjs']);
  const a = await index('on', { namespaces: [space], task_id: t, path_mode: 'tiebreak' });
  const b = await index('on', { namespaces: [space], task_id: t, path_mode: 'rrf' });
  assert.deepStrictEqual(a.row_ids, [text, pathNote], 'relevance first');
  assert.deepStrictEqual(b.row_ids, [pathNote, text], 'the path list adds to the score');
  assert.strictEqual(b.relevance.path_fusion.method, 'rrf');
  assert.strictEqual(b.candidates.path_mode, 'rrf');
  await assert.rejects(index('on', { namespaces: [space], task_id: t, path_mode: 'nope' }), (e) => e.code === 'E_ARGS');
});

// ---- the vector sweep ----

test('several query vectors rank in one sweep: the same lists as one vector at a time', async () => {
  const space = fresh();
  note(space, 'alpha claim', [0, 1, 0], { created_at: 10 });
  note(space, 'beta claim', [0, 0, 1], { created_at: 20 });
  const allowed = new Set(R.liveIds(E, orch('on'), [space]));
  const qs = [{ vector: [0, 1, 0], model: null, label: 'one' }, { vector: [0, 0, 1], model: null, label: 'two' }];
  const many = R.cosinesMany(E, [space], allowed, qs, null);
  const solo = qs.map((q) => R.cosinesMany(E, [space], allowed, [q], null).lists[0]);
  assert.deepStrictEqual(many.lists.map((m) => [...m.entries()]), solo.map((m) => [...m.entries()]));
});

test('the time bound covers the whole build and degrades in order: vector lists dropped, keyword, path and newest kept, the receipt says what and why', async () => {
  const space = fresh();
  const hit = note(space, 'quokkas loader claim', [0, 1, 0], { created_at: 10 });
  crowd(space, 300); // more rows than one clock check (every 256) covers
  const allowed = new Set(R.liveIds(E, orch('on'), [space]));
  const qs = [{ vector: [0, 1, 0], model: null, label: 'one' }];
  const base = { text: 'quokkas', source: 'query', queries: qs, boundMs: 5, started: 0 };
  // already past the bound before the sweep starts (a seam clock, no real load)
  const before = R.select(E, [space], [...allowed], { ...base, deadline: 5, clock: () => 10 });
  assert.deepStrictEqual(before.candidates.degraded.dropped, ['vector lists']);
  assert.deepStrictEqual(before.candidates.degraded.kept, ['keyword', 'path', 'newest']);
  assert.match(before.candidates.degraded.reason, /before the vector sweep/);
  assert.strictEqual(before.candidates.degraded.bound_ms, 5);
  assert.strictEqual(before.candidates.degraded.elapsed_ms, 10);
  assert.strictEqual(before.info.semantic.code, 'E_INDEX_BOUND');
  assert.strictEqual(before.candidates.vector, 0);
  assert.ok(before.ids.includes(hit), 'the keyword candidate stands');
  assert.ok(before.candidates.keyword > 0 && before.candidates.padding > 0);
  // passed while the sweep runs: the clock reads 0 for the first checks and 10 at the second row check
  let calls = 0;
  const mid = R.select(E, [space], [...allowed], { ...base, deadline: 5, clock: () => (++calls <= 2 ? 0 : 10) });
  assert.match(mid.candidates.degraded.reason, /during the vector sweep/);
  assert.strictEqual(mid.candidates.vector, 0, 'the half-finished vector lists are not used');
  // inside the bound: nothing is dropped
  const ok = R.select(E, [space], [...allowed], { ...base, deadline: 1000, clock: () => 0 });
  assert.strictEqual(ok.candidates.degraded, undefined);
  assert.ok(ok.candidates.vector > 0);
});

test('memory.index takes index_bound_ms and path_mode as E_ARGS when they are wrong, and a bound of 0 degrades the whole call', async () => {
  const space = fresh();
  note(space, 'quokkas claim', [0, 1, 0]);
  await assert.rejects(index('on', { namespaces: [space], path_mode: 'nope' }), (e) => e.code === 'E_ARGS' && e.detail.field === 'path_mode');
  await assert.rejects(index('on', { namespaces: [space], index_bound_ms: -1 }), (e) => e.code === 'E_ARGS');
  await assert.rejects(index('on', { namespaces: [space], index_bound_ms: 'soon' }), (e) => e.code === 'E_ARGS');
  const r = await index('on', { namespaces: [space], query: 'quokkas', query_embedding: [0, 1, 0], embedding_model: 'm', index_bound_ms: 0 });
  assert.strictEqual(r.candidates.degraded.dropped[0], 'vector lists');
  assert.strictEqual(r.candidates.source, 'keyword');
  assert.strictEqual(r.row_ids.length, 1);
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
