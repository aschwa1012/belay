'use strict';
// gpu-chunk.cjs — how a rerank is cut into submissions (ADR 0049 decision 7). Pure arithmetic, required by the GPU
// child (to cut) and by the probe (to size the cut).
//
// What is and is not bounded. node-llama-cpp's rankAll evaluates a chunk of pairs as many llama.cpp decodes. Two
// settings bound the work, and neither is a wall-clock guarantee:
//   - `batchSize` on the ranking context bounds the TOKENS in one decode (one GPU submission). The probe loads a
//     reranker with it, times a single document that fills it (`ubatch_ms`), and refuses a model whose full batch
//     takes longer than the target. That measured time is the longest single submission the probe can observe.
//   - the chunk bounds the TOKENS handed to one rankAll call, so the time between two progress lines (and so the
//     owner's silence clock) stays near the target. A chunk is many submissions, not one.
// A pair costs its document's tokens, capped at what the context can hold, plus the query and the rerank template
// (an estimate: the template is not tokenised here). A document longer than the cap is truncated by the child,
// because rankAll throws on an input that does not fit, and the truncation is reported.

const RANK_TEMPLATE_TOKENS = 80; // the Qwen3 rerank prompt around the query and the document, rounded up
const CHUNK_MARGIN = 1.5;       // headroom for a slower run than the one measured
const CHUNK_MAX_PAIRS = 50;     // the rerank depth (ADR 0050 decision 5)

// The most document tokens a pair may carry in a context of `contextSize`.
function docCap(contextSize, queryTokens) {
  return Math.max(1, contextSize - queryTokens - RANK_TEMPLATE_TOKENS - 8);
}

// Cuts pairs, in order, into [start, end) ranges: a range ends at `maxPairs` pairs or when the next pair would
// take it past `maxTokens`. A pair that alone exceeds `maxTokens` still goes out, alone.
function planChunks(costs, { maxPairs = CHUNK_MAX_PAIRS, maxTokens = Infinity } = {}) {
  const out = [];
  let start = 0, sum = 0;
  for (let i = 0; i < costs.length; i += 1) {
    if (i > start && (i - start >= maxPairs || sum + costs[i] > maxTokens)) { out.push([start, i]); start = i; sum = 0; }
    sum += costs[i];
  }
  if (start < costs.length) out.push([start, costs.length]);
  return out;
}

// Tokens per chunk from the measured cost of one token.
function deriveChunkTokens(msPerToken, { targetMs = 1000, margin = CHUNK_MARGIN } = {}) {
  if (!(msPerToken > 0)) return Infinity;
  return Math.max(1, Math.floor(targetMs / (msPerToken * margin)));
}

module.exports = { RANK_TEMPLATE_TOKENS, CHUNK_MARGIN, CHUNK_MAX_PAIRS, docCap, planChunks, deriveChunkTokens };
