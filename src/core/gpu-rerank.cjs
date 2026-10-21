'use strict';
// gpu-rerank.cjs — the GPU rerank provider (ADR 0050 decision 5, ADR 0049): scores a query against documents with one pinned GGUF
// reranker held in the owner's shared GPU child (gpu-shared.cjs). It is the GPU sibling of rerank-cpu.cjs's cpuRerankProvider and has
// the same shape, so rerank-provider.cjs registers either under the reranker's model id. Built in the store owner only.
//
// impl: { async rerank({ query, docs: [{ id, text }], depth, boundMs }) -> { scores: [{ id, score }], model, device: 'gpu', ms, warnings? } }
// The child cuts the documents into chunks (gpu-chunk.cjs) and answers one score per document, in order. Every failure is a coded
// error from the client (detail.gpu === true with a cause); the rerank stage turns it into E_RERANK and on_heavy_failure decides.

const { err } = require('./errors.cjs');
const GS = require('./gpu-shared.cjs');

function gpuRerankProvider({ model }) {
  if (typeof model !== 'string' || !model) throw err('E_ARGS', 'gpuRerankProvider needs a model id', { model: typeof model });
  const rerank = async ({ query, docs }) => {
    const t0 = Date.now();
    await GS.ensureLoaded(model);
    const r = await GS.client().rank(model, query, docs.map((d) => d.text));
    if (!r || !Array.isArray(r.scores) || r.scores.length !== docs.length) throw err('E_INTERNAL', `the GPU reranker ${model} scored ${r && Array.isArray(r.scores) ? r.scores.length : 0} of ${docs.length} documents`, { gpu: true, cause: 'op_failed' });
    return { scores: docs.map((d, i) => ({ id: d.id, score: r.scores[i] })), model, device: 'gpu', ms: Date.now() - t0, ...(r.warnings && r.warnings.length ? { warnings: r.warnings } : {}) };
  };
  return { rerank, close: () => GS.close() };
}

module.exports = { gpuRerankProvider };
