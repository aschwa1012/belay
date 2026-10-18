'use strict';
// gguf-models.cjs — the GPU model table (ADR 0049 decision 5). Pure data and a lookup, like models.cjs, and
// kept apart from it: code iterates models.cjs MODELS as the embedder table, and these run on another runtime.
// It requires only errors.cjs and models.cjs, so a read path (doctor, status, a menu) may require it.
//
// An entry has the shape models.cjs entries have (id, sha, files with bytes and sha256), so the cache layout,
// the pinned download and the sha256 verify of `belay embedder fetch` serve it unchanged. `id` is the Hugging
// Face repository, `sha` its commit, and `files` the one GGUF file. Every size and sha256 is the Hugging Face
// API's at that commit (?blobs=true, lfs.sha256), cross-checked against the hash of the file the GPU bench
// downloaded for the GPU bench, and the two agree for all five.
//
// `runtime: 'gguf'` names the runtime that serves the entry (ADR 0049 decision 1). The ONNX entries of
// models.cjs carry no such field: nothing reads one there, and an added key would reach every reader and test
// that compares those entries whole.
//
// `vram_mb_ref` is the peak MiB the GPU bench measured on the reference laptop (RTX 5060, Vulkan, driver
// 617.42) at the context size below. It is a hint to show in a menu and nothing else: the probe measures the
// real peak before anything loads for a run (ADR 0049 decision 6).
//
// Embedders: Qwen3-Embedding pools the last token (read from the GGUF) and takes an instruction on the query
// side only. The reranker entries score through node-llama-cpp's ranking context, which needs the classifier
// head and the rerank template in the GGUF: mradermacher's 4B conversion lacks them (it fails with "Computing
// rankings is not supported for this model"), so the 4B comes from giladgd.

const { err } = require('./errors.cjs');
const { entryProblems } = require('./models.cjs');

const QUERY_INSTRUCTION = 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ';

const embedder = (e) => ({ runtime: 'gguf', kind: 'embedder', pooling: 'last', query_prompt: QUERY_INSTRUCTION, document_prompt: '', license: 'apache-2.0', context_size: 1024, ...e });
const reranker = (e) => ({ runtime: 'gguf', kind: 'reranker', pooling: null, query_prompt: '', document_prompt: '', native_dims: null, dims: null, license: 'apache-2.0', context_size: 2048, ...e });

const GGUF_MODELS = {
  'Qwen/Qwen3-Embedding-0.6B-GGUF': embedder({
    id: 'Qwen/Qwen3-Embedding-0.6B-GGUF',
    sha: '370f27d7550e0def9b39c1f16d3fbaa13aa67728',
    label: 'Qwen3-Embedding-0.6B Q8_0',
    native_dims: 1024, dims: 1024, vram_mb_ref: 764,
    files: [{ path: 'Qwen3-Embedding-0.6B-Q8_0.gguf', bytes: 639150592, sha256: '06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439' }],
  }),
  'Qwen/Qwen3-Embedding-4B-GGUF': embedder({
    id: 'Qwen/Qwen3-Embedding-4B-GGUF',
    sha: 'f4602530db1d980e16da9d7d3a70294cf5c190be',
    label: 'Qwen3-Embedding-4B Q4_K_M',
    native_dims: 2560, dims: 2560, vram_mb_ref: 2629,
    files: [{ path: 'Qwen3-Embedding-4B-Q4_K_M.gguf', bytes: 2496703776, sha256: '2b0cf8f17b4c723c27303015383c27ec4bf2d8314bb677d05e920dd70bb0f16b' }],
  }),
  'Qwen/Qwen3-Embedding-8B-GGUF': embedder({
    id: 'Qwen/Qwen3-Embedding-8B-GGUF',
    sha: '69d0e58a13e463cd99a9b83e3f5fee7c10265fab',
    label: 'Qwen3-Embedding-8B Q4_K_M',
    native_dims: 4096, dims: 4096, vram_mb_ref: 4742,
    files: [{ path: 'Qwen3-Embedding-8B-Q4_K_M.gguf', bytes: 4676804928, sha256: '3fcd3febec8b3fd64435204db75bf0dd73b91e8d0661e0331acfe7e7c3120b85' }],
  }),
  'ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF': reranker({
    id: 'ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF',
    sha: 'a02f48bb4f057028298c21fa033da2b30d7742d5',
    label: 'Qwen3-Reranker-0.6B Q8_0',
    vram_mb_ref: 879,
    files: [{ path: 'qwen3-reranker-0.6b-q8_0.gguf', bytes: 639153184, sha256: '22c9979ce4fbcdc5acdc310c6641c32797eff1aa980b8f7a2db8a8ea23429a48' }],
  }),
  'giladgd/Qwen3-Reranker-4B-GGUF': reranker({
    id: 'giladgd/Qwen3-Reranker-4B-GGUF',
    sha: '618ca919a196583806708d695f64dc002bd229a3',
    label: 'Qwen3-Reranker-4B Q4_K_M',
    vram_mb_ref: 2782,
    files: [{ path: 'Qwen3-Reranker-4B.Q4_K_M.gguf', bytes: 2496717472, sha256: '941f7d1d1524251c026a797b803ac9575545c5d7aa19b26e0e49661d7720af49' }],
  }),
};

// models.cjs's checks (id, commit, every file path, size and sha256) plus this table's own fields.
function ggufProblems(e) {
  const bad = entryProblems(e);
  if (!e || typeof e !== 'object') return bad;
  if (e.runtime !== 'gguf') bad.push(`runtime ${JSON.stringify(e.runtime)} is not 'gguf'`);
  if (e.kind !== 'embedder' && e.kind !== 'reranker') bad.push(`kind ${JSON.stringify(e.kind)} is not embedder or reranker`);
  if (Array.isArray(e.files) && e.files.length !== 1) bad.push('a GGUF entry names exactly one file');
  if (e.kind === 'embedder') {
    if (!Number.isInteger(e.dims) || e.dims <= 0 || !Number.isInteger(e.native_dims) || e.dims > e.native_dims) bad.push('dims and native_dims are not positive integers with dims <= native_dims');
    if (typeof e.pooling !== 'string' || !e.pooling) bad.push('pooling is not named');
    if (typeof e.query_prompt !== 'string' || typeof e.document_prompt !== 'string') bad.push('query_prompt and document_prompt must be strings');
  }
  if (!Number.isInteger(e.vram_mb_ref) || e.vram_mb_ref <= 0) bad.push('vram_mb_ref is not a positive integer');
  if (!Number.isInteger(e.context_size) || e.context_size <= 0) bad.push('context_size is not a positive integer');
  return bad;
}

function validateGguf(e) {
  const bad = ggufProblems(e);
  if (bad.length) throw err('E_ARGS', `the GPU model table entry ${JSON.stringify(e && e.id)} is unusable: ${bad.join('; ')}`, { model: e && e.id, problems: bad });
  return e;
}

// `table` is a test's own (the probe and the client pass it through); production reads GGUF_MODELS.
function ggufFor(id, table = GGUF_MODELS) {
  const e = Object.prototype.hasOwnProperty.call(table, id) ? table[id] : null;
  if (!e) throw err('E_ARGS', `unknown GPU model ${JSON.stringify(id)}; the known ids are ${Object.keys(table).join(', ')}`, { model: id, known: Object.keys(table) });
  return validateGguf(e);
}

module.exports = { GGUF_MODELS, QUERY_INSTRUCTION, ggufFor, ggufProblems, validateGguf };
