'use strict';
// memory-corpus-mutation.test.cjs — claims of memory-corpus.cjs that a mutation run showed no other test pins
// down: the default and ceiling budgets to the byte, the priority of a summary over a fact, the named field of
// a refusal, the fetch cap counted in `dropped`, and the fact/unverified fallbacks of a row's tag.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Engine } = core('engine.cjs');
const { Store } = core('store.cjs');
const { corpus, DEFAULT_MAX, CEILING_MAX } = core('memory-corpus.cjs');

let dir, store, E, orch;
const put = (ns, text, extra = {}) => E.handle('memory.store', { namespace: ns, text, embedding: [1, 0, 0], embedding_model: 'm', dim: 3, caller: orch, ...extra });
const setCols = (id, cols) => {
  const keys = Object.keys(cols);
  store.db.prepare(`UPDATE memory_entries SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map(k => cols[k]), id);
};
const refused = async (args, field) => {
  await assert.rejects(corpus(E, orch, args), e => { assert.strictEqual(e.code, 'E_ARGS'); assert.strictEqual(e.detail && e.detail.field, field); return true; });
};

before(() => {
  dir = sandbox();
  store = new Store(path.join(dir, 'memory.db'), { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: async () => { throw new Error('the corpus must not embed'); }, owner: null, establishedBy: 'test' });
  orch = callerFor('orchestrator');
});
after(() => { store.close(); cleanup(dir); });

test('the default budget is 65536 bytes exactly and the ceiling is 262144', async () => {
  assert.strictEqual(DEFAULT_MAX, 65536);
  assert.strictEqual(CEILING_MAX, 262144);
  const row = await put('project/edge', 'x'.repeat(70000), { type: 'summary', created_at: 1 });
  const probe = await corpus(E, orch, { project: 'edge', max_bytes: CEILING_MAX });
  assert.deepStrictEqual(probe.row_ids, [row.id]);
  // shrink the text so the whole block is exactly the default budget, then one byte more
  const exact = 'x'.repeat(70000 - (probe.bytes - DEFAULT_MAX));
  setCols(row.id, { text: exact });
  const fit = await corpus(E, orch, { project: 'edge' });
  assert.strictEqual(fit.bytes, DEFAULT_MAX);
  assert.deepStrictEqual(fit.row_ids, [row.id]);
  setCols(row.id, { text: `${exact}x` });
  const over = await corpus(E, orch, { project: 'edge' });
  assert.deepStrictEqual(over.row_ids, []);
  assert.strictEqual(over.dropped, 1);
  assert.ok(over.bytes <= DEFAULT_MAX);
});

test('max_bytes accepts 1 and the ceiling, and refuses 0 and one past the ceiling, naming the field', async () => {
  const tiny = await corpus(E, orch, { project: 'edge', max_bytes: 1 });
  assert.strictEqual(tiny.over_budget, true);
  assert.ok(tiny.bytes <= 1);
  await corpus(E, orch, { project: 'edge', max_bytes: CEILING_MAX });
  await refused({ project: 'edge', max_bytes: 0 }, 'max_bytes');
  await refused({ project: 'edge', max_bytes: CEILING_MAX + 1 }, 'max_bytes');
  await refused({ project: 'edge', max_bytes: 1.5 }, 'max_bytes');
});

test('a refused project names the project field', async () => {
  await refused({ project: 'Bad Name' }, 'project');
  await refused({ project: 7 }, 'project');
  await refused({ project: '' }, 'project');
});

test('a summary outranks a verified fact when the budget forces a drop, even when the summary is older', async () => {
  const ns = 'project/prio';
  const s = await put(ns, 'summary-aaaaaaaaaa', { type: 'summary', created_at: 1 });
  const f = await put(ns, 'fact-bbbbbbbbbbbbb', { type: 'fact', created_at: 2 });
  setCols(f.id, { status: 'verified' });
  const full = await corpus(E, orch, { project: 'prio' });
  assert.strictEqual(full.row_ids.length, 2);
  const lines = full.text.split('\n');
  // the frame is a title line, a BEGIN line, the rows (a header line and an indented text line each) and END;
  // keep the summary's two lines and drop the fact's
  const one = Buffer.byteLength([...lines.slice(0, 4), lines[lines.length - 1]].join('\n'));
  const r = await corpus(E, orch, { project: 'prio', max_bytes: one });
  assert.deepStrictEqual(r.row_ids, [s.id]);
  assert.strictEqual(r.dropped, 1);
});

test('rows past the fetch cap are counted in dropped, oldest first', async () => {
  const n = 5003;
  store.db.prepare(`WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < ?)
    INSERT INTO memory_entries (id, namespace, worker_id, type, text, text_hash, created_at, updated_at, status)
    SELECT 'b' || n, 'project/bulk', 'w', 'fact', 't' || n, 'h' || n, n, n, 'verified' FROM c`).run(n);
  const r = await corpus(E, orch, { project: 'bulk', max_bytes: CEILING_MAX });
  assert.strictEqual(r.row_ids.length, 5000);
  assert.strictEqual(r.dropped, 3);
  assert.ok(!r.row_ids.includes('b1') && !r.row_ids.includes('b3') && r.row_ids.includes('b4') && r.row_ids.includes('b5003'));
  assert.strictEqual(r.over_budget, false);
  // with a budget that also forces a fit drop, both counts add
  const small = await corpus(E, orch, { project: 'bulk', max_bytes: 2000 });
  assert.strictEqual(small.row_ids.length + small.dropped, n);
});

test('a row with an empty type reads as a fact', async () => {
  const r = await put('project/blank', 'blank type row', { created_at: 1 });
  setCols(r.id, { type: '', status: 'verified' });
  const c = await corpus(E, orch, { project: 'blank' });
  assert.ok(c.text.includes(`[${r.id}] [fact/verified] blank type row`), c.text);
});

test('a decision with no status reads as unverified and a refuted decision is left out', async () => {
  const d = await put('project/dec', 'we chose a pipe', { type: 'decision', created_at: 1 });
  setCols(d.id, { status: null });
  const c = await corpus(E, orch, { project: 'dec' });
  assert.ok(c.text.includes(`[${d.id}] [decision/unverified]`), c.text);
  setCols(d.id, { status: 'refuted' });
  assert.deepStrictEqual((await corpus(E, orch, { project: 'dec' })).row_ids, []);
});
