'use strict';
// rerank-pure.cjs — the arithmetic of a CPU rerank, with no model, no process and no I/O, so tests run the real
// formulas without a model. Required by rerank-worker.cjs (to cut and to score) and by rerank-cpu.cjs.
//
//   planPairs        how n pairs are cut into [start, end) chunks of at most `chunk` pairs
//   sigmoid          the score transform of the table (onnx-rerankers.cjs score_transform 'sigmoid')
//   scoresFromLogits a [n, k] logits block to n scores: one logit per pair goes through the sigmoid; two logits are
//                    the second minus the first, then the sigmoid. Any other width is refused.
//   countAtLimit     how many rows of an [n, L] attention mask are exactly `maxLength` tokens long. The tokenizer cuts
//                    a pair at max_length, so a row at the limit was cut or just filled it; a row under it was not cut.

const DEFAULT_CHUNK = 10; // pairs per model call: small enough that a progress line follows every few hundred milliseconds of CPU work

function planPairs(n, chunk = DEFAULT_CHUNK) {
  const size = Math.max(1, Math.floor(Number(chunk) || DEFAULT_CHUNK));
  const out = [];
  for (let from = 0; from < n; from += size) out.push([from, Math.min(n, from + size)]);
  return out;
}

const sigmoid = (x) => (x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x)));

function scoresFromLogits(data, dims) {
  if (!Array.isArray(dims) || dims.length !== 2) throw new Error(`the logits have shape ${JSON.stringify(dims)} and the reranker head is [pairs, 1] or [pairs, 2]`);
  const [n, k] = dims;
  if (k !== 1 && k !== 2) throw new Error(`the logits have ${k} columns and the reranker head is 1 or 2 wide`);
  if (data.length !== n * k) throw new Error(`the logits hold ${data.length} values for shape ${JSON.stringify(dims)}`);
  const logits = new Array(n);
  const scores = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const z = k === 1 ? Number(data[i]) : Number(data[i * 2 + 1]) - Number(data[i * 2]);
    if (!Number.isFinite(z)) throw new Error(`pair ${i} scored ${z}`);
    logits[i] = z; scores[i] = sigmoid(z);
  }
  return { logits, scores };
}

function countAtLimit(mask, dims, maxLength) {
  const [n, len] = dims;
  let at = 0;
  for (let i = 0; i < n; i += 1) {
    let sum = 0;
    for (let j = 0; j < len; j += 1) sum += Number(mask[i * len + j]);
    if (sum >= maxLength) at += 1;
  }
  return at;
}

module.exports = { DEFAULT_CHUNK, planPairs, sigmoid, scoresFromLogits, countAtLimit };
