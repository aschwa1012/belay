'use strict';
// gpu-wire-import-graph.test.cjs — invariant 9 for the GPU wiring: loading the tier, drain, pin and search modules, resolving a tier
// and running a nano search load no GPU module, no probe and no embedder; only an owner asking for a GPU model reaches gpu-shared.cjs.
// Runs in its own process, so require.cache is evidence.

const { test } = require('node:test');
const assert = require('node:assert');
const { setup, PROJECT } = require('./lifecycle-env.cjs');
const { core, callerFor } = require('./helpers.cjs');

const loaded = () => Object.keys(require.cache).filter(k => /[\/]src[\/]core[\/](gpu[^\/]*|gguf-models|embedder[^\/]*|embed-worker)\.cjs$/i.test(k));

test('the wiring modules load no GPU module, and a nano search and a tier lookup load none either', async () => {
  for (const m of ['heavy-tier', 'heavy-embed', 'embed-provider', 'heavy-drain', 'heavy-notes', 'retrieval-pin', 'search-tier', 'rerank-provider']) core(`${m}.cjs`);
  assert.deepStrictEqual(loaded(), [], 'requiring them reaches no GPU module and no embedder');
  const T = await setup();
  try {
    const ST = core('search-tier.cjs');
    assert.strictEqual(ST.tierFor(T.E, callerFor('operator', { run_id: 'lc-plain' })).embedder, core('retrieval-profiles.cjs').NANO);
    const r = await core('memory-search.cjs').search(T.E, T.who.operator('plain'), { namespaces: [`project/${PROJECT}`], query: 'x', mode: 'keyword' });
    assert.ok(Array.isArray(r.results));
    assert.deepStrictEqual(loaded(), [], 'a default search loads none');
  } finally { T.close(); }
});
