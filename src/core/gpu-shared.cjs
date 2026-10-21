'use strict';
// gpu-shared.cjs — the store owner's one GPU child (ADR 0049 decision 3, ADR 0050 decisions 4 to 6). Every GPU model the owner serves,
// a reranker and an embedder alike, lives in ONE child process through load ops, so the probe's summed peaks are what the child
// really holds. The rerank provider (gpu-rerank.cjs) and the embed provider (embed-provider.cjs) share it; the owner closes it at
// shutdown through either provider's closeAll.
//
// Owner only, and lazy: nothing here is required until a pinned GPU tier asks for a model (rerank-provider.cjs and embed-provider.cjs
// require it inside the branch that needs it), so no read path loads gpu.cjs (invariant 9, tests/core/gpu-import-graph.test.cjs).
//
//   client()          the shared GpuClient, forked on first use. A child that died or hung is NOT replaced: its coded error is
//                     the answer to every later call (ADR 0049: nothing restarts by itself), and on_heavy_failure decides what the run does.
//   ensureLoaded(id)  loads one table model once; a load in flight is joined, a failed one is forgotten so the error is not cached.
//   probeOnce(...)    the probe of gpu-probe.cjs for a set of models, one at a time (two probes at once would each measure the other's
//                     models as used memory). A set the shared child already holds is not probed again: its last verdict stands.
//   close()           closes the child and forgets every load; safe to call twice.
// Test seam (BELAY_TEST_MODE=1 alone): setTestOptions({ clientOpts, probe, probeOpts }) names a fake child, a fake table, and a probe stub.

const { err } = require('./errors.cjs');

let shared = null;
const loads = new Map(); // model id -> promise of its load info
const verdicts = new Map(); // sorted model ids + headroom -> the probe's ok result, kept while the child holds them
let chain = Promise.resolve(); // probes run one at a time
let seams = null;

function setTestOptions(o) {
  if (process.env.BELAY_TEST_MODE !== '1') throw err('E_ARGS', 'setTestOptions is a test seam', {});
  seams = o || null;
}
const test = () => (process.env.BELAY_TEST_MODE === '1' && seams ? seams : {});

function client() {
  if (shared && !shared.closed) return shared;
  const { GpuClient } = require('./gpu.cjs'); // lazy: the owner's GPU tiers only
  const c = new GpuClient({ ...(test().clientOpts || {}) });
  c.start(); // E_MODEL_ABSENT naming the install command when the runtime is missing; nothing is kept then
  shared = c;
  return c;
}

// The per-model load settings the probe measured (its chunk sizing), by model id. Set by probeOnce.
const settings = new Map();

function ensureLoaded(modelId) {
  const c = client();
  const kept = loads.get(modelId);
  if (kept) return kept;
  const s = settings.get(modelId) || {};
  const p = c.load(modelId, { gpu: 'vulkan', ...s });
  loads.set(modelId, p);
  p.catch(() => { if (loads.get(modelId) === p) loads.delete(modelId); });
  return p;
}

const keyOf = (models, headroomMb) => `${[...models].sort().join('|')}@${headroomMb}`;

// -> the probe's result: { ok: true, ... } or { ok: false, refusal: { reason, message, options } }. Never throws.
function probeOnce(models, { headroomMb } = {}) {
  const key = keyOf(models, headroomMb);
  const run = async () => {
    if (shared && !shared.closed && verdicts.has(key) && models.every((m) => loads.has(m))) return verdicts.get(key);
    const probe = test().probe || require('./gpu-probe.cjs').probe; // lazy: it starts a child of its own and calls nvidia-smi
    const r = await probe({ models, headroomMb, ...(test().probeOpts || {}) });
    if (r && r.ok) {
      verdicts.set(key, r);
      for (const m of models) {
        const rr = r.rerank && r.rerank[m];
        if (rr) settings.set(m, { batchSize: rr.batch_size, chunk: rr.max_pairs, ...(Number.isFinite(rr.chunk_tokens) ? { chunkTokens: rr.chunk_tokens } : {}) });
      }
    }
    return r;
  };
  const p = chain.then(run, run);
  chain = p.then(() => {}, () => {});
  return p;
}

async function close() {
  const c = shared;
  shared = null; loads.clear(); verdicts.clear();
  if (c) { try { await c.close(); } catch { /* best effort */ } }
}

const testTable = () => (test().clientOpts || {}).table;
const isOpen = () => !!shared && !shared.closed;

module.exports = { client, ensureLoaded, probeOnce, close, isOpen, setTestOptions, testTable };
