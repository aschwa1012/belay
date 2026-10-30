'use strict';
// onnx-rerankers.cjs — the CPU reranker table (ADR 0050 decisions 5 and 6, the pins promised by retrieval-profiles.cjs).
// Pure data and a lookup, like models.cjs, and kept apart from it: code iterates models.cjs MODELS as the embedder
// table, and these are sequence-classification models run by rerank-worker.cjs. It requires only errors.cjs and
// models.cjs, so a read path (doctor, a menu, the levers) may require it. Nothing here reaches the embedding library.
//
// An entry has the shape models.cjs entries have (id, sha, files with bytes and sha256), so the cache layout
// (model-cache.cjs), the pinned download and the sha256 verify of `belay embedder fetch --reranker <id>` serve it
// unchanged. Every size and sha256 is the Hugging Face API's at that commit (?blobs=true, lfs.sha256 for the ONNX
// file), and the files were hashed again at <repo>/resolve/<sha>/<path>; all four per model agree with the files the
// GPU bench's transformers.js 4.3.0 run loaded.
//
// transformers.js reads, for `AutoModelForSequenceClassification` at dtype int8, config.json, tokenizer.json,
// tokenizer_config.json and onnx/model_int8.onnx; nothing else is listed because nothing else is read.
//
//   max_length        the longest query-plus-document token sequence the worker feeds the model; the tokenizer
//                     truncates beyond it (the bench ran both at 512). For gte-reranker-modernbert-base 512 is a
//                     latency choice: its tokenizer allows 8192. The limit covers the PAIR, so a query longer than
//                     max_length truncates every pair.
//   score_transform   'sigmoid': the logit goes through 1 / (1 + e^-x). One logit per pair; a two-logit head would
//                     use the second minus the first.

const { err } = require('./errors.cjs');
const { entryProblems } = require('./models.cjs');

const ONNX_RERANKER_TABLE = {
  'jinaai/jina-reranker-v1-tiny-en': {
    id: 'jinaai/jina-reranker-v1-tiny-en',
    sha: 'aca45de6945b5dc6399abcd2a9c55ded5dc9111f',
    runtime: 'onnx', kind: 'reranker', dtype: 'int8',
    label: 'jina-reranker-v1-tiny-en int8',
    max_length: 512,
    score_transform: 'sigmoid',
    license: 'apache-2.0',
    files: [
      { path: 'config.json', bytes: 1206, sha256: 'dc70646aa6c9e75e3c513cc9c037f35ad54308001c3961d45c0f69749bcfb022' },
      { path: 'tokenizer.json', bytes: 2030772, sha256: '0046da43cc8c424b317f56b092b0512aaaa65c4f925d2f16af9d9eeb4d0ef902' },
      { path: 'tokenizer_config.json', bytes: 1215, sha256: 'd291c6652d96d56ffdbcf1ea19d9bae5ed79003f7648c627e725a619227ce8fa' },
      { path: 'onnx/model_int8.onnx', bytes: 33424854, sha256: '5fa8508528828b4ad9bc97c97b6e020984e3b745fbcb53f0a907e68704f8a18a' },
    ],
  },
  'Alibaba-NLP/gte-reranker-modernbert-base': {
    id: 'Alibaba-NLP/gte-reranker-modernbert-base',
    sha: 'f7481e6055501a30fb19d090657df9ec1f79ab2c',
    runtime: 'onnx', kind: 'reranker', dtype: 'int8',
    label: 'gte-reranker-modernbert-base int8',
    max_length: 512,
    score_transform: 'sigmoid',
    license: 'apache-2.0',
    files: [
      { path: 'config.json', bytes: 1333, sha256: 'c9316ff715158502dad782f35454eee18de984160618dc30afe7508feb46b7ce' },
      { path: 'tokenizer.json', bytes: 3583499, sha256: '2aea6ff4701d063e7e029b6be695a1659f2caaa2ae4fb0e8b18285818271becd' },
      { path: 'tokenizer_config.json', bytes: 21031, sha256: '626c86908d7c711f93b0feffd8657b782cc2727b391f9be190240e8cafb626d5' },
      { path: 'onnx/model_int8.onnx', bytes: 150871837, sha256: 'ecc6a0ae67cee3d898167802383112d9185ca9250e07bd5d1fa65019b050179d' },
    ],
  },
};

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// The shared entry checks (id, sha, files) plus what only a CPU reranker entry needs. Returns a list of problems,
// empty when the entry is sound. `cmd-embedder.cjs` runs it on a test table file's entries as well.
function rerankerProblems(e) {
  const bad = entryProblems(e);
  if (!e || typeof e !== 'object') return bad;
  if (e.runtime !== 'onnx') bad.push(`runtime ${JSON.stringify(e.runtime)} is not 'onnx'`);
  if (e.kind !== 'reranker') bad.push(`kind ${JSON.stringify(e.kind)} is not 'reranker'`);
  if (typeof e.dtype !== 'string' || !/^[a-z0-9]+$/.test(e.dtype)) bad.push(`dtype ${JSON.stringify(e.dtype)} is not a dtype word`);
  if (!Number.isInteger(e.max_length) || e.max_length < 16 || e.max_length > 8192) bad.push(`max_length ${JSON.stringify(e.max_length)} is not an integer from 16 to 8192`);
  if (e.score_transform !== 'sigmoid') bad.push(`score_transform ${JSON.stringify(e.score_transform)} is not 'sigmoid'`);
  if (typeof e.license !== 'string' || !e.license) bad.push('license is missing');
  if (Array.isArray(e.files)) {
    const paths = new Set(e.files.map(f => f && f.path));
    for (const need of ['config.json', 'tokenizer.json', 'tokenizer_config.json', `onnx/model_${e.dtype}.onnx`]) if (!paths.has(need)) bad.push(`files lacks ${need}`);
  }
  return bad;
}

function rerankerFor(id, table = ONNX_RERANKER_TABLE) {
  const e = has(table, id) ? table[id] : null;
  if (!e) throw err('E_ARGS', `unknown CPU reranker ${JSON.stringify(id)}; the known ids are ${Object.keys(table).join(', ')}`, { model: id, known: Object.keys(table) });
  const bad = rerankerProblems(e);
  if (bad.length) throw err('E_ARGS', `the reranker table entry ${JSON.stringify(id)} is unusable: ${bad.join('; ')}`, { model: id, problems: bad });
  return e;
}

module.exports = { ONNX_RERANKER_TABLE, rerankerProblems, rerankerFor };
