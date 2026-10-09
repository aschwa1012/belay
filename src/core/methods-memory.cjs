'use strict';
// methods-memory.cjs — the six memory methods (api.md §3, ADR 0002 §4, ADR 0003). Identity on a written
// row comes from `caller` and nothing else: a worker writes under its worker id, anyone else under its
// role. `namespace` defaults to `run/<run_id>`.

const { err } = require('./errors.cjs');

const nsFor = (caller, args) => args.namespace || `run/${caller.run_id}`;

// ADR 0034 decision 2: an error out of the embedder phase goes to the owner's onEmbedderFailure hook (set by
// `belay run`, which decides by detail.embedder === true whether it is an embedder failure), then is rethrown.
function notifyEmbedderFailure(E, caller, call, error) {
  const h = E.owner && E.owner.opts && E.owner.opts.onEmbedderFailure;
  if (typeof h !== 'function') return;
  try { Promise.resolve(h({ caller, by: E.writtenBy(caller), call, error })).catch(() => {}); } catch { /* the hook is the run's, never the caller's */ }
}

async function withEmbedding(E, args, field, textField, caller) {
  if (args[field]) return args;
  try {
    // Loads on first use, and raises E_NO_EMBEDDER, E_MODEL_ABSENT or E_MODEL_CHANGED as the case may be.
    // Only a call that needs a vector can fail this way; nothing else in the Core touches the model.
    const embedder = await E.getEmbedder();
    const e = await embedder.embed(args[textField], { as: field === 'embedding' ? 'document' : 'query' });
    return field === 'embedding'
      ? { ...args, embedding: e.embedding, embedding_model: e.embedding_model, embedding_revision: e.embedding_revision, dim: e.dim }
      : { ...args, query_embedding: e.embedding, embedding_model: e.embedding_model };
  } catch (e) {
    notifyEmbedderFailure(E, caller, field === 'embedding' ? 'memory.store' : 'memory.search', e);
    throw e;
  }
}

async function store(E, caller, args) {
  if (typeof args.text !== 'string' || !args.text.trim()) throw err('E_ARGS', 'memory.store needs non-empty text');
  const a = await withEmbedding(E, { ...args, namespace: nsFor(caller, args), worker_id: E.writtenBy(caller) }, 'embedding', 'text', caller);
  const row = E.store.store(a);
  E.noteWrite();
  return row;
}

async function get(E, caller, args) {
  if (!args.id) throw err('E_ARGS', 'memory.get needs an id');
  // memory.get is a read method (engine.cjs), and invariant 6 says reading never writes: without the
  // false here, retrieve() stamps accessed_at on the live store, moving memory.db's mtime and leaving
  // the owner's idle-TRUNCATE flag set so the checkpoint never re-runs.
  const row = E.store.retrieve(args.id, false);
  return row ? { ...row, found: true } : { id: args.id, found: false };
}

async function search(E, caller, args) {
  if (!args.query_embedding && typeof args.query !== 'string') {
    throw err('E_ARGS', 'memory.search needs a query string or a query_embedding');
  }
  const a = await withEmbedding(E, { ...args, namespace: nsFor(caller, args) }, 'query_embedding', 'query', caller);
  return E.store.search(a);
}

async function list(E, caller, args) {
  return { rows: E.store.list({ ...args, namespace: nsFor(caller, args) }) };
}

async function del(E, caller, args) {
  if (!args.id) throw err('E_ARGS', 'memory.delete needs an id');
  const r = E.store.delete(args.id);
  E.noteWrite();
  return r;
}

async function stats(E, caller) {
  const owner = E.ownerFact();
  // Say plainly whether this store can embed and why not when it cannot. Without it a caller meeting
  // E_MODEL_ABSENT on a write has no way to find out the state of the model.
  if (E.owner) {
    owner.embedder = E.owner.embedInfo || null;
    owner.embedder_error = E.owner.embedError || null;
  }
  return { ...E.store.stats(), owner };
}

// build 12b E2. Starts the load (or finds it started) and answers at once with the owner's own state;
// { reload: true } (alias retry) first clears a failed embedder (owner.resetEmbedder) and loads afresh; { wait: true } waits for the load (bounded by the caller's vector-call limit) and rejects with the
// embedder failure signature when it failed. A failed load is sticky for this owner, so every warm after
// it reports the same cause.
async function warm(E, caller, args = {}) {
  const o = E.owner;
  if ((args.reload || args.retry) && o && o.resetEmbedder) await o.resetEmbedder();
  const p = E.getEmbedder();
  if (args.wait) await p; else p.catch(() => { /* reported by state and error below */ });
  const state = o && o.embedState ? o.embedState() : 'unknown';
  return { state, pid: o && o.embedInfo ? o.embedInfo.pid : null, error: o && o.embedError ? o.embedError : null };
}

module.exports = { store, get, search, list, delete: del, stats, warm, nsFor };
