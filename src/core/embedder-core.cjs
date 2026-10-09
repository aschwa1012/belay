'use strict';
// embedder-core.cjs — the pipeline itself: package import, model load, canary, embed, token count. It
// runs inside the worker thread embed-worker.cjs (L1, ADR 0027 amendment via review 1), never on the
// owner's event loop, and never on a read path: like embedder.cjs it is required only by the owner's
// lazy embedder load. `preflight` (stat-only package and cache checks) is also called from the owner's
// thread so an absent package or model is answered without starting a thread.

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { err } = require('./errors.cjs');
const { modelFor, DEFAULT_MODEL, PKG_VERSION } = require('./models.cjs');
const K = require('./model-cache.cjs');
const I = require('./embed-identity.cjs');

const { CANARY } = I;

// Truncate to the first `dims` values and L2-normalise (Matryoshka truncation, ADR 0027 decision 2).
function truncateUnit(raw, dims) {
  const v = new Float32Array(dims);
  let n = 0;
  for (let i = 0; i < dims; i++) { v[i] = raw[i]; n += v[i] * v[i]; }
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < dims; i++) v[i] /= n;
  return v;
}

// Throws E_MODEL_ABSENT for an uninstalled or wrong-version package and for a model not in the cache;
// otherwise returns { pkgDir, dir }.
function preflight(entry, pkg, cacheDir) {
  const info = K.packageInfo(pkg);
  const where = pkg || process.env.BELAY_TRANSFORMERS_PKG;
  if (!info) {
    throw err('E_MODEL_ABSENT', where
      ? `the transformers package is not loadable at ${where}: it has no readable package.json there`
      : `the transformers package ${K.PKG_NAME} is not installed in belay's node_modules; run npm install in the belay directory`, { pkg: where || null });
  }
  if (info.version !== PKG_VERSION) {
    throw err('E_MODEL_ABSENT', `the transformers package at ${info.dir} is version ${info.version} and belay pins ${PKG_VERSION}; run npm install in the belay directory`, { pkg: info.dir, found: info.version, pinned: PKG_VERSION });
  }
  const chk = K.checkPresent(entry, cacheDir);
  if (!chk.present) {
    const paths = [...chk.missing, ...chk.wrong_size.map(p => `${p} (wrong size)`)];
    throw err('E_MODEL_ABSENT', `the model ${entry.id} is not in belay's model cache at ${chk.dir}; missing: ${paths.join(', ')}; run belay embedder fetch --model ${entry.id}`, { model: entry.id, dir: chk.dir, missing: chk.missing, wrong_size: chk.wrong_size });
  }
  return { pkgDir: info.dir, dir: chk.dir };
}

class EmbedderCore {
  constructor(opts = {}) {
    this.entry = modelFor(opts.model || DEFAULT_MODEL);
    this.pkg = opts.pkg || null;
    this.cacheDir = opts.cacheDir || K.cacheRoot();
    this.dim = this.entry.dims;
    this.pipe = null; this.library = null;
  }

  async load(stored) {
    const t0 = Date.now();
    const e = this.entry;
    I.checkIdentity(e, stored);
    const { pkgDir, dir } = preflight(e, this.pkg, this.cacheDir);
    let tf;
    try { tf = await import(pathToFileURL(path.join(pkgDir, 'src/transformers.js')).href); }
    catch (x) { throw err('E_MODEL_ABSENT', `the transformers package is not loadable at ${pkgDir}: ${x.message}`, { pkg: pkgDir }); }
    tf.env.allowRemoteModels = false; tf.env.allowLocalModels = true; tf.env.useFSCache = false;
    this.library = tf.env.version;
    try { this.pipe = await tf.pipeline('feature-extraction', dir, { dtype: e.dtype, device: 'cpu' }); }
    catch (x) { throw err('E_MODEL_ABSENT', `the model ${e.id} did not load from ${dir}: ${x.message}`, { model: e.id, dir }); }

    const canary = await this._vector(CANARY, 'document');
    const verdict = I.checkCanary(canary, stored, this.library);
    return {
      model: e.id, sha: e.sha, dtype: e.dtype, pooling: e.pooling, dim: e.dims, revision: e.sha,
      library: this.library, canary_vector: Array.from(canary), canary_sha256: I.legacyCanaryHash(canary),
      load_ms: Date.now() - t0, adopted_canary: verdict.adopted_canary, library_changed: verdict.library_changed,
    };
  }

  tokenCount(text) {
    const enc = this.pipe.tokenizer(text);
    const ids = enc.input_ids;
    return ids.dims ? ids.dims[ids.dims.length - 1] : (ids.data ? ids.data.length : ids.length);
  }

  prompted(text, as) {
    if (as !== 'document' && as !== 'query') throw err('E_ARGS', `embed: as must be 'document' or 'query', not ${JSON.stringify(as)}`, { as });
    return (as === 'query' ? this.entry.query_prompt : this.entry.document_prompt) + text;
  }

  async _vector(text, as) {
    const r = await this.pipe(this.prompted(text, as), { pooling: this.entry.pooling, normalize: false });
    return truncateUnit(r.data, this.dim);
  }

  async embed(text, as) {
    const full = this.prompted(text, as);
    const n = this.tokenCount(full);
    const max = this.entry.max_tokens;
    if (n > max) {
      throw err('E_TOO_LONG', `the text is ${n} tokens with its prompt and the model window is ${max}; chunk it or shorten it, because the store will not embed a truncated prefix`, { tokens: n, max });
    }
    const v = await this._vector(text, as);
    return { embedding: Array.from(v), embedding_model: this.entry.id, embedding_revision: this.entry.sha, dim: this.dim, tokens: n };
  }
}

module.exports = { EmbedderCore, preflight, truncateUnit };
