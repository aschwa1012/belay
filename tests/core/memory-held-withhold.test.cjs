'use strict';
// memory-held-withhold.test.cjs — ADR 0047 amendment (2026-10-22): under memory.held_visibility 'withhold' (the default) a worker does not see a
// note held on a report (ground reported, kind wrong or superseded) until it is settled; 'warn' keeps today's display; the orchestrator, the
// knowledge agent and the operator always see it. A read filter: the reads below change no row.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { withTeardown } = require('../helpers/teardown.cjs');

const { Store } = core('store.cjs');
const { Engine } = core('engine.cjs');
const G = core('memory-note-gate.cjs');

let dir, store, E;
const call = (caller, method, args = {}) => E.handle(method, { caller, ...args });
const worker = (run, id = 'w-reader') => callerFor('worker', { run_id: run, worker_id: id });
const orch = (run) => callerFor('orchestrator', { run_id: run });
const SPACE = 'project/hv';
const RUNS = { withhold: 'hv-withhold', warn: 'hv-warn', writer: 'hv-writer' };

before(async () => {
  dir = sandbox();
  store = new Store(`${dir}/memory.db`, { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: null, owner: null, establishedBy: 'test' });
  const on = JSON.stringify({ project: 'hv', notes: true });
  const warn = JSON.stringify({ project: 'hv', notes: true, held_visibility: 'warn' });
  await call(orch(RUNS.writer), 'run.attach', { adapter_pid: process.pid, project: 'hv', memory_levers: on });
  await call(orch(RUNS.withhold), 'run.attach', { adapter_pid: process.pid, project: 'hv', memory_levers: on });
  await call(orch(RUNS.warn), 'run.attach', { adapter_pid: process.pid, project: 'hv', memory_levers: warn });
});
after(() => withTeardown(() => {}, [() => store.close(), () => cleanup(dir)]));

let n = 0;
function note(title) {
  return store.storeIn({
    namespace: SPACE, worker_id: 'w1', type: 'note', text: `${title} withholdcase`, title,
    body: { kind: 'lesson', basis: 'inferred', evidence: [], applies_to: [], subjects: [], model: 'm', state: 'live', seen_in: [], seen_total: 0, reported_wrong: [] },
    embedding: [1, 0, 0], embedding_model: 'm', embedding_revision: 'r', dim: 3, run_id: 'gone-run', task_id: null, source: 'model', written_by: 'worker:w1',
  }).id;
}
function hold(noteId, over = {}) {
  const body = { state: 'held', note_id: noteId, kind: 'wrong', ground: 'reported', reports: [{ key: `k${++n}`, by: 'orchestrator', why: 'x', at: 1 }], rev: 1, ...over };
  return store.storeIn({ namespace: 'held/hv', worker_id: 'harness', type: 'held', text: `held ${noteId}`, title: 'h', body, run_id: 'gone-run', source: 'harness', written_by: 'harness' }).id;
}
const setState = (heldId, state) => store.patchBody(heldId, (b) => { b.state = state; return b; });

async function seen(caller, id) {
  const idx = await call(caller, 'memory.index', { namespaces: [SPACE], query: 'withholdcase' });
  const srch = await call(caller, 'memory.search', { namespaces: [SPACE], query: 'withholdcase', mode: 'keyword', k: 50 });
  const list = await call(caller, 'memory.list', { namespaces: [SPACE] });
  return [idx.row_ids.includes(id), srch.results.some((r) => r.id === id), list.rows.some((r) => r.id === id)];
}
const ALL = [true, true, true], NONE = [false, false, false];

test('withhold: a worker does not see a note held on a report; every other reader does', async () => {
  const id = note('withheld one');
  hold(id);
  assert.deepStrictEqual(await seen(worker(RUNS.withhold), id), NONE);
  assert.deepStrictEqual(await seen(orch(RUNS.withhold), id), ALL);
  assert.deepStrictEqual(await seen(callerFor('worker', { run_id: RUNS.withhold, worker_id: 'knowledge-1' }), id), ALL);
  assert.deepStrictEqual((await seen(callerFor('operator'), id)).slice(1), [true, true]); // the operator's CLI reads search and list
  assert.strictEqual(G.withholds(E, worker(RUNS.withhold)), true);
});

test('warn: the note stays visible to a worker, as before', async () => {
  const id = note('warned one');
  hold(id);
  assert.deepStrictEqual(await seen(worker(RUNS.warn), id), ALL);
  assert.strictEqual(G.withholds(E, worker(RUNS.warn)), false);
});

test('a hold of another ground or kind, or a report that does not withhold, hides nothing', async () => {
  const a = note('duplicate hold'); hold(a, { kind: 'duplicate', ground: 'same_claim' });
  const b = note('unsupported hold'); hold(b, { kind: 'unsupported', ground: 'unsupported' });
  const c = note('breaker hold'); hold(c, { reports: [{ key: 'kc', by: 'worker:w9', why: 'x', at: 1, withhold: false }] });
  const d = note('superseded hold'); hold(d, { kind: 'superseded' });
  for (const id of [a, b, c]) assert.deepStrictEqual(await seen(worker(RUNS.withhold), id), ALL);
  assert.deepStrictEqual(await seen(worker(RUNS.withhold), d), NONE);
});

test('released as correct reappears at once; archived stays gone; undecided stays withheld', async () => {
  const id = note('settled one');
  const h = hold(id);
  assert.deepStrictEqual(await seen(worker(RUNS.withhold), id), NONE);
  store.patchBody(h, (b) => { b.undecided = { rev: 1, reason: 'cannot say' }; return b; });
  assert.deepStrictEqual(await seen(worker(RUNS.withhold), id), NONE);
  setState(h, 'released');
  assert.deepStrictEqual(await seen(worker(RUNS.withhold), id), ALL);
  const gone = note('archived one');
  setState(hold(gone), 'archived');
  store.db.prepare("UPDATE memory_entries SET status = 'refuted' WHERE id = ?").run(gone);
  assert.deepStrictEqual(await seen(worker(RUNS.withhold), gone), NONE);
  assert.deepStrictEqual(await seen(orch(RUNS.withhold), gone), NONE);
});

test('the search counts stay honest and a read changes no file or row', async () => {
  const id = note('counted one');
  hold(id);
  const w = await call(worker(RUNS.withhold), 'memory.search', { namespaces: [SPACE], query: 'counted', mode: 'keyword', k: 50 });
  const o = await call(orch(RUNS.withhold), 'memory.search', { namespaces: [SPACE], query: 'counted', mode: 'keyword', k: 50 });
  assert.strictEqual(w.results.length, 0);
  assert.strictEqual(o.results.length, 1);
  for (const k of Object.keys(w)) if (typeof w[k] === 'number' && /total|count|found/.test(k)) assert.strictEqual(w[k], 0, k);
  const files = fs.readdirSync(dir).sort();
  const sum = store.db.prepare('SELECT COUNT(*) AS n, MAX(rowid) AS s FROM memory_entries').get();
  await seen(worker(RUNS.withhold), id);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), files);
  assert.deepStrictEqual(store.db.prepare('SELECT COUNT(*) AS n, MAX(rowid) AS s FROM memory_entries').get(), sum);
});
