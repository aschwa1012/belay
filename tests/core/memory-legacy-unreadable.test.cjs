'use strict';
// memory-legacy-unreadable.test.cjs — in a run with notes on, a worker and the orchestrator cannot read a row of project/<p> that is not a note, on any
// route (search in all three modes, list, timeline, get, get_many, corpus); the operator's reads and a notes-off run's are unchanged; no read writes
// (ADR 0047 amendment of 2026-10-22, decision 4).

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { setup } = require('./report-env.cjs');

let X, Y;
before(async () => {
  X = await setup('r-lg');
  Y = await setup('r-lg-off', { notes: false });
  // The legacy rows sit on axis 3 and the note on axis 7, so a semantic query on axis 3 ranks every legacy row above the note.
  ids = [legacy(X, 'fact', 'legacyterm fact about the loader', 3, T0), legacy(X, 'episode', 'legacyterm episode of a run', 3, T0 + 1000), legacy(X, 'imported', 'legacyterm imported row', 3, T0 + 2000)];
  noteId = (await X.call('memory.store', X.orch, { namespace: 'project', ...X.note('K7') })).id;
  X.store.db.prepare('UPDATE memory_entries SET created_at = ? WHERE id = ?').run(T0 + 1500, noteId);
  // More legacy rows than the semantic stage keeps (60 at least), all nearer the query than the note: only the scan's own exclusion lets the note through.
  for (let i = 0; i < 65; i++) legacy(X, 'fact', `legacyterm bulk row ${i}`, 3, T0 - 10000 - i);
  ids.push(legacy(Y, 'fact', 'legacyterm fact about the loader', 3, T0));
});
after(async () => { await X.cleanup(); await Y.cleanup(); });

const T0 = Date.now() - 60000;
// A row as an older release or the operator would have left it in the project: a type that is not note, written straight to the store.
function legacy(env, type, text, k, created) {
  const v = new Array(64).fill(0); v[k] = 1;
  const r = env.store.storeIn({ namespace: 'project/acme', worker_id: 'old', type, text, title: text.slice(0, 40), embedding: v, embedding_model: 'fake', embedding_revision: 'r', dim: 64, run_id: 'r-old', source: type === 'import' ? 'import' : 'model', written_by: 'harness', created_at: created });
  env.store.db.prepare("UPDATE memory_entries SET status = 'verified' WHERE id = ?").run(r.id); // the corpus lists verified rows
  return r.id;
}
const vec = (k) => { const v = new Array(64).fill(0); v[k] = 1; return v; };
let ids, noteId;


const fileState = (env) => ['', '-wal', '-shm'].map((s) => { try { const st = fs.statSync(`${env.dir}/memory.db${s}`); return `${s}:${st.size}:${st.mtimeMs}`; } catch { return `${s}:absent`; } }).join('|');
const READERS = () => [['orchestrator', X.orch], ['worker', X.worker('w-lg')]];

test('LG1: search finds the note and none of the legacy rows, in keyword, semantic and hybrid modes, for the orchestrator and a worker', async () => {
  await X.startTask('w-lg', 'a stream\n');
  const before = fileState(X);
  for (const [who, caller] of READERS()) {
    // k 1 on axis 3: the legacy rows would fill the page if the scan did not leave them out, and the note would be missing
    const sem = await X.call('memory.search', caller, { namespaces: ['project/acme'], query: 'legacyterm loader', mode: 'semantic', query_embedding: vec(3), embedding_model: 'fake', k: 1 });
    assert.deepStrictEqual(sem.results.map((x) => x.id), [noteId], `${who} semantic k 1`);
    for (const mode of ['keyword', 'semantic', 'hybrid']) {
      const r = await X.call('memory.search', caller, { namespaces: ['project/acme'], query: 'legacyterm loader episode imported', mode, query_embedding: vec(7), embedding_model: 'fake', k: 20 });
      const got = r.results.map((x) => x.id);
      for (const id of ids.slice(0, 3)) assert.ok(!got.includes(id), `${who} ${mode} must not see ${id}`);
      if (mode !== 'keyword') assert.ok(got.includes(noteId), `${who} ${mode} still finds the note`);
    }
  }
  assert.strictEqual(fileState(X), before, 'a read changed the store file');
});

test('LG2: list, timeline (as anchor and as neighbour), get and get_many answer as if the legacy rows were absent', async () => {
  for (const [who, caller] of READERS()) {
    const list = await X.call('memory.list', caller, { namespaces: ['project/acme'] });
    assert.deepStrictEqual(list.rows.map((r) => r.id), [noteId], who);
    assert.strictEqual(list.total, 1, who);
    const tl = await X.call('memory.timeline', caller, { anchor_id: noteId, scope: 'namespace', before: 10, after: 10 });
    assert.deepStrictEqual([...tl.before, ...tl.after].map((r) => r.id), [], `${who}: no legacy neighbour`);
    await assert.rejects(X.call('memory.timeline', caller, { anchor_id: ids[1], scope: 'namespace' }), (e) => e.code === 'E_NOT_FOUND', `${who}: legacy anchor`);
    const one = await X.call('memory.get', caller, { id: ids[0] });
    assert.strictEqual(one.found, false, who);
    const many = await X.call('memory.get', caller, { ids: [ids[0], noteId, ids[2]] });
    assert.deepStrictEqual(many.rows.map((r) => r.found), [false, true, false], who);
  }
});

test('LG3: the operator reads every row, as before', async () => {
  const list = await X.call('memory.list', X.operator, { namespaces: ['project/acme'] });
  for (const id of ids.slice(0, 3)) assert.ok(list.rows.some((r) => r.id === id), id);
  assert.strictEqual((await X.call('memory.get', X.operator, { id: ids[0] })).found, true);
  const tl = await X.call('memory.timeline', X.operator, { anchor_id: noteId, scope: 'namespace', before: 10, after: 10 });
  const around = [...tl.before, ...tl.after].map((r) => r.id);
  for (const id of ids.slice(0, 3)) assert.ok(around.includes(id), `timeline neighbour ${id}`);
  // 'legacyterm' is in most rows of the namespace, so the keyword stage leaves it out as uninformative; the words that tell the three rows apart are the query.
  const s = await X.call('memory.search', X.operator, { namespaces: ['project/acme'], query: 'loader episode imported', mode: 'keyword', k: 100 });
  for (const id of ids.slice(0, 3)) assert.ok(s.results.some((r) => r.id === id), `operator keyword search finds ${id}`);
});

test('LG4: a run with notes off reads its legacy rows as before', async () => {
  const id = ids[3];
  assert.strictEqual((await Y.call('memory.get', Y.orch, { id })).found, true);
  assert.ok((await Y.call('memory.list', Y.orch, { namespaces: ['project/acme'] })).rows.some((r) => r.id === id));
  assert.ok((await Y.call('memory.search', Y.orch, { namespaces: ['project/acme'], query: 'legacyterm', mode: 'keyword' })).results.some((r) => r.id === id));
});

test('LG5: the knowledge agent\'s corpus leaves the verified legacy rows out in a notes run, and keeps them with notes off', async () => {
  const on = await X.call('memory.corpus', X.orch, { project: 'acme' });
  assert.ok(!ids.slice(0, 3).some((id) => on.row_ids.includes(id)));
  assert.strictEqual((await X.call('memory.corpus', X.operator, { project: 'acme' })).row_ids.filter((id) => ids.includes(id)).length, 3, 'the operator corpus keeps them');
  const off = await Y.call('memory.corpus', Y.orch, { project: 'acme' });
  assert.ok(off.row_ids.includes(ids[3]));
});
