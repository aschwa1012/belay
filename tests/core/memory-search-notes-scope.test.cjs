'use strict';
// memory-search-notes-scope.test.cjs — ADR 0047 decision 6: a run whose notes lever resolved on searches its project's notes
// by default; a named scope, a filter that states types, and a run with notes off keep the search they always had.
// Real Engine over a stamped store, keyword mode, so no model is loaded.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Store } = core('store.cjs');
const { Engine } = core('engine.cjs');

let dir, store, E;
const RUNS = { on: 'sn-on', off: 'sn-off', bare: 'sn-bare' };
const who = (k, role = 'orchestrator') => callerFor(role, { run_id: RUNS[k], ...(role === 'worker' ? { worker_id: 'w1' } : {}) });
const search = (k, args = {}, role) => E.handle('memory.search', { caller: who(k, role), query: 'zebra', mode: 'keyword', ...args });
const ids = r => r.results.map(x => x.id).sort();
const rows = {};

function put(namespace, type, title, run_id = 'old-run') {
  const body = type === 'note'
    ? { kind: 'lesson', basis: 'observed', evidence: [{ where: 'src/x.js', saw: 'saw it' }], applies_to: [], subjects: [], model: 'm', state: 'live', seen_in: [], seen_total: 0, reported_wrong: [] }
    : undefined;
  return store.storeIn({
    namespace, worker_id: 'w1', type, text: `${title} zebra`, title, ...(body ? { body } : {}),
    embedding: [1, 0, 0], embedding_model: 'm', embedding_revision: 'r', dim: 3, run_id, task_id: null, source: 'model', written_by: 'worker:w1',
  }).id;
}

before(async () => {
  dir = sandbox();
  store = new Store(`${dir}/memory.db`, { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: null, owner: null, establishedBy: 'test' });
  const attach = (k, block, project) => E.handle('run.attach', { caller: who(k), adapter_pid: process.pid, ...(project ? { project } : {}), memory_levers: JSON.stringify(block) });
  await attach('on', { project: 'acme' }, 'acme'); // notes unstated: resolves on with a project
  await attach('off', { project: 'acme', notes: false }, 'acme');
  await attach('bare', {});
  rows.note = put('project/acme', 'note', 'the note');
  rows.legacySummary = put('project/acme', 'summary', 'a legacy summary');
  rows.projectFact = put('project/acme', 'fact', 'a project fact');
  rows.runFact = put(`run/${RUNS.on}`, 'fact', 'a run fact', RUNS.on);
  rows.offRunFact = put(`run/${RUNS.off}`, 'fact', 'an off-run fact', RUNS.off);
  rows.bareRunFact = put(`run/${RUNS.bare}`, 'fact', 'a bare-run fact', RUNS.bare);
});
after(() => { store.close(); cleanup(dir); });

test('notes on: a default search covers the project namespace and returns notes only', async () => {
  const r = await search('on');
  assert.deepStrictEqual(r.searched.namespaces, ['project/acme']);
  assert.deepStrictEqual(r.searched.filter, { types: ['note'] });
  assert.deepStrictEqual(ids(r), [rows.note]);
});

test('notes on, as a worker: the same default, inside the worker reach', async () => {
  const r = await search('on', {}, 'worker');
  assert.deepStrictEqual(ids(r), [rows.note]);
});

test('notes on: a named namespace, namespaces or filter.types is kept as given', async () => {
  const run = await search('on', { namespace: `run/${RUNS.on}` });
  assert.deepStrictEqual(ids(run), [rows.runFact]);
  const project = await search('on', { namespace: 'project' });
  // The scope is not narrowed to notes; the project's rows that are not notes are hidden by the reading gate (ADR 0047 amendment of 2026-10-22).
  assert.deepStrictEqual(ids(project), [rows.note], 'an explicit namespace is not narrowed by the default scope; legacy rows are hidden');
  const many = await search('on', { namespaces: ['project/acme', `run/${RUNS.on}`] });
  assert.deepStrictEqual(ids(many), [rows.note, rows.runFact].sort());
  const typed = await search('on', { filter: { types: ['fact'] } });
  assert.deepStrictEqual(typed.searched.namespaces, ['project/acme']);
  assert.deepStrictEqual(ids(typed), [], 'a legacy fact of the project is hidden');
});

test('a malformed filter is still refused under the default, not replaced by it', async () => {
  await assert.rejects(search('on', { filter: 'note' }), e => e.code === 'E_ARGS');
  await assert.rejects(search('on', { filter: { bogus: 1 } }), e => e.code === 'E_ARGS');
});

test('notes off, or no project: the default stays the run namespace with no type filter', async () => {
  const off = await search('off');
  assert.deepStrictEqual(off.searched.namespaces, [`run/${RUNS.off}`]);
  assert.deepStrictEqual(ids(off), [rows.offRunFact]);
  const bare = await search('bare');
  assert.deepStrictEqual(bare.searched.namespaces, [`run/${RUNS.bare}`]);
  assert.deepStrictEqual(ids(bare), [rows.bareRunFact]);
});

test('the operator is not scoped, even with the notes run attached: its default stays the run namespace', async () => {
  const r = await search('on', {}, 'operator');
  assert.deepStrictEqual(r.searched.namespaces, [`run/${RUNS.on}`]);
  assert.deepStrictEqual(ids(r), [rows.runFact]);
});
