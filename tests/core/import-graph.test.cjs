'use strict';
// import-graph.test.cjs — a budget enforced by what the read path may import (ADR 0005 §9, api.md §4).
// The embedding library costs 13.5 s on first import and 664 ms warm, and status.get has 100 ms, so no
// path reachable from openCore or status.get may load src/core/embedder.cjs. This file runs in its own
// process (one process per test file), so require.cache is evidence rather than a coincidence.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor, listDataDir } = require('./helpers.cjs');

const loaded = () => Object.keys(require.cache).filter(k => k.toLowerCase().includes(`${path.sep}src${path.sep}core${path.sep}embedder.cjs`.toLowerCase()));

test('openCore and status.get never load the embedder module', async () => {
  assert.deepStrictEqual(loaded(), [], 'nothing has loaded the embedder before this test starts');

  const { openCore } = core('index.cjs');
  assert.deepStrictEqual(loaded(), [], 'requiring the Core API does not reach the embedder');

  const dir = sandbox();
  try {
    const c = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
    assert.deepStrictEqual(loaded(), [], 'openCore does not reach the embedder');

    const st = await c.status.get({});
    assert.strictEqual(st.verdict, 'stopped', 'an empty data dir with no owner is a valid, dead answer');
    assert.deepStrictEqual(loaded(), [], 'status.get with no owner alive does not reach the embedder');
    assert.deepStrictEqual(listDataDir(dir), [], 'status.get creates no file in the data dir');

    await c.close();
  } finally { cleanup(dir); }
});

// ---- ADR 0027: the table and the cache are read-path safe, the embedder and the library are not ----

const fs = require('node:fs');
const requiresOf = file => [...fs.readFileSync(file, 'utf8').matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
const SRC = path.join(__dirname, '..', '..', 'src');

test('model-cache.cjs requires only node built-ins, and models.cjs only the error module', () => {
  const cache = requiresOf(path.join(SRC, 'core', 'model-cache.cjs'));
  assert.ok(cache.length > 0);
  for (const r of cache) assert.ok(r.startsWith('node:') || r === './models.cjs', `model-cache.cjs requires ${r}`);
  assert.deepStrictEqual(requiresOf(path.join(SRC, 'core', 'models.cjs')), ['./errors.cjs']);
  assert.deepStrictEqual(requiresOf(path.join(SRC, 'core', 'embed-identity.cjs')).filter(r => !r.startsWith('node:')).sort(), ['./errors.cjs', './models.cjs']);
});

test('the memory read modules require nothing but the error module', () => {
  const allowed = { 'fts-query.cjs': [], 'fusion.cjs': ['./errors.cjs'], 'memory-rows.cjs': ['./errors.cjs'], 'memory-schema.cjs': [], 'fit-budget.cjs': [], 'memory-index.cjs': ['./errors.cjs', './fit-budget.cjs', './memory-index-notes.cjs', './memory-reach.cjs', './memory-relevance.cjs', './memory-rows.cjs', './rows.cjs'], 'memory-relevance.cjs': ['./errors.cjs', './fts-query.cjs', './fusion.cjs', './memory-schema.cjs', './stopwords-en.cjs'], 'stopwords-en.cjs': [], 'memory-corpus.cjs': ['./errors.cjs', './fit-budget.cjs', './memory-reach.cjs', './memory-rows.cjs'], 'memory-reach.cjs': ['./errors.cjs'], 'memory-index-notes.cjs': ['./fit-budget.cjs', './memory-index-rank.cjs', './memory-note-gate.cjs', './memory-notes.cjs', './memory-reach.cjs', './memory-relevance.cjs', './memory-rows.cjs', './redact.cjs', './rows.cjs'], 'memory-notes.cjs': ['./errors.cjs', './memory-rows.cjs'], 'memory-index-rank.cjs': ['./fusion.cjs', './memory-note-gate.cjs', './memory-relevance.cjs', './memory-schema.cjs', './store.cjs'], 'memory-note-gate.cjs': [] };
  for (const [name, want] of Object.entries(allowed)) assert.deepStrictEqual(requiresOf(path.join(SRC, 'core', name)).filter(r => !r.startsWith('node:')).sort(), [...want].sort(), name);
});

test('no file under src requires embedder.cjs except owner.cjs, which does so inside a function', () => {
  const offenders = [];
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.cjs') && p !== path.join(SRC, 'core', 'embedder.cjs') && requiresOf(p).some(r => /(^|\/)embedder\.cjs$/.test(r))) offenders.push(path.relative(SRC, p).split(path.sep).join('/'));
    }
  };
  walk(SRC);
  assert.deepStrictEqual(offenders, ['core/owner.cjs']);
  // The thread's modules are reachable only through the embedder: embedder-core.cjs from embedder.cjs and
  // embed-worker.cjs, and embed-worker.cjs by path from embedder.cjs alone.
  const core = [];
  const walk2 = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk2(p); else if (e.name.endsWith('.cjs') && requiresOf(p).some(r => /embedder-core\.cjs$/.test(r))) core.push(path.relative(SRC, p).split(path.sep).join('/')); } };
  walk2(SRC);
  assert.deepStrictEqual(core.sort(), ['core/embed-worker.cjs', 'core/embedder.cjs']);
  const owner = fs.readFileSync(path.join(SRC, 'core', 'owner.cjs'), 'utf8');
  assert.ok(!/^const .*require\(['"]\.\/embedder\.cjs['"]\)/m.test(owner), 'owner.cjs must not require the embedder at top level');
});

test('belay doctor, with its embedder line, loads neither embedder.cjs nor the embedding library', async () => {
  assert.strictEqual(loaded().length, 0, 'nothing has loaded the embedder before doctor runs');
  const doctor = require(path.join(SRC, 'cli', 'cmd-doctor.cjs'));
  const dir = sandbox();
  try {
    const r = await doctor.run({ argv: [], cwd: dir, dataDir: `${dir}/.belay`, json: true, fix: false, command: 'doctor' });
    assert.strictEqual(r.code, 0);
    const line = r.json.checks.find(c => c.check === 'embedder');
    assert.ok(line, 'doctor has an embedder line');
    assert.ok(['ok', 'missing'].includes(line.verdict), 'absence is a finding, never an error');
    assert.ok(line.evidence.length > 20);
    assert.deepStrictEqual(listDataDir(`${dir}/.belay`), [], 'doctor creates nothing');
  } finally { cleanup(dir); }
  assert.strictEqual(loaded().length, 0, 'doctor did not reach the embedder');
  const lib = Object.keys(require.cache).filter(k => /@huggingface|onnxruntime/i.test(k));
  assert.deepStrictEqual(lib, [], 'the embedding library is not in require.cache');
});

test('the embedder is reachable, so the assertion above is about laziness and not about a typo', () => {
  const { Embedder } = core('embedder.cjs');
  assert.strictEqual(typeof Embedder, 'function');
  assert.strictEqual(loaded().length, 1, 'an explicit require does put it in the cache');
});

test('memory-search.cjs, the read path of the memory methods, requires no embedder', () => {
  const want = ['./errors.cjs', './fts-query.cjs', './fusion.cjs', './memory-note-gate.cjs', './memory-relevance.cjs', './memory-rows.cjs', './memory-schema.cjs', './methods-memory.cjs', './schema.cjs', './store.cjs'];
  assert.deepStrictEqual(requiresOf(path.join(SRC, 'core', 'memory-search.cjs')).filter(r => !r.startsWith('node:')).sort(), want);
  const engine = requiresOf(path.join(SRC, 'core', 'engine.cjs'));
  assert.ok(engine.includes('./memory-search.cjs'));
  assert.ok(!engine.some(r => /embed/.test(r)), 'engine.cjs requires no embedder module');
});
