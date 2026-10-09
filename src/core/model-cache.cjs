'use strict';
// model-cache.cjs — where fetched embedding models live, and whether one is present (ADR 0027
// decision 4). Stat only: no hashing, no network, and no `require` of the embedding library, so
// `belay doctor` and the embedder can both use it inside the read-command budget. It requires only node
// built-ins and models.cjs.
//
// Layout: <root>/<id>@<sha>/ holds the model's files at their repository paths, plus manifest.json,
// which `belay embedder fetch` writes last. A directory without a manifest is not a model.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PKG_VERSION } = require('./models.cjs');

const MANIFEST = 'manifest.json';

const fwd = p => String(p).split('\\').join('/');

// The cache root the platform names, ignoring BELAY_MODEL_CACHE: the real place `belay embedder fetch`
// fills. Files that need the model opt back in to it when a test phase points the variable elsewhere.
function defaultCacheRoot(env = process.env) {
  if (process.platform === 'win32') {
    const base = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return fwd(path.join(base, 'belay', 'models'));
  }
  const base = env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return fwd(path.join(base, 'belay', 'models'));
}

function cacheRoot(env = process.env) {
  if (env.BELAY_MODEL_CACHE) return fwd(path.resolve(env.BELAY_MODEL_CACHE));
  return defaultCacheRoot(env);
}

function dirName(entry) { return `${entry.id}@${entry.sha}`; }

function modelDir(entry, root = cacheRoot()) {
  return fwd(path.join(root, dirName(entry)));
}

function statSize(p) {
  try { const s = fs.statSync(p); return s.isFile() ? s.size : null; } catch { return null; }
}

// { present, dir, missing: [paths], wrong_size: [paths], manifest_sha }. `present` needs every file at
// the table's byte size and a manifest that names the table's sha.
function checkPresent(entry, root = cacheRoot()) {
  const dir = modelDir(entry, root);
  const missing = [], wrong = [];
  for (const f of entry.files) {
    const size = statSize(path.join(dir, f.path));
    if (size === null) missing.push(f.path);
    else if (size !== f.bytes) wrong.push(f.path);
  }
  let manifestSha = null;
  try { manifestSha = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8')).sha || null; } catch { /* absent or unreadable */ }
  if (manifestSha === null) missing.push(MANIFEST);
  else if (manifestSha !== entry.sha) wrong.push(MANIFEST);
  return { present: !missing.length && !wrong.length, dir, missing, wrong_size: wrong, manifest_sha: manifestSha };
}

// The embedding package, found without loading it: BELAY_TRANSFORMERS_PKG (or `override`), else belay's
// own node_modules only (the repository root, two levels above src/core). No ancestor directory, home
// directory or global prefix is searched: an install that failed here must not be papered over by
// whatever version lives elsewhere (ADR 0027 decision 1). The package's exports map hides package.json
// from require.resolve, so this stats and reads it. Returns { dir, version } or null.
const PKG_NAME = '@huggingface/transformers';
function packageInfo(override, env = process.env) {
  const given = override || env.BELAY_TRANSFORMERS_PKG;
  const dir = given ? path.resolve(given) : path.join(__dirname, '..', '..', 'node_modules', PKG_NAME);
  try {
    const version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version || null;
    return { dir: fwd(dir), version };
  } catch { return null; }
}

// The directory of a package that is present AND at the pinned version, else null.
function packageDir(override, env = process.env) {
  const p = packageInfo(override, env);
  return p && p.version === PKG_VERSION ? p.dir : null;
}

module.exports = { cacheRoot, defaultCacheRoot, modelDir, dirName, checkPresent, packageDir, packageInfo, MANIFEST, PKG_NAME, PKG_VERSION };
