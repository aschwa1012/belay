'use strict';
// memory-summaries.test.cjs — ADR 0047 decision 1: with the notes lever on, run summaries live in summary/<project>,
// out of the index and the default search, and are found on demand by memory.summaries; the briefing reads the same lookup.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Store } = core('store.cjs');
const { Engine } = core('engine.cjs');

let dir, store, E;
const ON = 'r-sum', OFF = 'r-sum-off';
const orch = callerFor('orchestrator', { run_id: ON });
const orchOff = callerFor('orchestrator', { run_id: OFF });
const worker = callerFor('worker', { run_id: ON, worker_id: 'w1' });
const call = (method, caller, args = {}) => E.handle(method, { caller, ...args });
let t = 1000;
const TOKEN = ['sk', 'ant', 'api03', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('-'); // built, so the file holds no token-shaped text

// A summary as the run manager writes it (type summary, source summariser, body v2 with the files).
function summary(task, { run = ON, worker_id = 'w1', modified = [], looked = [], title } = {}) {
  return store.store({
    namespace: 'summary/acme', type: 'summary', source: 'summariser', worker_id, written_by: 'harness', run_id: run, task_id: task, created_at: ++t,
    title: title || `summary: ${task}`, text: `[generated summary] about: task ${task} unique ${t}`,
    body: { v: 2, looked_at: looked, done: { files_modified: modified }, generator: { kind: 'mechanical' } },
  });
}

before(async () => {
  dir = sandbox();
  store = new Store(`${dir}/memory.db`, { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: null, owner: null, establishedBy: 'test' });
  await call('run.attach', orch, { adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', notes: true }) });
  await call('run.attach', orchOff, { adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme' }) });
});
after(() => { store.close(); cleanup(dir); });

test('the lookup finds summaries by task, run and files, newest first, and honours the limit', async () => {
  const a = summary('t1', { modified: ['src/a.js', 'src/deep/b.js'], looked: ['notes/x.md'] });
  const b = summary('t2', { modified: ['src/c.js'] });
  const c = summary('t1', { run: 'older-run', modified: ['lib/z.js'] });
  const all = await call('memory.summaries', orch);
  assert.deepStrictEqual(all.summaries.map(s => s.id), [c.id, b.id, a.id], 'newest first');
  assert.strictEqual(all.namespace, 'summary/acme');
  assert.deepStrictEqual((await call('memory.summaries', orch, { task_id: 't1' })).summaries.map(s => s.id), [c.id, a.id]);
  assert.deepStrictEqual((await call('memory.summaries', orch, { run_id: ON })).summaries.map(s => s.id), [b.id, a.id]);
  assert.deepStrictEqual((await call('memory.summaries', orch, { limit: 1 })).summaries.map(s => s.id), [c.id]);
  // files: worktree-relative, a file or a folder, matched on what the summary modified or looked at
  assert.deepStrictEqual((await call('memory.summaries', orch, { files: ['src'] })).summaries.map(s => s.id), [b.id, a.id]);
  assert.deepStrictEqual((await call('memory.summaries', orch, { files: ['./src/deep/'] })).summaries.map(s => s.id), [a.id]);
  assert.deepStrictEqual((await call('memory.summaries', orch, { files: ['notes\\x.md'] })).summaries.map(s => s.id), [a.id], 'a looked-at file counts, and a backslash path is read as a slash path');
  assert.deepStrictEqual((await call('memory.summaries', orch, { files: ['sr'] })).summaries, [], 'a prefix of a name is not a folder');
  assert.deepStrictEqual((await call('memory.summaries', orch, { files: ['src'], task_id: 't2' })).summaries.map(s => s.id), [b.id]);
  const first = all.summaries[2];
  assert.deepStrictEqual([first.title, first.files_modified, first.looked_at, first.task_id, first.run_id], ['summary: t1', ['src/a.js', 'src/deep/b.js'], ['notes/x.md'], 't1', ON]);
});

test('a worker of the run can ask; arguments are checked', async () => {
  assert.ok((await call('memory.summaries', worker)).summaries.length > 0);
  for (const bad of [{ limit: 0 }, { limit: 51 }, { files: [] }, { files: [1] }, { task_id: '' }]) {
    await assert.rejects(call('memory.summaries', orch, bad), e => e.code === 'E_ARGS', JSON.stringify(bad));
  }
});

test('lever off: memory.summaries is refused by name', async () => {
  await assert.rejects(call('memory.summaries', orchOff), e => e.code === 'E_LEVER_OFF');
});

test('a summary in summary/<project> is in neither the default search nor the index', async () => {
  const s = summary('t9', { title: 'summary: t9 zebra-unique-term', modified: ['src/q.js'] });
  const project = await call('memory.search', orch, { query: 'zebra-unique-term', namespace: 'project', mode: 'keyword', view: 'index' });
  assert.ok(!project.results.some(r => r.id === s.id));
  const dflt = await call('memory.search', orch, { query: 'zebra-unique-term', mode: 'keyword', view: 'index' });
  assert.ok(!dflt.results.some(r => r.id === s.id));
  const idx = await call('memory.index', orch, { max_bytes: 4000, query: 'zebra-unique-term' });
  assert.ok(!idx.row_ids.includes(s.id));
  await assert.rejects(call('memory.search', worker, { query: 'zebra-unique-term', namespace: 'summary/acme', mode: 'keyword' }), e => e.code === 'E_ROLE', 'a worker\'s search reach does not include it');
});

test('the briefing reads the same lookup with the lever on, and has no such section with it off', async () => {
  const t = await call('task.create', orch, { spec: 'brief me' });
  const s = summary(t.id, { modified: ['src/k.js'], title: 'summary: briefing target' });
  const doc = await call('continuity.resumeDoc', orch, { task_id: t.id });
  assert.ok(doc.sections.some(n => n.startsWith('run summaries of')), doc.sections.join(' | '));
  assert.ok(doc.text.includes(s.id) && doc.text.includes('summary: briefing target'));
  const t2 = await call('task.create', orchOff, { spec: 'no notes' });
  const off = await call('continuity.resumeDoc', orchOff, { task_id: t2.id });
  assert.ok(!off.sections.some(n => n.startsWith('run summaries of')));
});

test('a summary is redacted like a project row: the summary namespace is always scrubbed', async () => {
  const r = await call('memory.store', orchOff, { namespace: 'summary/acme', type: 'summary', text: `token ${TOKEN} in a summary`, embed: false });
  assert.ok(!rowText(r.id).includes(TOKEN));
});
function rowText(id) { return store.p('SELECT text FROM memory_entries WHERE id = ?').get(id).text; }
