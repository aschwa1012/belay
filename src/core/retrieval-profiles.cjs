'use strict';
// retrieval-profiles.cjs — the named retrieval profiles and the model lookups the levers and the routing resolver
// share (ADR 0050 decision 3 and the handoff's profiles table). Pure data: it requires only errors.cjs and the two
// model tables, so a read path (settings, status, a menu) may load it. Invariant 9 holds because nothing here
// reaches an embedder, the GPU child or any model file.
//
// A profile is an embedder and a reranker, both named by model id. The device is not stored: it follows from the
// model (a `runtime: 'gguf'` entry runs on the GPU, every ONNX entry on the CPU), so the table cannot disagree
// with the model tables. nano is the base: it embeds every note whatever the profile says (ADR 0050 decision 3).

const { err } = require('./errors.cjs');
const { MODELS, DEFAULT_MODEL } = require('./models.cjs');
const { GGUF_MODELS } = require('./gguf-models.cjs');

const NANO = DEFAULT_MODEL;
const DEFAULT_DEPTH = 50; // every profile, on every device, until the 0.3.2 eval re-picks it (operator, 2026-10-17)

// The CPU (ONNX) rerankers. They are not in models.cjs: that table is iterated as the embedder table. `pending_pin`
// means the commit and the file hashes are not recorded yet, so the entry names a model but cannot be fetched or
// run; the resolver refuses it with E_MODEL. The pin (sha, files with bytes and sha256) comes in the next piece.
const ONNX_RERANKERS = {
  'jinaai/jina-reranker-v1-tiny-en': {
    id: 'jinaai/jina-reranker-v1-tiny-en', runtime: 'onnx', kind: 'reranker', dtype: 'int8',
    label: 'jina-reranker-v1-tiny-en int8', pending_pin: true,
  },
  'Alibaba-NLP/gte-reranker-modernbert-base': {
    id: 'Alibaba-NLP/gte-reranker-modernbert-base', runtime: 'onnx', kind: 'reranker', dtype: 'int8',
    label: 'gte-reranker-modernbert-base int8', pending_pin: true,
  },
};

const JINA_TINY = 'jinaai/jina-reranker-v1-tiny-en';
const GTE_MODERN = 'Alibaba-NLP/gte-reranker-modernbert-base';
const QWEN_RERANK_06 = 'ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF';
const QWEN_RERANK_4B = 'giladgd/Qwen3-Reranker-4B-GGUF';
const QWEN_EMBED_4B = 'Qwen/Qwen3-Embedding-4B-GGUF';
const QWEN_EMBED_8B = 'Qwen/Qwen3-Embedding-8B-GGUF';

const PROFILES = Object.freeze({
  'cpu-fast': Object.freeze({ embedder: NANO, reranker: null }),
  'cpu-rerank-light': Object.freeze({ embedder: NANO, reranker: JINA_TINY }),
  'cpu-rerank': Object.freeze({ embedder: NANO, reranker: GTE_MODERN }),
  'gpu-rerank-fast': Object.freeze({ embedder: NANO, reranker: QWEN_RERANK_06 }),
  'gpu-rerank': Object.freeze({ embedder: NANO, reranker: QWEN_RERANK_4B }),
  'gpu-balanced': Object.freeze({ embedder: QWEN_EMBED_4B, reranker: QWEN_RERANK_4B }),
  'gpu-recall-max': Object.freeze({ embedder: QWEN_EMBED_8B, reranker: QWEN_RERANK_06 }),
});
const PROFILE_NAMES = Object.freeze(Object.keys(PROFILES));
const FALLBACK_PROFILE = 'cpu-fast';
const CUSTOM = 'custom';

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// What a model id is: { id, kind: 'embedder'|'reranker', runtime: 'onnx'|'gguf', device: 'cpu'|'gpu', pending_pin }, or null.
function describeModel(id) {
  if (typeof id !== 'string') return null;
  if (has(GGUF_MODELS, id)) { const e = GGUF_MODELS[id]; return { id, kind: e.kind, runtime: 'gguf', device: 'gpu', pending_pin: false }; }
  if (has(ONNX_RERANKERS, id)) { const e = ONNX_RERANKERS[id]; return { id, kind: 'reranker', runtime: 'onnx', device: 'cpu', pending_pin: e.pending_pin === true }; }
  if (has(MODELS, id)) return { id, kind: 'embedder', runtime: 'onnx', device: 'cpu', pending_pin: false };
  return null;
}

const embedderIds = () => [...Object.keys(MODELS), ...Object.values(GGUF_MODELS).filter((e) => e.kind === 'embedder').map((e) => e.id)];
const rerankerIds = () => [...Object.keys(ONNX_RERANKERS), ...Object.values(GGUF_MODELS).filter((e) => e.kind === 'reranker').map((e) => e.id)];

// An embedder / reranker id the levers accept (the reranker also takes the word none). Returns an error sentence or null.
function embedderProblem(id) {
  const m = describeModel(id);
  return m && m.kind === 'embedder' ? null : `${JSON.stringify(id)} is not an embedder in the model tables (known: ${embedderIds().join(', ')})`;
}
function rerankerProblem(id) {
  if (id === 'none') return null;
  const m = describeModel(id);
  return m && m.kind === 'reranker' ? null : `${JSON.stringify(id)} is not a reranker in the model tables (known: none, ${rerankerIds().join(', ')})`;
}

// A pending model cannot run: it has no pinned commit or hashes yet.
function assertUsable(id) {
  const m = describeModel(id);
  if (m && m.pending_pin) {
    throw err('E_MODEL', `${id} is listed but its commit and file hashes are not pinned yet, so it cannot be fetched or run`, { model: id, reason: 'pending_pin' });
  }
  return m;
}

// The profile's models: { embedder, reranker } ids, the reranker null for none.
function profileModels(name) {
  if (!has(PROFILES, name)) throw err('E_ARGS', `unknown retrieval profile ${JSON.stringify(name)}; the profiles are ${PROFILE_NAMES.join(', ')}, ${CUSTOM}`, { profile: name, known: PROFILE_NAMES });
  return { ...PROFILES[name] };
}

const needsGpu = (models) => [models.embedder, models.reranker].some((id) => id && describeModel(id) && describeModel(id).device === 'gpu');

module.exports = {
  PROFILES, PROFILE_NAMES, FALLBACK_PROFILE, CUSTOM, NANO, DEFAULT_DEPTH, ONNX_RERANKERS,
  describeModel, embedderProblem, rerankerProblem, assertUsable, profileModels, needsGpu,
};
