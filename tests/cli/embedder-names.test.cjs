'use strict';
require('../helpers/tmp.cjs');
process.env.BELAY_TEST_MODE = '1';
// embedder-names.test.cjs — `belay embedder` takes a model by the name the Memory menu shows, and `delete` takes fetch's spellings
// (`--gpu --model <id>`, `--reranker <id>`); a usage error names what was wrong.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveModelName } = require('../../src/core/model-names.cjs');
const { ONNX_RERANKER_TABLE } = require('../../src/core/onnx-rerankers.cjs');
const { GGUF_MODELS } = require('../../src/core/gguf-models.cjs');
const embedder = require('../../src/cli/cmd-embedder.cjs');
const extra = require('../../src/cli/cmd-embedder-extra.cjs');

const GTE = 'Alibaba-NLP/gte-reranker-modernbert-base';
const E4 = 'Qwen/Qwen3-Embedding-4B-GGUF';
let root, env0;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-embnames-'));
  env0 = process.env.BELAY_MODEL_CACHE;
  process.env.BELAY_MODEL_CACHE = path.join(root, 'models');
  fs.mkdirSync(process.env.BELAY_MODEL_CACHE, { recursive: true });
});
after(() => {
  if (env0 === undefined) delete process.env.BELAY_MODEL_CACHE; else process.env.BELAY_MODEL_CACHE = env0;
  fs.rmSync(root, { recursive: true, force: true });
});
const ctx = (argv) => ({ argv, cwd: root.split(path.sep).join('/'), dataDir: `${root.split(path.sep).join('/')}/.belay`, dataDirGiven: false, json: true });

test('a model resolves by id, label, label word or id without owner, and an ambiguous or unknown name does not', () => {
  assert.deepStrictEqual(resolveModelName(GTE, ONNX_RERANKER_TABLE), { id: GTE });
  assert.deepStrictEqual(resolveModelName('gte-reranker-modernbert-base', ONNX_RERANKER_TABLE), { id: GTE });
  assert.deepStrictEqual(resolveModelName('GTE-Reranker-ModernBERT-Base int8', ONNX_RERANKER_TABLE), { id: GTE });
  assert.strictEqual(resolveModelName('reranker', ONNX_RERANKER_TABLE), null, 'a fragment is not a name');
  const two = { 'a/x': { label: 'x q4' }, 'b/x': { label: 'x q8' } };
  assert.deepStrictEqual(resolveModelName('x', two), { ambiguous: ['a/x', 'b/x'] });
  assert.deepStrictEqual(resolveModelName('a/x', two), { id: 'a/x' });
});

test('verify --reranker takes the short name the menu shows', async () => {
  for (const name of ['gte-reranker-modernbert-base', 'gte-reranker-modernbert-base int8']) {
    const r = await embedder.run(ctx(['verify', '--reranker', name]));
    assert.ok(!(r.json.error && /unknown/.test(r.json.error)), `${name}: ${r.json.error}`);
    assert.match(JSON.stringify(r.json), /gte-reranker-modernbert-base/);
  }
  const bad = await embedder.run(ctx(['verify', '--reranker', 'nope']));
  assert.strictEqual(bad.code, 2);
  assert.match(bad.json.error, /unknown CPU reranker "nope"/);
});

test('delete --gpu --model <id>, --reranker <id> and a short name all reach the model (not in the cache here)', async () => {
  for (const argv of [['delete', '--gpu', '--model', E4], ['delete', '--model', E4], ['delete', E4], ['delete', '--reranker', 'gte-reranker-modernbert-base'], ['delete', 'Qwen3-Embedding-4B']]) {
    const r = await extra.run(ctx(argv));
    assert.strictEqual(r.code, 1, `${argv.join(' ')}: ${r.text}`);
    assert.match(r.json.error, /not in the model cache|store could not be read|config/, argv.join(' '));
    assert.ok(!r.json.error.includes('usage'), argv.join(' '));
  }
});

test('a delete usage error names what was wrong and shows the usage', async () => {
  const cases = [
    [['delete'], /delete needs a model id/],
    [['delete', '--model'], /--model needs an id/],
    [['delete', '--bogus', E4], /unknown option --bogus/],
    [['delete', E4, GTE], /exactly one model, got 2/],
    [['delete', '--reranker', GTE, '--gpu'], /--reranker cannot be combined with --gpu/],
  ];
  for (const [argv, re] of cases) {
    const r = await extra.run(ctx(argv));
    assert.strictEqual(r.code, 2, argv.join(' '));
    assert.match(r.json.error, re, argv.join(' '));
    assert.match(r.text, /usage: belay embedder delete/);
  }
  const unknown = await extra.run(ctx(['delete', '--gpu', 'nope']));
  assert.strictEqual(unknown.code, 2);
  assert.match(unknown.json.error, /unknown GPU model "nope"/);
  assert.ok(GGUF_MODELS[E4]);
});
