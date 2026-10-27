'use strict';
// memory-search-text.test.cjs — what workers are told about `absence_established` matches what the search does. The flag is true only
// when both modes ran and the scope held nothing to return; the semantic half returns every embedded row (min_score defaults to -1),
// so on a populated scope it is false even when both modes ran cleanly. Three places tell workers this (the tool description, the
// rules text, the index footer); none may call false "not searched" (audit D48).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Engine } = core('engine.cjs');
const { Store } = core('store.cjs');
const { FOOTER } = core('memory-index.cjs');
const T = require('../../src/mcp/tools.cjs');

const orch = callerFor('orchestrator');

async function withStore(fn) {
  const dir = sandbox();
  const store = new Store(path.join(dir, 'memory.db'), { stamp: true });
  const E = new Engine({ dataDir: dir, store, getEmbedder: null, owner: null, establishedBy: 'test' });
  try { await fn(E); } finally { store.close(); cleanup(dir); }
}
const put = (E, text, v) => E.handle('memory.store', { caller: orch, namespace: 'n', text, embedding: v, embedding_model: 'm', dim: 3 });
const search = (E, args) => E.handle('memory.search', { caller: orch, namespace: 'n', query_embedding: [1, 0, 0], embedding_model: 'm', ...args });

test('on a populated scope with a row near the query both modes run, nothing is wrong, and absence_established is false', async () => {
  await withStore(async (E) => {
    await put(E, 'Ferries depart at noon from pier four', [0, 1, 0]);
    await put(E, 'Rotate the API key every quarter', [0.9, 0.1, 0]);
    const r = await search(E, { query: 'quokka sighting' });
    assert.deepStrictEqual(r.modes_run.sort(), ['keyword', 'semantic']);
    assert.deepStrictEqual(r.modes_failed, []);
    assert.strictEqual(r.warning, null, 'a clean search with a relevant row carries no warning');
    assert.strictEqual(r.absence_established, false);
    assert.deepStrictEqual(r.results.map((x) => !!x.low_relevance), [false, true], 'the far row is flagged, not dropped');
  });
});

// ADR 0057 decision 4: every row far from the query is no relevant memory. The rows still come back, flagged, and the warning says so.
test('on a populated scope with no row near the query, absence_established is true and every row is flagged', async () => {
  await withStore(async (E) => {
    await put(E, 'Ferries depart at noon from pier four', [0, 1, 0]);
    await put(E, 'Rotate the API key every quarter', [0, 0, 1]);
    await put(E, 'Unrelated vector row about caching', [0, 0.6, 0.8]);
    const r = await search(E, { query: 'quokka sighting' });
    assert.deepStrictEqual(r.modes_run.sort(), ['keyword', 'semantic']);
    assert.strictEqual(r.results.length, 3, 'the semantic half still returns the nearest rows');
    assert.ok(r.results.every((x) => x.low_relevance === true));
    assert.strictEqual(r.below_floor, 3);
    assert.match(r.warning, /^no result reaches the relevance floor/);
    assert.strictEqual(r.absence_established, true);
  });
});

test('absence_established is true only when both modes ran and the scope held nothing to return', async () => {
  await withStore(async (E) => {
    await put(E, 'Ferries depart at noon from pier four', [0, 1, 0]);
    const r = await search(E, { query: 'quokka sighting', filter: { statuses: ['refuted'] } });
    assert.deepStrictEqual(r.results, []);
    assert.deepStrictEqual(r.modes_run.sort(), ['keyword', 'semantic']);
    assert.strictEqual(r.absence_established, true);
  });
});

test('the tool description says what the flag is, not that false means not searched', () => {
  const d = T.toolsFor('worker').find((t) => t.name === 'memory_search').description;
  assert.doesNotMatch(d, /not searched/);
  assert.match(d, /absence_established \(true only if both ran and none reached the relevance floor/);
});

test('the rules text and the index footer say the same', () => {
  const rules = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'run', 'prompts', 'memory-rules.md'), 'utf8');
  const knowledge = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'run', 'prompts', 'knowledge.md'), 'utf8');
  assert.doesNotMatch(knowledge, /means the search did not fully run/);
  for (const text of [rules, FOOTER, knowledge]) {
    assert.doesNotMatch(text, /not (yet|properly) searched|not searched properly/);
    assert.match(text, /absence_established/);
    assert.match(text, /modes_failed/);
    assert.match(text, /normal/);
  }
  assert.ok(Buffer.byteLength(FOOTER) <= 300, `the footer is ${Buffer.byteLength(FOOTER)} bytes`);
  assert.ok(Buffer.byteLength(rules) <= 1200);
});
