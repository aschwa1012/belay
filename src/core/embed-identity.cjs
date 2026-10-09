'use strict';
// embed-identity.cjs — the store's recorded embedding identity and the rules that judge a loaded
// embedder against it (ADR 0027 decisions 5 and 6). Pure functions over plain objects, no library and
// no filesystem, so embedder.cjs and owner.cjs share them without either growing past its budget.
//
// `stored` is the subset of the store's `meta` table these keys name, any of them absent:
//   embedding_model, embedding_sha, embedding_dtype, embedding_pooling, embedding_dim,
//   embedding_library, canary_vector (JSON array), canary_sha256 (legacy, never compared).

const crypto = require('node:crypto');
const { err } = require('./errors.cjs');
const { MODELS, DEFAULT_MODEL } = require('./models.cjs');

const COSINE_FLOOR = 0.9999;
const CANARY = 'memory-store canary: the quick brown fox jumps over the lazy dog';
const META_KEYS = ['embedding_model', 'embedding_sha', 'embedding_dtype', 'embedding_pooling', 'embedding_dim', 'embedding_library', 'canary_vector', 'canary_sha256'];

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// The legacy canary hash, still written for older readers and no longer compared.
function legacyCanaryHash(vec) {
  return crypto.createHash('sha256').update(Array.from(vec).map(x => x.toFixed(6)).join(',')).digest('hex');
}

// Which model a store uses: its own recorded one when it has one, else the caller's, else the default.
// ADR 0027 decision 6, in this order and no other: meta's embedding_model; else the model of the rows
// already embedded (namespace_models, passed as `rowModels`); else the caller's; else the default.
function chooseModel(stored, requested, rowModels = []) {
  const known = m => Object.prototype.hasOwnProperty.call(MODELS, m);
  const recorded = stored && stored.embedding_model;
  if (recorded) {
    if (!known(recorded)) {
      throw err('E_MODEL_CHANGED', `this store recorded the embedding model ${recorded}, which belay's model table does not know, so its vectors cannot be compared or extended`, { stored: recorded, known: Object.keys(MODELS) });
    }
    return recorded;
  }
  const rows = [...new Set(rowModels)];
  for (const m of rows) {
    if (!known(m)) throw err('E_MODEL_CHANGED', `this store holds rows embedded by ${m}, which belay's model table does not know, and it records no identity of its own, so belay cannot embed text into it without a re-embed (belay fails closed here: every text store and search is refused until the rows are re-embedded or removed)`, { rows_model: m, known: Object.keys(MODELS), needs: 're-embed' });
  }
  if (rows.length > 1) throw err('E_MODEL_CHANGED', `this store holds rows embedded by more than one model (${rows.join(', ')}), so no single model can extend it`, { rows_models: rows });
  if (rows.length === 1) return rows[0];
  return requested || DEFAULT_MODEL;
}

const LEGACY_KEYS = ['canary_sha256', 'embedding_dim', 'embedding_model'];
const LEGACY_MODEL = 'Xenova/all-MiniLM-L6-v2';
// The exact shape the old owner wrote in one INSERT for a MiniLM store.
const isLegacyShape = s => Object.keys(s).filter(k => s[k] !== undefined).sort().join() === LEGACY_KEYS.join()
  && s.embedding_model === LEGACY_MODEL && String(s.embedding_dim) === '384';

// Refuse, before embedding anything, a model whose id, sha or dims differ from the recorded ones.
function checkIdentity(entry, stored) {
  if (!stored) return;
  const bad = (what, recorded, now) => err('E_MODEL_CHANGED', `this store recorded ${what} ${recorded} and the embedder is now ${now}; the vectors already in it would not be comparable`, { what, stored: recorded, now });
  if (stored.embedding_model && stored.embedding_model !== entry.id) throw bad('the model', stored.embedding_model, entry.id);
  if (stored.embedding_sha && stored.embedding_sha !== entry.sha) throw bad('the model commit', stored.embedding_sha, entry.sha);
  if (stored.embedding_dim && String(stored.embedding_dim) !== String(entry.dims)) throw bad('the dimension', stored.embedding_dim, String(entry.dims));
  // Without a canary_vector only the exact legacy MiniLM shape may proceed (and adopt); any other partial
  // identity is refused, never adopted, and a legacy-shaped store naming another model is refused too.
  if (!stored.canary_vector) {
    const keys = Object.keys(stored).filter(k => stored[k] !== undefined);
    if (!keys.length) return;
    if (!isLegacyShape(stored)) {
      const legacyish = keys.sort().join() === LEGACY_KEYS.join();
      throw err('E_MODEL_CHANGED', legacyish
        ? `this store has the legacy identity of ${stored.embedding_model} (${stored.embedding_dim} dims), which belay adopts only for ${LEGACY_MODEL} at 384 dims`
        : `this store's identity is incomplete: it has ${keys.join(', ')} but no canary_vector, and it is not the legacy MiniLM shape, so it is not adopted`,
      { reason: legacyish ? 'legacy identity of another model' : 'incomplete identity', keys });
    }
  }
}

// Judge the freshly embedded canary against the store. Returns { adopted_canary, library_changed }.
function checkCanary(canary, stored, library) {
  const out = { adopted_canary: false, library_changed: null };
  if (!stored) return out;
  if (stored.canary_vector) {
    let old;
    try { old = JSON.parse(stored.canary_vector); } catch { old = null; }
    if (!Array.isArray(old) || old.length !== canary.length) {
      throw err('E_MODEL_CHANGED', `this store's recorded canary vector has ${Array.isArray(old) ? old.length : 'no readable'} dimensions and the embedder produced ${canary.length}`, { stored_dim: Array.isArray(old) ? old.length : null, dim: canary.length });
    }
    const cos = cosine(old, canary);
    if (!(cos >= COSINE_FLOOR)) {
      throw err('E_MODEL_CHANGED', `the canary vector now has cosine ${cos.toFixed(6)} to the one this store recorded, below ${COSINE_FLOOR}, so the model, dtype or dimension changed`, { cosine: cos, floor: COSINE_FLOOR });
    }
    if (stored.embedding_library && stored.embedding_library !== library) out.library_changed = { from: stored.embedding_library, to: library };
    return out;
  }
  // No canary_vector: checkIdentity has already refused everything but the legacy MiniLM shape, so this
  // store adopts the current vector (the model file is the same, ADR 0027 context item 2).
  if (Object.keys(stored).some(k => stored[k] !== undefined)) out.adopted_canary = true;
  return out;
}

// All identity keys, written by the owner in one transaction (first write, adoption).
function identityRows(info) {
  return [
    ['embedding_model', info.model], ['embedding_sha', info.sha], ['embedding_dtype', info.dtype],
    ['embedding_pooling', info.pooling], ['embedding_dim', String(info.dim)], ['embedding_library', info.library],
    ['canary_vector', JSON.stringify(info.canary_vector)], ['canary_sha256', info.canary_sha256],
  ];
}

// Write pairs into meta in ONE transaction: all of them or none. `db` is the store's sqlite handle.
function writeMeta(db, pairs) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const put = db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)');
    for (const [k, v] of pairs) put.run(k, v);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* nothing open */ }
    throw e;
  }
}

module.exports = { CANARY, COSINE_FLOOR, META_KEYS, cosine, legacyCanaryHash, chooseModel, checkIdentity, checkCanary, identityRows, writeMeta };
