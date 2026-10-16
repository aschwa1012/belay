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
// A lease row; `by` is who wrote the row (a hand-back is written by the holder, a take-control by the operator).
function lease(taskId, run, holder, released, { id = `l-${taskId}`, granted_at = 1, by = holder } = {}) { return rows.append(store, 'lease', { id, task_id: taskId, run_id: run, holder, holder_role: 'worker', granted_at, expires_at: Date.now() + 1e6, released_at: released ? Date.now() : null }, by); }
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

test('clause a: a reassigned writer\'s new lease is open, and a take-control is not a hand-back', async () => {
  const space = fresh();
  // w1 hands back L1, is granted the task again as L2 (still working) and writes a note under L2.
  task('t-re', WRITER, 'assigned');
  lease('t-re', WRITER, 'w1', true, { id: 'l-re-1', granted_at: 1 });
  lease('t-re', WRITER, 'w1', false, { id: 'l-re-2', granted_at: 2 });
  const reassigned = note(space, 'written under the second lease', { task_id: 't-re' });
  assert.deepStrictEqual(await everywhere(orch(READER), space, reassigned), NONE, 'L1 was handed back but L2 is open');
  lease('t-re', WRITER, 'w1', true, { id: 'l-re-2', granted_at: 2 });
  assert.deepStrictEqual(await everywhere(orch(READER), space, reassigned), ALL, 'L2 handed back');
  // The operator takes the lease over: the row is released, by the operator, and the worker never handed back.
  task('t-tc', WRITER, 'assigned');
  lease('t-tc', WRITER, 'w1', false, { id: 'l-tc' });
  const taken = note(space, 'worker whose lease was taken', { task_id: 't-tc' });
  lease('t-tc', WRITER, 'w1', true, { id: 'l-tc', by: 'operator' });
  assert.deepStrictEqual(await everywhere(orch(READER), space, taken), NONE, 'take-control is not a hand-back');
  task('t-tc', WRITER, 'done');
  assert.deepStrictEqual(await everywhere(orch(READER), space, taken), ALL, 'visible once the task is done');
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

test('the lifecycle namespaces are refused to a tool-channel worker or orchestrator on index, search and list; the harness and the operator keep them', async () => {
  task('t-ns', WRITER, 'done');
  const proj = fresh();
  const p = note(proj, 'live', { task_id: 't-ns' });
  assert.ok((await seen(orch(READER), proj)).search.includes(p), 'the project read still works');
  for (const prefix of ['archive/', 'held/', 'pending/', 'proposal/', 'draft/', 'nomination/']) {
    const space = proj.replace('project/', prefix);
    const id = note(space, `in ${prefix}`, { task_id: 't-ns' });
    const worker = callerFor('worker', { run_id: READER, worker_id: 'w-read' });
    for (const who of [orch(READER), worker]) {
      for (const [method, args] of [['memory.index', { namespaces: [space] }], ['memory.search', { namespaces: [space], query: 'gatecase', mode: 'keyword' }], ['memory.list', { namespaces: [space] }]]) {
        await assert.rejects(call(who, method, args), (e) => e.code === 'E_ROLE' && e.detail && e.detail.namespace === space, `${who.role} ${method} ${space}`);
      }
    }
    const harness = { ...orch(READER), channel: 'harness' };
    assert.ok((await call(harness, 'memory.search', { namespaces: [space], query: 'gatecase', mode: 'keyword' })).results.some((r) => r.id === id), `harness reads ${prefix}`);
    assert.ok((await call(callerFor('operator'), 'memory.list', { namespaces: [space] })).rows.some((r) => r.id === id), `operator reads ${prefix}`);
  }
});

test('a note with no task, written by the orchestrator in another open run, stays hidden until that run ends', async () => {
  const space = fresh();
  await call(orch('rn-orch-open'), 'run.attach', { adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', notes: true }) });
  const id = note(space, 'orchestrator note', { run_id: 'rn-orch-open', task_id: null, worker_id: 'orchestrator' });
  assert.deepStrictEqual(await everywhere(orch(READER), space, id), NONE, 'its run is open');
  assert.deepStrictEqual(await everywhere(orch('rn-orch-open'), space, id), ALL, 'its own run sees it');
  endRun('rn-orch-open');
  assert.deepStrictEqual(await everywhere(orch(READER), space, id), ALL, 'visible once the run ends');
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

test('memory.timeline goes through the gate: a hidden anchor is not found, and the sides leave hidden notes out', async () => {
  const space = fresh();
  task('t-tl', WRITER, 'done');
  task('t-tl-open', WRITER, 'assigned');
  const first = note(space, 'visible first', { task_id: 't-tl' });
  const refuted = note(space, 'refuted between', { task_id: 't-tl', status: 'refuted' });
  const promoted = note(space, 'promoted between', { task_id: 't-tl', body: { promoted_to: { file: 'CLAUDE.md' } } });
  const openRun = note(space, 'another run still working', { task_id: 't-tl-open' });
  const last = note(space, 'visible last', { task_id: 't-tl' });
  const tl = await call(orch(READER), 'memory.timeline', { anchor_id: first, scope: 'namespace', before: 10, after: 10, view: 'index' });
  const ids = [...tl.before, tl.anchor, ...tl.after].map((r) => r.id);
  assert.ok(ids.includes(first) && ids.includes(last));
  for (const hidden of [refuted, promoted, openRun]) assert.ok(!ids.includes(hidden), 'a hidden note is not in the timeline');
  await assert.rejects(call(orch(READER), 'memory.timeline', { anchor_id: refuted }), (e) => e.code === 'E_NOT_FOUND');
  const own = await call(orch(WRITER), 'memory.timeline', { anchor_id: first, scope: 'namespace', before: 10, after: 10, view: 'index' });
  assert.ok([...own.before, own.anchor, ...own.after].some((r) => r.id === openRun), 'the writer\'s own run still sees its open note');
  const archive = fresh().replace('project/', 'archive/');
  const archived = note(archive, 'archived anchor', { task_id: 't-tl' });
  await assert.rejects(call(orch(READER), 'memory.timeline', { anchor_id: archived }), (e) => e.code === 'E_ROLE', 'a lifecycle namespace is refused on the timeline too');
});

test('the search results leave out promoted and pending notes (the body clauses run on the returned rows)', async () => {
  const space = fresh();
  task('t-cnt', WRITER, 'done');
  note(space, 'counted', { task_id: 't-cnt' });
  note(space, 'promoted', { task_id: 't-cnt', body: { promoted_to: { file: 'CLAUDE.md' } } });
  note(space, 'pending', { task_id: 't-cnt', body: { state: 'pending' } });
  const r = await call(orch(READER), 'memory.search', { namespaces: [space], query: 'gatecase', mode: 'keyword' });
  assert.strictEqual(r.results.length, 1);
  assert.strictEqual(r.searched.rows_considered, 3, 'the count is not a body scan: it still counts them');
});

test('bodySql and bodyLive agree, an invalid-JSON body that mentions pending included', async () => {
  const space = fresh();
  task('t-bd', WRITER, 'done');
  const bodies = [{ ok: 1 }, { promoted_to: { file: 'x' } }, { state: 'pending' }, { note: 'pending review is a word here' }, { state: 'live' }];
  const ids = bodies.map((b, i) => note(space, `body ${i}`, { task_id: 't-bd', body: b }));
  const bad = note(space, 'invalid body', { task_id: 't-bd' });
  store.db.prepare('UPDATE memory_entries SET body = ? WHERE id = ?').run('{ not json, pending and promoted_to', bad);
  for (const id of [...ids, bad]) {
    const row = store.db.prepare('SELECT type, body FROM memory_entries WHERE id = ?').get(id);
    const viaSql = !!store.db.prepare(`SELECT 1 AS x FROM memory_entries e WHERE e.id = ? AND ${G.bodySql('e')}`).get(id);
    assert.strictEqual(viaSql, G.bodyLive(row), `row ${id}: ${row.body}`);
  }
  assert.strictEqual(G.bodyLive({ type: 'note', body: '{ not json, pending' }), true);
});
