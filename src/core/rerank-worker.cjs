'use strict';
// rerank-worker.cjs — the CPU reranker child PROCESS (ADR 0050 decision 5), the sibling of embed-worker.cjs and
// gpu-worker.cjs. rerank-cpu.cjs forks this file with IPC and knows it by its exact handle. argv[2] is the JSON of
// { pkg, heartbeatMs? }: the directory of belay's pinned transformers.js. The child imports it from there and runs one
// ONNX sequence-classification reranker on the CPU, so a model load or a rerank never blocks the owner's event loop
// (invariant 7) and a native crash takes down only this child. Only rerank-cpu.cjs requires or forks this file.
//
// Messages in: { id, op, ... } with op one of
//   load   { model, dir, dtype, maxLength }   -> { model, dtype, max_length, library, load_ms }
//          `dir` is the cache directory of the pinned model (config.json, tokenizer files, onnx/model_<dtype>.onnx)
//   rank   { model, query, docs: [string], chunk?, maxLength? }
//                                             -> { scores, logits, chunks: [{ n, seq_len, ms }], truncated, max_length, ms }
//          scores are the model's scores in input order (a sigmoid of the logit); `truncated` counts pairs whose token
//          length reached max_length (rerank-pure.cjs countAtLimit); `maxLength` may only lower the model's own
//   ping                                      -> { pong, pid, models }
//   close
// Out: { id, ok: true, result }, { id, ok: false, error: { code, message, detail } } and { id, progress } lines, which
// the owner counts as proof of life for that request and for those queued behind it: one per rank chunk, and a
// heartbeat every 5 s while a load runs. Work is served one op at a time.
//
// The child ends when the owner dies: a 'disconnect' handler ends it at once, even with a loaded session keeping the
// event loop alive. `close` exits after a short bounded release. Test-only ops (BELAY_TEST_MODE=1): env, sleep, hang,
// wedge (blocks the event loop), fail, crash.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const P = require('./rerank-pure.cjs');

const opts = JSON.parse(process.argv[2] || '{}');
const HEARTBEAT_MS = opts.heartbeatMs || 5000;
const MODEL_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json'];
let tf = null;
const models = new Map();
let chain = Promise.resolve();
const serial = (fn) => { const r = chain.then(fn); chain = r.catch(() => {}); return r; };

const reply = (id, result) => process.send({ id, ok: true, result });
function fail(id, e) {
  process.send({ id, ok: false, error: { code: e && e.code, message: (e && e.message) || String(e), detail: e && e.detail } });
}
const bad = (message, code = 'E_ARGS') => Object.assign(new Error(message), { code });

async function library() {
  if (tf) return tf;
  if (!opts.pkg) throw bad('the rerank child was started without the transformers package directory', 'E_MODEL_ABSENT');
  try { tf = await import(pathToFileURL(path.join(opts.pkg, 'src', 'transformers.js')).href); }
  catch (x) { throw bad(`the transformers package is not loadable at ${opts.pkg}: ${x.message}`, 'E_MODEL_ABSENT'); }
  tf.env.allowRemoteModels = false; tf.env.allowLocalModels = true; tf.env.useFSCache = false;
  return tf;
}

async function load(m) {
  if (models.has(m.model)) throw bad(`${m.model} is already loaded`);
  if (typeof m.dir !== 'string' || !m.dir) throw bad('load needs the model directory');
  if (typeof m.dtype !== 'string' || !/^[a-z0-9]+$/.test(m.dtype)) throw bad(`load needs a dtype word, not ${JSON.stringify(m.dtype)}`);
  if (!Number.isInteger(m.maxLength) || m.maxLength < 16) throw bad(`load needs an integer maxLength of at least 16, not ${JSON.stringify(m.maxLength)}`);
  for (const f of [...MODEL_FILES, `onnx/model_${m.dtype}.onnx`]) {
    if (!fs.existsSync(path.join(m.dir, f))) throw bad(`the model file ${f} is missing from ${m.dir}`, 'E_MODEL_ABSENT');
  }
  const t0 = Date.now();
  const lib = await library();
  let tokenizer, model;
  try {
    tokenizer = await lib.AutoTokenizer.from_pretrained(m.dir);
    model = await lib.AutoModelForSequenceClassification.from_pretrained(m.dir, { dtype: m.dtype, device: 'cpu' });
  } catch (x) { throw bad(`the model ${m.model} did not load from ${m.dir}: ${x.message}`, 'E_MODEL_ABSENT'); }
  models.set(m.model, { tokenizer, model, dtype: m.dtype, maxLength: m.maxLength });
  return { model: m.model, dtype: m.dtype, max_length: m.maxLength, library: lib.env && lib.env.version, load_ms: Date.now() - t0 };
}

async function rank(m, id) {
  const e = models.get(m.model);
  if (!e) throw bad(`the rerank child has not loaded ${JSON.stringify(m.model)}`, 'E_MODEL_ABSENT');
  if (typeof m.query !== 'string') throw bad('rank needs a query string');
  if (!Array.isArray(m.docs) || !m.docs.length || m.docs.some(d => typeof d !== 'string')) throw bad('rank needs a non-empty list of document strings');
  const maxLength = Math.min(e.maxLength, Number.isInteger(m.maxLength) && m.maxLength >= 16 ? m.maxLength : e.maxLength);
  const logits = [], scores = [], chunks = [];
  let truncated = 0;
  const t0 = Date.now();
  for (const [from, to] of P.planPairs(m.docs.length, m.chunk)) {
    const c0 = Date.now();
    const part = m.docs.slice(from, to);
    const enc = e.tokenizer(new Array(part.length).fill(m.query), { text_pair: part, padding: true, truncation: true, max_length: maxLength });
    const out = await e.model(enc);
    const s = P.scoresFromLogits(out.logits.data, out.logits.dims);
    const dims = enc.attention_mask.dims;
    truncated += P.countAtLimit(enc.attention_mask.data, dims, maxLength);
    logits.push(...s.logits); scores.push(...s.scores);
    chunks.push({ n: part.length, seq_len: dims[1], ms: Date.now() - c0 });
    process.send({ id, progress: { done: scores.length, total: m.docs.length } });
  }
  return { scores, logits, chunks, truncated, max_length: maxLength, ms: Date.now() - t0 };
}

async function close() {
  const release = (async () => { for (const e of models.values()) { if (e.model && typeof e.model.dispose === 'function') await e.model.dispose(); } })().catch(() => {});
  await Promise.race([release, new Promise(r => setTimeout(r, 1500))]);
  process.exit(0);
}

process.on('disconnect', () => process.exit(0));
process.on('message', async (m) => {
  const test = process.env.BELAY_TEST_MODE === '1';
  try {
    if (m.op === 'close') return await close();
    if (m.op === 'ping') return reply(m.id, { pong: true, pid: process.pid, models: [...models.keys()] });
    if (test && m.op === 'env') return reply(m.id, { env: { ...process.env }, execArgv: process.execArgv });
    if (test && m.op === 'sleep') return serial(() => new Promise(r => setTimeout(r, m.ms))).then(() => reply(m.id, { slept: m.ms }));
    if (test && m.op === 'hang') return; // never answers
    if (test && m.op === 'wedge') { setTimeout(() => process.send({ id: m.id, ok: true, result: {} }), 0); const end = Date.now() + m.ms; while (Date.now() < end); return; } // blocks the loop: no ping can be answered
    if (test && m.op === 'crash') return process.exit(m.code === undefined ? 3 : m.code);
    if (test && m.op === 'fail') throw Object.assign(new Error('injected child failure'), m.code === undefined ? {} : { code: m.code });
    if (m.op === 'load') {
      const hb = setInterval(() => process.send({ id: m.id, progress: { heartbeat: true } }), HEARTBEAT_MS);
      try { return reply(m.id, await serial(() => load(m))); } finally { clearInterval(hb); }
    }
    if (m.op === 'rank') return reply(m.id, await serial(() => rank(m, m.id)));
    throw bad(`unknown rerank op ${m.op}`, 'E_INTERNAL');
  } catch (e) { fail(m.id, e); }
});
