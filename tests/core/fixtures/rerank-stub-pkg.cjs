'use strict';
// rerank-stub-pkg.cjs — a stand-in for belay's pinned transformers package, so the REAL rerank-worker.cjs runs in CI
// with no model and no onnx runtime. writeStubPackage(dir) lays out dir/package.json (version 4.3.0) and
// dir/src/transformers.js, exporting env, AutoTokenizer and AutoModelForSequenceClassification:
//   - the tokenizer takes (queries, { text_pair, padding, truncation, max_length }) like the real one, throws if the
//     worker does not ask for padding and truncation, counts ceil(chars / 4) + 3 tokens a pair capped at max_length,
//     and returns an [n, L] attention_mask (BigInt64Array, as the real int64 tensor) padded to the longest pair
//   - the model refuses a dtype whose onnx file is not in the directory and answers { logits } of shape [n, 1] (or
//     [n, 2] with { twoLogits: true }): 4 * (words in common with the query) - 2, so a relevant document scores high
//   - { keepAlive: true } holds an interval, standing in for the native threads that keep a real child's loop alive
//   - { rankDelayMs, loadDelayMs } make a model call or a load slow; { nanAt } makes pair i score NaN
// writeCache(cache, table) lays out each table entry's files where the cache looks for them, at the table's byte
// sizes, with a manifest.

const fs = require('node:fs');
const path = require('node:path');

function writeStubPackage(dir, { keepAlive = false, rankDelayMs = 0, loadDelayMs = 0, twoLogits = false, nanAt = -1, version = '4.3.0' } = {}) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@huggingface/transformers', version, type: 'module' }));
  fs.writeFileSync(path.join(dir, 'src', 'transformers.js'), `
    import fs from 'node:fs';
    import path from 'node:path';
    const KEEP = ${keepAlive ? 'true' : 'false'}, RANK_DELAY = ${Number(rankDelayMs)}, LOAD_DELAY = ${Number(loadDelayMs)}, TWO = ${twoLogits ? 'true' : 'false'}, NAN_AT = ${Number(nanAt)};
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const words = (s) => new Set(String(s).toLowerCase().match(/[a-z]{3,}/g) || []);
    export const env = { version: 'stub-4.3.0' };
    export class AutoTokenizer {
      static async from_pretrained(dir) {
        if (!fs.existsSync(path.join(dir, 'tokenizer.json'))) throw new Error('no tokenizer.json in ' + dir);
        return (queries, o) => {
          if (!o || o.padding !== true || o.truncation !== true || !Array.isArray(o.text_pair) || o.text_pair.length !== queries.length || !(o.max_length >= 16)) throw new Error('the worker called the tokenizer wrongly: ' + JSON.stringify(o && { ...o, text_pair: undefined }));
          const lens = queries.map((q, i) => Math.min(o.max_length, Math.ceil((q.length + o.text_pair[i].length) / 4) + 3));
          const L = Math.max(...lens), n = queries.length, data = new BigInt64Array(n * L);
          lens.forEach((l, i) => { for (let j = 0; j < l; j += 1) data[i * L + j] = 1n; });
          return { attention_mask: { data, dims: [n, L] }, input_ids: { dims: [n, L] }, _q: queries, _d: o.text_pair };
        };
      }
    }
    export class AutoModelForSequenceClassification {
      static async from_pretrained(dir, o) {
        if (LOAD_DELAY) await wait(LOAD_DELAY);
        if (!o || o.device !== 'cpu' || !o.dtype || !fs.existsSync(path.join(dir, 'onnx', 'model_' + o.dtype + '.onnx'))) throw new Error('no onnx file for ' + JSON.stringify(o) + ' in ' + dir);
        if (KEEP) setInterval(() => {}, 1000);
        const m = async (enc) => {
          if (RANK_DELAY) await wait(RANK_DELAY);
          const n = enc._q.length, k = TWO ? 2 : 1, data = new Float32Array(n * k);
          for (let i = 0; i < n; i += 1) {
            const q = words(enc._q[i]);
            const z = i === NAN_AT ? NaN : 4 * [...words(enc._d[i])].filter(w => q.has(w)).length - 2;
            if (TWO) { data[i * 2] = 0; data[i * 2 + 1] = z; } else data[i] = z;
          }
          return { logits: { data, dims: [n, k] } };
        };
        m.dispose = async () => {};
        return m;
      }
    }
  `);
  return dir;
}

function writeCache(cache, table) {
  for (const e of Object.values(table)) {
    const dir = path.join(cache, `${e.id}@${e.sha}`);
    for (const f of e.files) {
      fs.mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true });
      fs.writeFileSync(path.join(dir, f.path), Buffer.alloc(f.bytes, 1));
    }
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ sha: e.sha }));
  }
}

// A valid reranker table entry with tiny files, for the tests: max_length 32 so a short document fills it.
function fakeEntry(over = {}) {
  const id = over.id || 'fake-org/fake-reranker';
  const file = (p) => ({ path: p, bytes: 12, sha256: 'b'.repeat(64) });
  return {
    id, sha: 'a'.repeat(40), runtime: 'onnx', kind: 'reranker', dtype: 'int8', label: 'fake', max_length: 32, score_transform: 'sigmoid', license: 'none',
    files: ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_int8.onnx'].map(file), ...over,
  };
}

module.exports = { writeStubPackage, writeCache, fakeEntry };
