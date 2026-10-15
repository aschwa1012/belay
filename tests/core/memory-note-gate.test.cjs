'use strict';
// memory-note-gate.test.cjs — the two-clock gate: one filter for the notes index, memory.search and memory.list. Every clause is
// tested both ways: own run, ended (task done / lease released / run closed), not refuted, live (pending, promoted, superseded),
// held notes stay, the operator is not gated, and retrieve by id is not filtered.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Store } = core('store.cjs');
const { Engine } = core('engine.cjs');
const rows = core('rows.cjs');
const G = core('memory-note-gate.cjs');

let dir, store, E;
const READER = 'rn-reader', WRITER = 'rn-writer';
const orch = (run) => callerFor('orchestrator', { run_id: run });
const call = (caller, method, args = {}) => E.handle(method, { caller, ...args });
let n = 0;
const fresh = () => `project/gate-${++n}`;

before(async () => {
  dir = sandbox();
  store = new Store(`${dir}/memory.db`, { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: null, owner: null, establishedBy: 'test' });
  const lv = JSON.stringify({ project: 'acme', notes: true });
  for (const r of [READER, WRITER]) await call(orch(r), 'run.attach', { adapter_pid: process.pid, project: 'acme', memory_levers: lv });
});
after(() => { store.close(); cleanup(dir); });

function task(id, run, state) { return rows.append(store, 'task', { id, run_id: run, spec: 'x', state }, 'test'); }
function lease(taskId, run, holder, released) { return rows.append(store, 'lease', { id: `l-${taskId}`, task_id: taskId, run_id: run, holder, holder_role: 'worker', granted_at: 1, expires_at: Date.now() + 1e6, released_at: released ? Date.now() : null }, 'test'); }
function endRun(id) { rows.append(store, 'run', { ...rows.current(store, 'run', id), ended_at: Date.now(), exit_reason: 'test' }, 'test'); }

// A note of the writer's, on a task of the writer's run (or none).
function note(space, title, over = {}) {
  const { run_id = WRITER, task_id = null, worker_id = 'w1', status, body = {}, supersedes } = over;
  const r = store.storeIn({
    namespace: space, worker_id, type: over.type || 'note', text: `${title} gatecase`, title,
    body: { kind: 'lesson', basis: 'inferred', evidence: [], applies_to: [], subjects: [], model: 'm', state: 'live', seen_in: [], seen_total: 0, reported_wrong: [], ...body },
    embedding: [1, 0, 0], embedding_model: 'm', embedding_revision: 'r', dim: 3, run_id, task_id, source: 'model', written_by: `worker:${worker_id}`,
    ...(supersedes ? { supersedes } : {}),
  });
  if (status) store.db.prepare('UPDATE memory_entries SET status = ? WHERE id = ?').run(status, r.id);
  return r.id;
}

// What a caller sees of one namespace through each of the three routes.
async function seen(caller, space, extra = {}) {
  const idx = await call(caller, 'memory.index', { namespaces: [space], query: 'gatecase', ...extra.index });
  const srch = await call(caller, 'memory.search', { namespaces: [space], query: 'gatecase', mode: 'keyword', k: 50, ...extra.search });
  const list = await call(caller, 'memory.list', { namespaces: [space], ...extra.list });
  return { index: idx.row_ids, search: srch.results.map((r) => r.id), list: list.rows.map((r) => r.id) };
}
const everywhere = async (caller, space, id, extra) => { const s = await seen(caller, space, extra); return [s.index.includes(id), s.search.includes(id), s.list.includes(id)]; };
const ALL = [true, true, true], NONE = [false, false, false];

test('own run: visible at once, before its task ends; another run sees nothing until then', async () => {
  const space = fresh();
  task('t-own', WRITER, 'assigned'); lease('t-own', WRITER, 'w1', false);
  const id = note(space, 'in progress', { task_id: 't-own' });
  assert.deepStrictEqual(await everywhere(orch(WRITER), space, id), ALL, 'the writer\'s run');
  assert.deepStrictEqual(await everywhere(orch(READER), space, id), NONE, 'another run, task not ended');
});

test('clause a: the task is done', async () => {
  const space = fresh();
  task('t-done', WRITER, 'done'); lease('t-done', WRITER, 'w1', false);
  assert.deepStrictEqual(await everywhere(orch(READER), space, note(space, 'done task', { task_id: 't-done' })), ALL);
});

test('clause a: the writer\'s lease is released, a failed acceptance included', async () => {
  const space = fresh();
  task('t-rel', WRITER, 'released'); lease('t-rel', WRITER, 'w1', true);
  const id = note(space, 'handed back', { task_id: 't-rel' });
  assert.deepStrictEqual(await everywhere(orch(READER), space, id), ALL);
  // Another worker's released lease on the same task does not end THIS writer's notes.
  task('t-other', WRITER, 'assigned'); lease('t-other', WRITER, 'w9', true);
  assert.deepStrictEqual(await everywhere(orch(READER), space, note(space, 'not the writer\'s lease', { task_id: 't-other' })), NONE);
});

test('clause a: the note\'s run is closed', async () => {
  const space = fresh();
  await call(orch('rn-closing'), 'run.attach', { adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', notes: true }) });
  task('t-run', 'rn-closing', 'assigned'); lease('t-run', 'rn-closing', 'w1', false);
  const id = note(space, 'run open then closed', { run_id: 'rn-closing', task_id: 't-run' });
  assert.deepStrictEqual(await everywhere(orch(READER), space, id), NONE, 'run still open');
  endRun('rn-closing');
  assert.deepStrictEqual(await everywhere(orch(READER), space, id), ALL, 'run closed');
});

test('clause a: no task row and no run row says nothing is still writing it', async () => {
  const space = fresh();
  assert.deepStrictEqual(await everywhere(orch(READER), space, note(space, 'orphan', { run_id: 'old-run', task_id: null })), ALL);
  assert.deepStrictEqual(await everywhere(orch(READER), space, note(space, 'open run, no task', { run_id: WRITER, task_id: null })), NONE);
});

test('clause b: refuted is hidden, even from the writer\'s run; unverified and verified are visible', async () => {
  const space = fresh();
  task('t-b', WRITER, 'done');
  const refuted = note(space, 'refuted', { task_id: 't-b', status: 'refuted' });
  const verified = note(space, 'verified', { task_id: 't-b', status: 'verified' });
  const unverified = note(space, 'unverified', { task_id: 't-b', status: 'unverified' });
  for (const who of [orch(READER), orch(WRITER)]) {
    assert.deepStrictEqual(await everywhere(who, space, refuted), NONE);
    assert.deepStrictEqual(await everywhere(who, space, verified), ALL);
    assert.deepStrictEqual(await everywhere(who, space, unverified), ALL);
  }
});

test('clause c: a pending state, a promoted note and a superseded note are not live; a held note stays, with its body', async () => {
  const space = fresh();
  task('t-c', WRITER, 'done');
  const pending = note(space, 'pending state', { task_id: 't-c', body: { state: 'pending' } });
  const promoted = note(space, 'promoted', { task_id: 't-c', body: { promoted_to: { file: 'CLAUDE.md' } } });
  const old = note(space, 'old', { task_id: 't-c' });
  const newer = note(space, 'newer', { task_id: 't-c', supersedes: old });
  const held = note(space, 'held', { task_id: 't-c', body: { held: { kind: 'wrong', reason: 'being checked', row: 'h1' } } });
  for (const who of [orch(READER), orch(WRITER)]) {
    assert.deepStrictEqual(await everywhere(who, space, pending), NONE);
    assert.deepStrictEqual(await everywhere(who, space, promoted), NONE);
    assert.deepStrictEqual(await everywhere(who, space, old), NONE);
    assert.deepStrictEqual(await everywhere(who, space, newer), ALL);
    assert.deepStrictEqual(await everywhere(who, space, held), ALL);
  }
  const inc = await seen(orch(READER), space, { search: { include_superseded: true } });
  assert.ok(inc.search.includes(old), 'a search that asks for superseded rows still gets them');
  const idx = await call(orch(READER), 'memory.index', { namespaces: [space], query: 'gatecase' });
  assert.match(idx.text, /\[held: wrong, being checked\]/, 'the held note shows its warning line');
});

test('pending, archive and held namespaces are kept out by namespace: the project read does not reach them, and a named read does', async () => {
  const proj = fresh(), archive = proj.replace('project/', 'archive/');
  task('t-ns', WRITER, 'done');
  const a = note(archive, 'archived', { task_id: 't-ns' });
  const p = note(proj, 'live', { task_id: 't-ns' });
  const viaProject = await seen(orch(READER), proj);
  assert.ok(viaProject.search.includes(p) && !viaProject.search.includes(a));
  assert.ok((await seen(orch(READER), archive)).search.includes(a), 'the reviewer names the archive on purpose');
});

test('only notes are gated, and the operator is not', async () => {
  const space = fresh();
  task('t-op', WRITER, 'assigned');
  const open = note(space, 'still open', { task_id: 't-op' });
  const summary = note(space, 'a summary', { task_id: 't-op', type: 'summary' });
  const reader = await seen(orch(READER), space);
  assert.ok(!reader.search.includes(open));
  assert.ok(reader.search.includes(summary) && reader.list.includes(summary), 'a non-note row is not gated');
  assert.deepStrictEqual(await everywhere(callerFor('operator'), space, open, { index: {} }), [false, true, true], 'the operator sees the open note in search and list (the index lists notes of a run, and the operator has none)');
  assert.strictEqual(G.sql(E, callerFor('operator')), null);
});

test('retrieve by explicit id is not filtered: it returns a hidden row with its status', async () => {
  const space = fresh();
  task('t-get', WRITER, 'assigned');
  const id = note(space, 'hidden but retrievable', { task_id: 't-get', status: 'refuted' });
  assert.deepStrictEqual(await everywhere(orch(READER), space, id), NONE);
  const got = await call(orch(READER), 'memory.get', { id });
  assert.strictEqual(got.found, true);
  assert.strictEqual(got.status, 'refuted');
  assert.strictEqual(G.visible(E, orch(READER), id), false, 'the gate itself says hidden');
});
