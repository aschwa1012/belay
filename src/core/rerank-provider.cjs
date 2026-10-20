'use strict';
// rerank-provider.cjs — the registry of rerank providers (ADR 0050 decision 5). A provider is the code that scores a query against
// documents with one reranker model. This file holds no model and loads none; it requires only the error module, so the search read
// path may load it (invariant 9). A provider module registers itself under the reranker's model id when it is loaded, and search
// asks `get(tier)` for the impl of the tier's reranker. Nothing is registered by default, so a tier that names a reranker nobody
// provides is a loud failure in the rerank stage (rerank-stage.cjs), never a quiet skip.
//
// impl: { async rerank({ query, docs: [{ id, text }], depth, boundMs }) ->
//           { scores: [{ id, score }], model, device, ms, warnings? } }
// `scores` carries one entry per doc, higher is better. `boundMs` is the stage's bound: an impl may use it to give up early; the
// stage enforces it either way.

const { err } = require('./errors.cjs');

const providers = new Map();

function register(name, impl) {
  if (typeof name !== 'string' || !name) throw err('E_ARGS', 'a rerank provider needs the reranker model id it serves', { field: 'name' });
  if (!impl || typeof impl.rerank !== 'function') throw err('E_ARGS', `the rerank provider for ${name} needs an async rerank({ query, docs, depth, boundMs }) function`, { field: 'impl' });
  providers.set(name, impl);
}
function unregister(name) { return providers.delete(name); }

// The impl for the tier's reranker, or null when the tier has none or nobody registered it.
function get(tier) {
  const name = tier && tier.reranker;
  return name && providers.has(name) ? providers.get(name) : null;
}

module.exports = { register, unregister, get };
