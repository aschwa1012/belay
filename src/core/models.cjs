'use strict';
// models.cjs — the embedding model table (ADR 0027 decision 2). Pure data and a lookup: it requires
// nothing beyond errors.cjs, so a read path (doctor, status) may require it. Invariant 9 holds because
// nothing here reaches embedder.cjs or the embedding library.
//
// Each entry pins a Hugging Face commit (`sha`) and names every file transformers.js reads for the
// entry's dtype, with the byte size and sha256 of each. The LFS sha256 values come from the HF API at
// that commit; the small non-LFS files were hashed from the downloaded bytes, after their sizes matched
// the API's. `dims` is what the store keeps: a model whose native output is longer is truncated to the
// first `dims` and L2-renormalised (Matryoshka), which `embed()` does.

const { err } = require('./errors.cjs');

const MODELS = {
  'onnx-community/voyage-4-nano-ONNX': {
    id: 'onnx-community/voyage-4-nano-ONNX',
    sha: 'fb6f32cceb63b6eac92e1fdc08e00d03c41cdf5a',
    dtype: 'q4',
    pooling: 'mean',
    query_prompt: 'Represent the query for retrieving supporting documents: ',
    document_prompt: 'Represent the document for retrieval: ',
    native_dims: 2048,
    dims: 1024,
    max_tokens: 8192,
    license: 'apache-2.0',
    files: [
      { path: 'config.json', bytes: 1173, sha256: '0a37f11f814acca77619c3039409743285d15690eb33493d077784e653e9a524' },
      { path: 'tokenizer.json', bytes: 9116486, sha256: 'c40c3736449ad0f4084a187dfe16f6850b2a2933dfe041394f850608b2890140' },
      { path: 'tokenizer_config.json', bytes: 3262, sha256: 'ca057610cc7151781181806adda7ac01a2b09c4d4756983a9e49d69252689522' },
      { path: 'onnx/model_q4.onnx', bytes: 265959, sha256: '2a2f390055b2ab4f17e9e57ee8a8f948f905ea33e9111af0b297c9d8d372b99a' },
      { path: 'onnx/model_q4.onnx_data', bytes: 243001344, sha256: '38e29a9146c9f94bacee268002d453d146fb21805826b0dd26074e2f0e886abf' },
    ],
  },
  'Xenova/all-MiniLM-L6-v2': {
    id: 'Xenova/all-MiniLM-L6-v2',
    sha: '751bff37182d3f1213fa05d7196b954e230abad9',
    dtype: 'fp32',
    pooling: 'mean',
    query_prompt: '',
    document_prompt: '',
    native_dims: 384,
    dims: 384,
    max_tokens: 512,
    license: 'apache-2.0',
    files: [
      { path: 'config.json', bytes: 650, sha256: '7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7' },
      { path: 'tokenizer.json', bytes: 711661, sha256: 'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0' },
      { path: 'tokenizer_config.json', bytes: 366, sha256: '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3' },
      { path: 'onnx/model.onnx', bytes: 90387606, sha256: '759c3cd2b7fe7e93933ad23c4c9181b7396442a2ed746ec7c1d46192c469c46e' },
    ],
  },
};

const DEFAULT_MODEL = 'onnx-community/voyage-4-nano-ONNX';


// The embedding package belay pins (package.json optionalDependencies, exact). A package of any other
// version is refused E_MODEL_ABSENT (ADR 0027 decision 1).
const PKG_VERSION = '4.3.0';

// Every entry is validated before use, whether it comes from this table or from the test-only table file
// of cmd-embedder.cjs: the id and every file path become filesystem paths under the cache, and the sha
// names a directory. Returns a list of problems, empty when the entry is sound.
function entryProblems(e) {
  const bad = [];
  if (!e || typeof e !== 'object') return ['the entry is not an object'];
  if (typeof e.id !== 'string' || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(e.id) || e.id.split('/').includes('..')) bad.push(`id ${JSON.stringify(e.id)} is not <org>/<name>`);
  if (typeof e.sha !== 'string' || !/^[0-9a-f]{40}$/.test(e.sha)) bad.push(`sha ${JSON.stringify(e.sha)} is not 40 hex`);
  if (!Array.isArray(e.files) || !e.files.length) bad.push('files is not a non-empty list');
  else {
    for (const f of e.files) {
      const p = f && f.path;
      if (typeof p !== 'string' || !p || p.startsWith('/') || p.includes('\\') || /^[A-Za-z]:/.test(p) || p.split('/').some(seg => seg === '..' || seg === '.' || seg === '')) bad.push(`file path ${JSON.stringify(p)} is not a relative forward-slash path without .. or a drive letter`);
      if (!f || !Number.isInteger(f.bytes) || f.bytes <= 0) bad.push(`file ${JSON.stringify(p)}: bytes is not a positive integer`);
      if (!f || typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) bad.push(`file ${JSON.stringify(p)}: sha256 is not 64 hex`);
    }
  }
  return bad;
}

function validateEntry(e) {
  const bad = entryProblems(e);
  if (bad.length) throw err('E_ARGS', `the model table entry ${JSON.stringify(e && e.id)} is unusable: ${bad.join('; ')}`, { model: e && e.id, problems: bad });
  return e;
}

function modelFor(id) {
  const e = Object.prototype.hasOwnProperty.call(MODELS, id) ? MODELS[id] : null;
  if (!e) throw err('E_ARGS', `unknown embedding model ${JSON.stringify(id)}; the known ids are ${Object.keys(MODELS).join(', ')}`, { model: id, known: Object.keys(MODELS) });
  return validateEntry(e);
}

module.exports = { MODELS, DEFAULT_MODEL, PKG_VERSION, modelFor, validateEntry, entryProblems };
