'use strict';
// memory-reach-summary.test.cjs — the orchestrator's run outcome goes to summary/<project> through the alias `summary`, which is the orchestrator's alone;
// its writes to another project or to summary/ named directly are E_ROLE, and the run manager (harness channel) is unrestricted (ADR 0047 amendment of
// 2026-10-22). Reads stay unlimited, so the orchestrator's own search reaches the summaries it wrote.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup } = require('./report-env.cjs');

let X;
before(async () => { X = await setup('r-rs'); });
after(() => X.cleanup());

const store = (caller, args) => X.call('memory.store', caller, args);

test('RS1: the alias writes a summary row with its title, found by memory.summaries for the run', async () => {
  const out = await store(X.orch, { namespace: 'summary', title: 'step one finished', text: 'The loader step finished and its tests passed.' });
  const row = X.rowOf(out.id);
  assert.deepStrictEqual([row.namespace, row.type, row.title, row.run_id], ['summary/acme', 'summary', 'step one finished', 'r-rs']);
  const found = await X.call('memory.summaries', X.orch, { run_id: 'r-rs' });
  assert.deepStrictEqual(found.summaries.map((s) => s.id), [out.id]);
});

test('RS2: a run outcome needs a title, and takes no supersedes, ttl or body; a type given is forced to summary', async () => {
  await assert.rejects(store(X.orch, { namespace: 'summary', text: 'no title' }), (e) => e.code === 'E_ARGS' && e.detail.field === 'title');
  for (const [k, v] of [['supersedes', 'abc'], ['ttl_seconds', 60], ['body', { a: 1 }]]) {
    await assert.rejects(store(X.orch, { namespace: 'summary', title: 't', text: 'x', [k]: v }), (e) => e.code === 'E_ARGS' && e.detail.field === k, k);
  }
  const out = await store(X.orch, { namespace: 'summary', title: 'typed', text: 'typed outcome', type: 'fact' });
  assert.strictEqual(X.rowOf(out.id).type, 'summary');
});

test('RS3: the orchestrator\'s own search reaches summary/<project>, by the alias and by name (reads are unlimited)', async () => {
  const out = await store(X.orch, { namespace: 'summary', title: 'search me', text: 'a distinctive zebrafish outcome' });
  for (const args of [{ namespaces: ['summary/acme'] }, { namespaces: ['summary'] }, { namespace: 'summary' }]) {
    const r = await X.call('memory.search', X.orch, { query: 'zebrafish', mode: 'keyword', ...args });
    assert.ok(r.results.some((x) => x.id === out.id), JSON.stringify(args));
  }
});

test('RS4: a worker\'s summary is outside its reach, and so is anything it names directly', async () => {
  await X.startTask('w-rs4', 'a stream\n');
  const w = X.worker('w-rs4');
  for (const ns of ['summary', 'summary/acme']) await assert.rejects(store(w, { namespace: ns, title: 't', text: 'x' }), (e) => e.code === 'E_ROLE', ns);
});

test('RS5: the orchestrator may not write another project, or summary/ named directly', async () => {
  const before = X.store.p('SELECT COUNT(*) AS n FROM memory_entries').get().n;
  for (const ns of ['project/other', 'summary/acme', 'summary/other']) {
    await assert.rejects(store(X.orch, { namespace: ns, title: 't', text: 'x', kind: 'lesson' }), (e) => e.code === 'E_ROLE', ns);
  }
  assert.strictEqual(X.store.p('SELECT COUNT(*) AS n FROM memory_entries').get().n, before, 'nothing written');
});

test('RS6: the harness channel is unrestricted: the run manager writes summaries and project copies', async () => {
  const s = await store(X.harness, { namespace: 'summary/acme', type: 'summary', title: 'harness summary', text: 'written by the run manager' });
  assert.strictEqual(X.rowOf(s.id).namespace, 'summary/acme');
  const p = await store(X.harness, { namespace: 'project/other', type: 'fact', text: 'a project copy' });
  assert.strictEqual(X.rowOf(p.id).namespace, 'project/other');
});
