'use strict';
// memory-k2-chances.test.cjs — a note a worker was shown by memory_list or memory_timeline is a delivery like a search result, so a
// sighting by a worker who had read it there is not an independent one. Real Engine over a stamped store; no model.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Store } = core('store.cjs');
const { Engine } = core('engine.cjs');
const NM = require('../../src/core/memory-nominate.cjs');

let dir, store, E;
const RUN = 'k2c-run';
const orch = callerFor('orchestrator', { run_id: RUN });
const call = (method, args = {}) => E.handle(method, { caller: orch, ...args });

before(async () => {
  dir = sandbox();
  store = new Store(`${dir}/memory.db`, { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: null, owner: null, establishedBy: 'test' });
  await call('run.attach', { adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', notes: true, first_message_index: true, notes_sink: 'record' }) });
  for (const id of ['w1', 'w2']) await call('worker.write', { id, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: `s-${id}`, last_event_at: Date.now(), model: 'claude-test-1' });
});
after(() => { store.close(); cleanup(dir); });

function note(title, over = {}) {
  return store.storeIn({
    namespace: 'project/acme', worker_id: 'w0', type: 'note', text: `${title}\n`, title,
    body: { kind: 'lesson', basis: 'observed', evidence: [{ where: 'src/x.js', saw: 'saw it' }], applies_to: [], subjects: [], model: 'm', state: 'live', seen_in: [], seen_total: 0, reported_wrong: [], ...(over.body || {}) },
    embedding: [1, 0, 0], embedding_model: 'm', embedding_revision: 'r', dim: 3, run_id: over.run_id || 'old-run', task_id: over.task_id || null, source: 'model', written_by: over.written_by || 'worker:w0',
  }).id;
}
async function task(w, spec) {
  const t = await call('task.create', { spec });
  await call('task.assign', { task_id: t.id, worker_id: w });
  return t.id;
}

test('recordChances takes a list and a timeline as routes, and an unknown route is still refused', async () => {
  const n = note('listed claim');
  const t = await task('w1', 'reads the list');
  const out = await call('memory.recordChances', { task_id: t, worker_id: 'w1', shown: [{ route: 'list', ids: [n], at: 4000 }, { route: 'timeline', ids: [n], at: 4100 }] });
  assert.deepStrictEqual(out.chances.map(c => [c.note_id, c.route]).sort(), [[n, 'list'], [n, 'timeline']]);
  const d = (await call('memory.noteDeliveries', { note_id: n })).deliveries;
  assert.deepStrictEqual(d.map(x => [x.worker_id, x.route]).sort(), [['w1', 'list'], ['w1', 'timeline']]);
  const t2 = await task('w2', 'other');
  await assert.rejects(call('memory.recordChances', { task_id: t2, worker_id: 'w2', shown: [{ route: 'browse', ids: [n] }] }), x => x.code === 'E_ARGS' && /list/.test(x.message));
});

test('a writer who had read the note in a list is not an independent sighting of it', async () => {
  const author = note('promotion candidate', { task_id: 'k2c-author', run_id: 'k2c-run', written_by: 'worker:w0' });
  const readers = [];
  for (const w of ['w1', 'w2']) {
    const t = await task(w, `seen by ${w}`);
    readers.push({ w, t });
  }
  // w1 saw the note in a list before it handed the same lesson back; w2 never saw it
  await call('memory.recordChances', { task_id: readers[0].t, worker_id: 'w1', shown: [{ route: 'list', ids: [author], at: 1000 }] });
  store.patchBody(author, b => {
    b.seen_in = readers.map(r => ({ task_id: r.t, written_by: `worker:${r.w}`, run_id: RUN, in_index_beforehand: false, at: 5000, evidence: [] }));
    return b;
  });
  const row = store.p('SELECT id, task_id, run_id, written_by, created_at, body FROM memory_entries WHERE id = ?').get(author);
  const deliveries = (await call('memory.noteDeliveries', { note_id: author })).deliveries;
  const c = NM.countSightings(E, row, deliveries);
  assert.deepStrictEqual(c.excluded.map(x => [x.writer, x.shown_by]), [['worker:w1', 'list']]);
  assert.deepStrictEqual(c.sightings.filter(s => s.via !== 'author').map(s => s.writer), ['worker:w2']);
});
