'use strict';
// models.test.cjs — the model table and the cache's presence check (ADR 0027 decisions 2, 4, 7). No
// network and no model: everything here is data, stat calls on a temp root, and arithmetic.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { core } = require('./helpers.cjs');

const M = core('models.cjs');
const K = core('model-cache.cjs');
const { scanCeiling } = core('schema.cjs');

const FIELDS = ['id', 'sha', 'dtype', 'pooling', 'query_prompt', 'document_prompt', 'native_dims', 'dims', 'max_tokens', 'license', 'files'];

test('models: every entry has the fields decision 2 names, a 40-hex commit and 64-hex file hashes', () => {
  assert.ok(Object.keys(M.MODELS).length >= 2);
  assert.ok(M.MODELS[M.DEFAULT_MODEL], 'the default is in the table');
  for (const [id, e] of Object.entries(M.MODELS)) {
    for (const f of FIELDS) assert.ok(f in e, `${id} lacks ${f}`);
    assert.strictEqual(e.id, id);
    assert.match(e.sha, /^[0-9a-f]{40}$/);
    assert.ok(['mean', 'cls'].includes(e.pooling) && typeof e.dtype === 'string');
    assert.ok(e.dims <= e.native_dims && e.dims > 0 && e.max_tokens > 0);
    assert.ok(e.files.length >= 3);
    for (const f of e.files) {
      assert.match(f.sha256, /^[0-9a-f]{64}$/, `${id} ${f.path}`);
      assert.ok(Number.isInteger(f.bytes) && f.bytes > 0);
      assert.ok(!f.path.startsWith('/') && !f.path.includes('..'), 'a file path stays inside the model directory');
    }
  }
  const v = M.MODELS[M.DEFAULT_MODEL];
  assert.strictEqual(v.dims, 1024);
  assert.strictEqual(v.native_dims, 2048);
  assert.strictEqual(v.dtype, 'q4');
  assert.strictEqual(M.MODELS['Xenova/all-MiniLM-L6-v2'].dims, 384);
});

test('models: modelFor refuses an unknown id, naming the known ones', () => {
  assert.strictEqual(M.modelFor(M.DEFAULT_MODEL).id, M.DEFAULT_MODEL);
  for (const bad of ['nope/nothing', '', 'constructor', '__proto__']) {
    assert.throws(() => M.modelFor(bad), e => {
      assert.strictEqual(e.code, 'E_ARGS');
      assert.ok(e.message.includes(M.DEFAULT_MODEL) && e.message.includes('Xenova/all-MiniLM-L6-v2'));
      return true;
    });
  }
});

test('models: entryProblems refuses an unsafe sha, path, size or hash (review 1, S4)', () => {
  const ok = M.MODELS[M.DEFAULT_MODEL];
  assert.deepStrictEqual(M.entryProblems(ok), []);
  const withFile = (o) => ({ ...ok, files: [{ ...ok.files[0], ...o }] });
  for (const bad of [
    { ...ok, sha: 'g'.repeat(40) }, { ...ok, sha: '/../../x' }, { ...ok, sha: 'a'.repeat(39) }, { ...ok, id: '../x/y' }, { ...ok, id: 'nope' }, { ...ok, files: [] },
    withFile({ path: '../../escaped.txt' }), withFile({ path: 'a/../b' }), withFile({ path: '/abs' }), withFile({ path: 'C:/x' }), withFile({ path: 'a\\b' }), withFile({ path: '' }),
    withFile({ bytes: 0 }), withFile({ bytes: 1.5 }), withFile({ sha256: 'abc' }), null,
  ]) assert.ok(M.entryProblems(bad).length > 0, JSON.stringify(bad && bad.files && bad.files[0]));
  assert.throws(() => M.validateEntry(withFile({ path: '../x' })), e => e.code === 'E_ARGS' && e.detail.problems.length === 1);
});

test('model-cache: checkPresent on a temp root reports missing and wrong-size files, by stat only', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-models-test-')).split('\\').join('/');
  try {
    const e = M.MODELS['Xenova/all-MiniLM-L6-v2'];
    const dir = K.modelDir(e, root);
    assert.strictEqual(dir, `${root}/${e.id}@${e.sha}`);
    const empty = K.checkPresent(e, root);
    assert.strictEqual(empty.present, false);
    assert.strictEqual(empty.manifest_sha, null);
    assert.deepStrictEqual(empty.missing, [...e.files.map(f => f.path), 'manifest.json']);

    // Write every file at a wrong size except one at the right size, and a manifest naming another commit.
    for (const [i, f] of e.files.entries()) {
      fs.mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true });
      fs.writeFileSync(path.join(dir, f.path), i === 0 ? Buffer.alloc(f.bytes) : Buffer.alloc(3));
    }
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ sha: 'f'.repeat(40) }));
    const wrong = K.checkPresent(e, root);
    assert.strictEqual(wrong.present, false);
    assert.deepStrictEqual(wrong.missing, []);
    assert.deepStrictEqual(wrong.wrong_size, [...e.files.slice(1).map(f => f.path), 'manifest.json']);
    assert.strictEqual(wrong.manifest_sha, 'f'.repeat(40));

    // Right sizes and the right manifest: present, without any file's content being read for a hash.
    for (const f of e.files) fs.writeFileSync(path.join(dir, f.path), Buffer.alloc(f.bytes));
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ sha: e.sha }));
    const ok = K.checkPresent(e, root);
    assert.deepStrictEqual({ present: ok.present, missing: ok.missing, wrong_size: ok.wrong_size, manifest_sha: ok.manifest_sha }, { present: true, missing: [], wrong_size: [], manifest_sha: e.sha });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('model-cache: BELAY_MODEL_CACHE decides the root before any platform default', () => {
  assert.strictEqual(K.cacheRoot({ BELAY_MODEL_CACHE: 'C:/somewhere/else' }), 'C:/somewhere/else');
  assert.ok(K.cacheRoot({ LOCALAPPDATA: 'C:/L', XDG_CACHE_HOME: '/x' }).endsWith('/belay/models'));
});

test('schema: the exact-scan ceiling scales with dims at equal cost', () => {
  assert.strictEqual(scanCeiling(384), 50000);
  assert.strictEqual(scanCeiling(1024), 18750);
  assert.strictEqual(scanCeiling(2048), 9375);
});
