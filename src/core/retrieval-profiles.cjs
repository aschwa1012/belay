'use strict';
// retrieval-profiles.cjs — the named retrieval profiles and the model lookups the levers and the routing resolver
// share (ADR 0050 decision 3 and the handoff's profiles table). Pure data: it requires only errors.cjs and the
// model tables (onnx-rerankers.cjs among them), so a read path (settings, status, a menu) may load it. Invariant 9
// holds because nothing here reaches an embedder, the GPU child or any model file.
//
// A profile is an embedder and a reranker, both named by model id. The device is not stored: it follows from the
// model (a `runtime: 'gguf'` entry runs on the GPU, every ONNX entry on the CPU), so the table cannot disagree
// with the model tables. nano is the base: it embeds every note whatever the profile says (ADR 0050 decision 3).

const { err } = require('./errors.cjs');
const { MODELS, DEFAULT_MODEL } = require('./models.cjs');
const { ONNX_RERANKER_TABLE } = require('./onnx-rerankers.cjs');

// The GPU models by kind. This is a deliberate copy of the ids and kinds of gguf-models.cjs, not a require of it:
// openCore loads memory-levers, which loads this file, and a default run must load no GPU module (ADR 0049,
// tests/core/gpu-import-graph.test.cjs). tests/core/retrieval-levers.test.cjs checks the copy against the table.
const GGUF_KINDS = Object.freeze({
  'Qwen/Qwen3-Embedding-0.6B-GGUF': 'embedder',
  'Qwen/Qwen3-Embedding-4B-GGUF': 'embedder',
  'Qwen/Qwen3-Embedding-8B-GGUF': 'embedder',
  'ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF': 'reranker',
  'giladgd/Qwen3-Reranker-4B-GGUF': 'reranker',
});

const NANO = DEFAULT_MODEL;
const DEFAULT_DEPTH = 50; // every profile, on every device, until the 0.3.2 eval re-picks it (operator, 2026-10-17)

// The CPU (ONNX) rerankers. They are not in models.cjs: that table is iterated as the embedder table. Their pins
// (commit, files with bytes and sha256, max_length, score transform) are in onnx-rerankers.cjs, a pure table this file
// may require. `pending_pin: true` is the mechanism for a model that is named but not yet pinned: it is listed but
// cannot be fetched or run, and the resolver refuses it with E_MODEL. No entry is pending today, so the mechanism is
// reachable only through tests (they mutate pending_pin on a live entry) until a future model is added unpinned.
const ONNX_RERANKERS = Object.fromEntries(Object.values(ONNX_RERANKER_TABLE).map(e => [e.id, {
  id: e.id, runtime: 'onnx', kind: 'reranker', dtype: e.dtype, label: e.label, pin: 'onnx-rerankers.cjs', pending_pin: false,
}]));

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
  if (has(GGUF_KINDS, id)) return { id, kind: GGUF_KINDS[id], runtime: 'gguf', device: 'gpu', pending_pin: false };
  if (has(ONNX_RERANKERS, id)) { const e = ONNX_RERANKERS[id]; return { id, kind: 'reranker', runtime: 'onnx', device: 'cpu', pending_pin: e.pending_pin === true }; }
  if (has(MODELS, id)) return { id, kind: 'embedder', runtime: 'onnx', device: 'cpu', pending_pin: false };
  return null;
}

const gguf = (kind) => Object.keys(GGUF_KINDS).filter((id) => GGUF_KINDS[id] === kind);
const embedderIds = () => [...Object.keys(MODELS), ...gguf('embedder')];
const rerankerIds = () => [...Object.keys(ONNX_RERANKERS), ...gguf('reranker')];

// A profile name, by own property: 'toString' and '__proto__' are not profiles.
const isProfile = (name) => typeof name === 'string' && has(PROFILES, name);

// The first model in a { embedder, reranker } pair whose pin is pending, or null. A pending model is listed but cannot run.
function pendingIn(models) {
  for (const id of [models.embedder, models.reranker]) { const m = id && describeModel(id); if (m && m.pending_pin) return id; }
  return null;
}
const pendingMessage = (id) => `${id} is not yet available in this build (its commit and file hashes are not pinned)`;

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
    throw err('E_MODEL', pendingMessage(id), { model: id, reason: 'pending_pin' });
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
  GGUF_KINDS, isProfile, pendingIn, pendingMessage, describeModel, embedderProblem, rerankerProblem, assertUsable, profileModels, needsGpu,
};
