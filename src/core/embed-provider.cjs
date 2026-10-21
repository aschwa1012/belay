'use strict';
// embed-provider.cjs — the registry of heavy embed providers (ADR 0050 decisions 3 and 4), the sibling of rerank-provider.cjs. A
// provider embeds with one pinned GGUF embedder held in the owner's shared GPU child (gpu-shared.cjs). nano never comes through here:
// it is the store's own embedder and embeds every note on write.
//
// get(tier, { owner }) -> the impl for the tier's embedder, or null. Only the store OWNER builds one (once per model id per process);
// a search outside the owner (a copy read, a client) gets null and says so loudly. This file requires only the error module and the
// tables it needs, and gpu-shared.cjs inside the branch that builds, so no read path loads the GPU client (invariant 9).
//
// impl: { model, dims,   (embedDocs takes an optional { deadline } and may return fewer rows than it was given)
//   async embedQuery(text) -> { embedding: number[], dim, model, ms }          the model's own query prompt is applied by the child
//   async embedDocs([{ id, text }]) -> [{ id, embedding: number[], dim }]     one unit vector per row, in order }
// The vectors are unit length at the table's dims (the child renormalises the Matryoshka cut), as memory-vectors.cjs stores them.

const { err } = require('./errors.cjs');

const providers = new Map();
let usedShared = false;

function register(name, impl) {
  if (typeof name !== 'string' || !name) throw err('E_ARGS', 'an embed provider needs the embedder model id it serves', { field: 'name' });
  if (!impl || typeof impl.embedQuery !== 'function' || typeof impl.embedDocs !== 'function') throw err('E_ARGS', `the embed provider for ${name} needs embedQuery(text) and embedDocs(rows) functions`, { field: 'impl' });
  providers.set(name, impl);
}
const unregister = (name) => providers.delete(name);

function build(model) {
  const GS = require('./gpu-shared.cjs'); // lazy: the owner's heavy tiers only
  const { ggufFor } = require('./gguf-models.cjs'); // a pure table
  const entry = ggufFor(model, process.env.BELAY_TEST_MODE === '1' ? (GS.testTable && GS.testTable()) : undefined);
  const one = async (text, as) => {
    await GS.ensureLoaded(model);
    const t0 = Date.now();
    const r = await GS.client().embed(model, text, { as });
    if (!r || !Array.isArray(r.embedding) || r.embedding.length !== entry.dims) throw err('E_DIM', `the GPU embedder ${model} answered ${r && Array.isArray(r.embedding) ? r.embedding.length : 'no'} dimensions and the table pins ${entry.dims}`, { gpu: true, cause: 'op_failed', model });
    return { embedding: r.embedding, dim: r.embedding.length, model, ms: Date.now() - t0 };
  };
  usedShared = true;
  return {
    model, dims: entry.dims,
    embedQuery: (text) => one(text, 'query'),
    // `opts.deadline` (epoch ms) bounds ONE batch too: past it the documents embedded so far are returned (at least one), the rest stay behind.
    async embedDocs(list, opts) { const out = []; for (const r of list) { if (out.length && opts && opts.deadline && Date.now() >= opts.deadline) break; const e = await one(r.text, 'document'); out.push({ id: r.id, embedding: e.embedding, dim: e.dim }); } return out; },
    close: () => GS.close(),
  };
}

// The impl for the tier's heavy embedder, or null for a tier with none (nano), or one nobody registered when asked outside the owner.
function get(tier, opts) {
  const name = tier && tier.embedder;
  if (!name) return null;
  if (providers.has(name)) return providers.get(name);
  const owner = opts && opts.owner;
  if (!owner) return null;
  if (typeof owner === 'object' && owner.stopped) return null; // a stopping owner forks no GPU child: its close has already taken its list
  const { describeModel } = require('./retrieval-profiles.cjs');
  const m = describeModel(name);
  if (!m || m.kind !== 'embedder' || m.runtime !== 'gguf') return null; // nano, or an id that is not a GPU embedder: nothing to build
  const impl = build(name);
  providers.set(name, impl);
  if (typeof owner === 'object') { (owner.embedBuilt = owner.embedBuilt || new Set()).add(name); owner.gpuUsed = true; }
  return impl;
}

// Forgets every provider and closes the shared GPU child (bounded, never throws). The owner calls it at shutdown.
async function closeAll(boundMs = 3000) {
  for (const [name, impl] of [...providers]) if (impl && typeof impl.close === 'function') providers.delete(name); // the built ones; a provider a test registered without a close stays
  if (!usedShared) return;
  usedShared = false;
  let timer;
  try { await Promise.race([require('./gpu-shared.cjs').close(), new Promise((r) => { timer = setTimeout(r, boundMs); })]); } catch { /* best effort */ } finally { clearTimeout(timer); }
}

// An Owner's stop: closes the providers it built, and the shared GPU child when it used one (its reranker or its embedder). Bounded, never throws.
async function closeOwned(owner, boundMs = 3000) {
  const hb = require.cache[require.resolve('./heavy-behind.cjs')]; // the owner's background catch-ups end first, and start no more
  if (hb) await hb.exports.cancel(owner, boundMs);
  const names = new Set((owner && owner.embedBuilt) || []);
  for (const n of names) providers.delete(n);
  if (!(owner && owner.gpuUsed)) return;
  usedShared = true;
  await closeAll(boundMs);
}

module.exports = { register, unregister, get, closeAll, closeOwned };
