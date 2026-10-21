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

// The impl for the tier's reranker, or null when the tier has none or nobody registered it. Only the store OWNER ever builds one
// (ADR 0050 decision 5): with `opts.owner` true and a pinned CPU reranker id nobody registered, the CPU provider is built here, once
// per id per process, and registered. A search outside the owner (a copy read, a client) never forks a child; it gets null and the
// rerank stage says so loudly. rerank-cpu.cjs is required only inside that branch, so no read path loads it (invariant 9).
function get(tier, opts) {
  const name = tier && tier.reranker;
  if (!name) return null;
  if (providers.has(name)) return providers.get(name);
  if (!(opts && opts.owner === true)) return null;
  return autoBuild(name);
}

// Test seam (BELAY_TEST_MODE=1 alone): options merged into the auto-built CPU provider (pkg, cacheDir, table, workerPath, workerOpts).
let autoOpts = null;
let usesGpu = false; // set when a GPU provider was built: closeAll then closes the shared GPU child too
function setAutoOptions(o) { if (process.env.BELAY_TEST_MODE !== '1') throw err('E_ARGS', 'setAutoOptions is a test seam', {}); autoOpts = o || null; }

function autoBuild(name) {
  const extra = process.env.BELAY_TEST_MODE === '1' && autoOpts ? autoOpts : {};
  const { rerankerFor } = require('./onnx-rerankers.cjs'); // pure table
  try { rerankerFor(name, extra.table); } catch {
    // Not a pinned ONNX reranker. A pinned GGUF reranker is served by the owner's shared GPU child (ADR 0049); anything else has nothing to build.
    const m = require('./retrieval-profiles.cjs').describeModel(name); // a pure table
    if (!m || m.kind !== 'reranker' || m.runtime !== 'gguf') return null;
    const { gpuRerankProvider } = require('./gpu-rerank.cjs'); // lazy: the owner's GPU tiers only
    usesGpu = true;
    providers.set(name, gpuRerankProvider({ model: name }));
    return providers.get(name);
  }
  const { cpuRerankProvider } = require('./rerank-cpu.cjs'); // lazy: the owner's search only
  const impl = cpuRerankProvider({ model: name, ...extra });
  providers.set(name, { rerank: impl, close: impl.close });
  return providers.get(name);
}

// Closes every registered provider that has a close(), each bounded by boundMs; never throws. The owner calls it at shutdown. A closed
// provider is forgotten (a closed CPU provider starts no child again), so an owner started later in the same process builds its own.
async function closeAll(boundMs = 3000) {
  const all = [...providers.entries()];
  await Promise.all(all.map(async ([name, impl]) => {
    if (!impl || typeof impl.close !== 'function') return;
    if (providers.get(name) === impl) providers.delete(name);
    let timer;
    try { await Promise.race([Promise.resolve().then(() => impl.close()), new Promise((r) => { timer = setTimeout(r, boundMs); })]); } catch { /* best effort */ } finally { clearTimeout(timer); }
  }));
  if (usesGpu) { // one child holds every GPU model, so closing the reranker's provider closes it for the embedder too
    usesGpu = false;
    let timer;
    try { await Promise.race([require('./gpu-shared.cjs').close(), new Promise((r) => { timer = setTimeout(r, boundMs); })]); } catch { /* best effort */ } finally { clearTimeout(timer); }
  }
}

module.exports = { register, unregister, get, closeAll, setAutoOptions };
