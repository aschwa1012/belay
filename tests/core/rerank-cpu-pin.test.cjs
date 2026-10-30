'use strict';
// rerank-cpu-pin.test.cjs — the CPU reranker pin table (onnx-rerankers.cjs), the arithmetic of a rerank
// (rerank-pure.cjs), and `belay embedder fetch|verify --reranker <id>` against a local node:http server standing in
// for Hugging Face. No model, no network. The CLI runs as a spawned process, so the server answers from this
// process's event loop: every spawn here is asynchronous.

process.env.BELAY_TEST_MODE = '1';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { core } = require('./helpers.cjs');
const { fakeEntry } = require('./fixtures/rerank-stub-pkg.cjs');

const OR = core('onnx-rerankers.cjs');
const P = core('rerank-pure.cjs');
const RP = core('retrieval-profiles.cjs');
const { MODELS } = core('models.cjs');

const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');
const CLI = `${ROOT}/src/cli/belay.cjs`;
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const fwd = p => String(p).split(path.sep).join('/');

// ---- the pin table ----

test('the table pins exactly the two CPU rerankers, each valid, at a commit, with the files transformers.js reads', () => {
  assert.deepStrictEqual(Object.keys(OR.ONNX_RERANKER_TABLE).sort(), ['Alibaba-NLP/gte-reranker-modernbert-base', 'jinaai/jina-reranker-v1-tiny-en']);
  for (const [key, e] of Object.entries(OR.ONNX_RERANKER_TABLE)) {
    assert.strictEqual(key, e.id, 'the key is the id');
    assert.deepStrictEqual(OR.rerankerProblems(e), [], e.id);
    assert.deepStrictEqual([e.runtime, e.kind, e.dtype, e.score_transform, e.license], ['onnx', 'reranker', 'int8', 'sigmoid', 'apache-2.0'], e.id);
    assert.strictEqual(e.max_length, 512);
    assert.deepStrictEqual(e.files.map(f => f.path), ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_int8.onnx'], e.id);
    assert.ok(!MODELS[e.id], 'not in the embedder table');
    assert.strictEqual(OR.rerankerFor(e.id), e);
  }
  const jina = OR.ONNX_RERANKER_TABLE['jinaai/jina-reranker-v1-tiny-en'], gte = OR.ONNX_RERANKER_TABLE['Alibaba-NLP/gte-reranker-modernbert-base'];
  assert.strictEqual(jina.sha, 'aca45de6945b5dc6399abcd2a9c55ded5dc9111f');
  assert.strictEqual(gte.sha, 'f7481e6055501a30fb19d090657df9ec1f79ab2c');
  assert.deepStrictEqual([jina, gte].map(e => e.files[3].bytes), [33424854, 150871837]);
});

test('retrieval-profiles lists the same models, none pending, and each profile names a table entry', () => {
  assert.deepStrictEqual(Object.keys(RP.ONNX_RERANKERS).sort(), Object.keys(OR.ONNX_RERANKER_TABLE).sort());
  for (const e of Object.values(RP.ONNX_RERANKERS)) assert.strictEqual(e.pending_pin, false, e.id);
  assert.ok(OR.ONNX_RERANKER_TABLE[RP.PROFILES['cpu-rerank-light'].reranker] && OR.ONNX_RERANKER_TABLE[RP.PROFILES['cpu-rerank'].reranker]);
});

test('a bad reranker entry is named: sha, path, hash, missing file, wrong transform, wrong kind', () => {
  const e = fakeEntry();
  assert.deepStrictEqual(OR.rerankerProblems(e), []);
  const cases = [
    [{ sha: 'abc' }, /sha .* is not 40 hex/],
    [{ files: e.files.filter(f => f.path !== 'onnx/model_int8.onnx') }, /files lacks onnx\/model_int8\.onnx/],
    [{ files: e.files.filter(f => f.path !== 'tokenizer.json') }, /files lacks tokenizer\.json/],
    [{ files: [...e.files, { path: '../x', bytes: 1, sha256: 'b'.repeat(64) }] }, /not a relative forward-slash path/],
    [{ files: e.files.map(f => ({ ...f, sha256: 'zz' })) }, /sha256 is not 64 hex/],
    [{ score_transform: 'softmax' }, /score_transform/],
    [{ kind: 'embedder' }, /kind/],
    [{ runtime: 'gguf' }, /runtime/],
    [{ max_length: 4 }, /max_length/],
    [{ dtype: 'int8; rm' }, /dtype/],
    [{ id: 'no-slash' }, /is not <org>\/<name>/],
    [{ license: '' }, /license/],
  ];
  for (const [over, re] of cases) assert.match(OR.rerankerProblems({ ...e, ...over }).join('; '), re, JSON.stringify(Object.keys(over)));
  assert.deepStrictEqual(OR.rerankerProblems(null), ['the entry is not an object']);
  assert.throws(() => OR.rerankerFor('nope/none'), (x) => x.code === 'E_ARGS' && /known ids are/.test(x.message));
  assert.throws(() => OR.rerankerFor('__proto__'), { code: 'E_ARGS' });
  assert.throws(() => OR.rerankerFor('fake-org/fake-reranker', { 'fake-org/fake-reranker': { ...e, sha: 'x' } }), (x) => x.code === 'E_ARGS' && /unusable/.test(x.message));
});

// ---- the arithmetic ----

test('planPairs cuts n pairs into ranges of at most chunk; the default is ten; nonsense falls back', () => {
  assert.deepStrictEqual(P.planPairs(23, 10), [[0, 10], [10, 20], [20, 23]]);
  assert.deepStrictEqual(P.planPairs(5, 50), [[0, 5]]);
  assert.deepStrictEqual(P.planPairs(25), [[0, 10], [10, 20], [20, 25]]);
  assert.deepStrictEqual(P.planPairs(3, 0), P.planPairs(3, P.DEFAULT_CHUNK));
  assert.deepStrictEqual(P.planPairs(3, 1), [[0, 1], [1, 2], [2, 3]]);
  assert.deepStrictEqual(P.planPairs(0, 4), []);
});

test('sigmoid is stable at both ends; scoresFromLogits reads one logit or the difference of two, and refuses the rest', () => {
  assert.strictEqual(P.sigmoid(0), 0.5);
  assert.strictEqual(P.sigmoid(-1000), 0);
  assert.strictEqual(P.sigmoid(1000), 1);
  const one = P.scoresFromLogits(Float32Array.from([2, -2, 0]), [3, 1]);
  assert.deepStrictEqual(one.logits, [2, -2, 0]);
  assert.ok(Math.abs(one.scores[0] - 0.8807970779778823) < 1e-6 && one.scores[2] === 0.5);
  const two = P.scoresFromLogits([1, 3, 3, 1], [2, 2]);
  assert.deepStrictEqual(two.logits, [2, -2], 'the second column minus the first');
  assert.ok(two.scores[0] > 0.5 && two.scores[1] < 0.5);
  assert.throws(() => P.scoresFromLogits([1, 2, 3], [1, 3]), /1 or 2 wide/);
  assert.throws(() => P.scoresFromLogits([1, 2], [3, 1]), /hold 2 values/);
  assert.throws(() => P.scoresFromLogits([NaN], [1, 1]), /pair 0 scored NaN/);
  assert.throws(() => P.scoresFromLogits([1], [1]), /shape/);
});

test('countAtLimit counts the rows whose mask reaches max_length, for numbers and for int64 BigInts', () => {
  const rows = [[1, 1, 1, 1], [1, 1, 0, 0], [1, 1, 1, 1], [1, 0, 0, 0]];
  assert.strictEqual(P.countAtLimit(rows.flat(), [4, 4], 4), 2);
  assert.strictEqual(P.countAtLimit(BigInt64Array.from(rows.flat().map(BigInt)), [4, 4], 4), 2);
  assert.strictEqual(P.countAtLimit(rows.flat(), [4, 4], 3), 2, 'a mask longer than the limit still counts');
  assert.strictEqual(P.countAtLimit(rows.flat(), [4, 4], 5), 0);
});

// ---- fetch and verify through the CLI ----

const FILES = {
  'config.json': Buffer.from('{"fake":true}\n'),
  'tokenizer.json': Buffer.from('{"tok":1}\n'),
  'tokenizer_config.json': Buffer.from('{}\n'),
  'onnx/model_int8.onnx': crypto.createHash('sha256').update('seed').digest().subarray(0, 24),
};
const ENTRY = fakeEntry({ sha: 'c'.repeat(40), files: Object.entries(FILES).map(([p, b]) => ({ path: p, bytes: b.length, sha256: sha256(b) })) });

async function withServer(opts, fn) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    const prefix = `/${ENTRY.id}/resolve/${ENTRY.sha}/`;
    if (!req.url.startsWith(prefix) || !FILES[req.url.slice(prefix.length)]) { res.writeHead(404); return res.end(); }
    const p = req.url.slice(prefix.length), b = Buffer.from(FILES[p]);
    if (opts.corrupt === p) b[0] ^= 0xff;
    res.writeHead(200, { 'content-length': b.length }); res.end(b);
  });
  const sockets = new Set();
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cache = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-rerank-cli-')));
  const tableFile = `${cache}-table.json`;
  fs.writeFileSync(tableFile, JSON.stringify({ [ENTRY.id]: ENTRY }));
  try { await fn({ base, cache, tableFile, requests }); }
  finally {
    for (const s of sockets) s.destroy();
    await new Promise(r => server.close(r));
    fs.rmSync(cache, { recursive: true, force: true });
    fs.rmSync(tableFile, { force: true });
  }
}

function belay(args, { base, cache, tableFile }, extra = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, BELAY_HF_BASE: base, BELAY_MODEL_CACHE: cache, BELAY_TEST_MODE: '1', ...extra };
    if (tableFile) env.BELAY_EMBEDDER_TABLE = tableFile; else delete env.BELAY_EMBEDDER_TABLE;
    const child = spawn(process.execPath, [CLI, 'embedder', ...args, '--json'], { cwd: ROOT, windowsHide: true, env });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', reject);
    child.on('close', code => { let json = null; try { json = JSON.parse(out || err); } catch { /* not json */ } resolve({ code, out, err, json }); });
  });
}
const dirOf = cache => `${cache}/${ENTRY.id}@${ENTRY.sha}`;

test('fetch --reranker downloads every pinned file, checks it, writes the manifest last, and a second fetch makes no request', async () => {
  await withServer({}, async ctx => {
    const r = await belay(['fetch', '--reranker', ENTRY.id], ctx);
    assert.strictEqual(r.code, 0, `${r.out} ${r.err}`);
    assert.strictEqual(r.json.already_present, false);
    assert.deepStrictEqual(r.json.files.map(f => f.path), Object.keys(FILES));
    for (const f of r.json.files) assert.deepStrictEqual(fs.readFileSync(`${dirOf(ctx.cache)}/${f.path}`), FILES[f.path]);
    const manifest = JSON.parse(fs.readFileSync(`${dirOf(ctx.cache)}/manifest.json`, 'utf8'));
    assert.strictEqual(manifest.sha, ENTRY.sha);
    assert.strictEqual(manifest.kind, 'reranker');
    assert.strictEqual(ctx.requests.length, 4);
    const again = await belay(['fetch', '--reranker', ENTRY.id], ctx);
    assert.strictEqual(again.code, 0);
    assert.strictEqual(again.json.already_present, true);
    assert.strictEqual(ctx.requests.length, 4, 'no request for a model already present');
    const v = await belay(['verify', '--reranker', ENTRY.id], ctx);
    assert.strictEqual(v.code, 0, v.out);
    assert.strictEqual(v.json.verified, true);
    assert.strictEqual(v.json.files.length, 4);
    // the cache check the client uses agrees
    const K = core('model-cache.cjs');
    assert.strictEqual(K.checkPresent(ENTRY, ctx.cache).present, true);
  });
});

test('a corrupted file fails the fetch naming the file and leaves no model; verify catches a flipped byte after the fact', async () => {
  await withServer({ corrupt: 'tokenizer.json' }, async ctx => {
    const r = await belay(['fetch', '--reranker', ENTRY.id], ctx);
    assert.strictEqual(r.code, 1);
    assert.match(r.json.error, /tokenizer\.json: sha256 .* does not match the table/);
    assert.ok(!fs.existsSync(dirOf(ctx.cache)), 'no model directory');
  });
  await withServer({}, async ctx => {
    assert.strictEqual((await belay(['fetch', '--reranker', ENTRY.id], ctx)).code, 0);
    const p = `${dirOf(ctx.cache)}/onnx/model_int8.onnx`;
    const b = fs.readFileSync(p); b[0] ^= 0xff; fs.writeFileSync(p, b);
    const v = await belay(['verify', '--reranker', ENTRY.id], ctx);
    assert.strictEqual(v.code, 1);
    assert.strictEqual(v.json.verified, false);
    assert.match(v.json.mismatches.join(' '), /onnx\/model_int8\.onnx/);
  });
});

test('--reranker refuses misuse: no id, an unknown id (naming the real ones), a mix with --model or --gpu, a bad table entry', async () => {
  await withServer({}, async ctx => {
    const noTable = { ...ctx, tableFile: null };
    let r = await belay(['fetch', '--reranker'], noTable);
    assert.strictEqual(r.code, 2); assert.match(r.json.error, /--reranker needs an id/);
    r = await belay(['fetch', '--reranker', 'nope/none'], noTable);
    assert.strictEqual(r.code, 2);
    assert.match(r.json.error, /unknown CPU reranker "nope\/none".*jinaai\/jina-reranker-v1-tiny-en, Alibaba-NLP\/gte-reranker-modernbert-base/);
    for (const extra of [['--model', 'x/y'], ['--gpu']]) {
      r = await belay(['fetch', '--reranker', ENTRY.id, ...extra], noTable);
      assert.strictEqual(r.code, 2); assert.match(r.json.error, /cannot be combined/);
    }
    assert.strictEqual(ctx.requests.length, 0, 'no request was made');
    fs.writeFileSync(ctx.tableFile, JSON.stringify({ [ENTRY.id]: { ...ENTRY, files: ENTRY.files.filter(f => f.path !== 'onnx/model_int8.onnx') } }));
    r = await belay(['fetch', '--reranker', ENTRY.id], ctx);
    assert.strictEqual(r.code, 2); assert.match(r.json.error, /unusable.*files lacks onnx\/model_int8\.onnx.*nothing was written/);
    assert.ok(!fs.existsSync(dirOf(ctx.cache)));
  });
});

test('verify --reranker on the real table finds both models absent from an empty cache and makes no request', async () => {
  await withServer({}, async ctx => {
    const noTable = { ...ctx, tableFile: null };
    for (const id of Object.keys(OR.ONNX_RERANKER_TABLE)) {
      const v = await belay(['verify', '--reranker', id], noTable);
      assert.strictEqual(v.code, 1, id);
      assert.strictEqual(v.json.sha, OR.ONNX_RERANKER_TABLE[id].sha);
      assert.strictEqual(v.json.verified, false);
      assert.strictEqual(v.json.files.length, 4);
    }
    assert.strictEqual(ctx.requests.length, 0);
    assert.deepStrictEqual(fs.readdirSync(ctx.cache), [], 'a verify writes nothing');
  });
});
