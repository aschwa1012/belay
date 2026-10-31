'use strict';
// gpu-runtime.cjs — the pinned GPU runtime, installed on demand (ADR 0049 decision 2). belay does not list
// node-llama-cpp in its package.json: npm cannot skip a dependency's own optional packages, so every user and
// every CI run would receive its CUDA builds (about 545 of 711 MB). Instead this directory ships a manifest
// (gpu-runtime/package.json with exactly three direct dependencies, and its package-lock.json), and
// installRuntime() runs `npm ci --omit=optional --ignore-scripts` on a copy of it inside belay's cache, beside
// the model cache: <root>/gpu-runtime/llama-<node-llama-cpp version>-<lock hash>/.
//
// --ignore-scripts is safe and is used: node-llama-cpp's postinstall only prepares a source build and its
// docs, and the prebuilt Vulkan binary loads with `build: 'never'` without it (tested on this host with and
// without the script; npm 11 does not run it anyway until it is approved).
//
// The install goes into a temporary directory first, is verified there, and only then renamed into place:
//   - every direct dependency is installed at exactly the manifest's version;
//   - npm wrote its installed-package record (node_modules/.package-lock.json), and every entry in it is in the
//     shipped lockfile with the same version, resolved URL and integrity hash, and its package.json agrees;
//   - the lockfile was not rewritten, and no optional package of the lockfile (a CUDA build) was installed.
// The install then records every file (path, size, sha256) in runtime.json. Every use of the runtime compares the
// set of files and their sizes (a stat each); `belay embedder verify --gpu` and an install over an existing tree
// also compare the hashes. A removed, replaced or added file makes the runtime wrong.
// Any mismatch removes the temporary directory and refuses, E_MODEL_ABSENT with cause 'mismatch'; nothing is
// kept. A missing or wrong runtime is refused the same way by requireRuntime(), naming the installing command.
//
// This module requires only node built-ins and belay's small core modules. It never imports node-llama-cpp:
// only the GPU child (gpu-worker.cjs) does, and the child belongs to the store owner alone (invariant 9).
// Tests never run npm: installRuntime takes an `installer` seam.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { err } = require('./errors.cjs');
const K = require('./model-cache.cjs');
const { pidAlive } = require('./lock.cjs');
const { killPid } = require('./process.cjs');

const MANIFEST_DIR = path.join(__dirname, 'gpu-runtime').split('\\').join('/');
const INSTALL_COMMAND = 'belay embedder fetch --gpu';
const INSTALL_ARGS = ['ci', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund', '--no-update-notifier', '--loglevel=error'];
const INSTALL_BOUND_MS = 600000;
const RECORD = 'runtime.json';
const HIDDEN_LOCK = 'node_modules/.package-lock.json';
const NPM_ENV = ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'ProgramData', 'ProgramFiles',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE'];

const fwd = p => String(p).split('\\').join('/');
const rmrf = p => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ } };
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));

// The shipped manifest: its direct dependencies (all exact), the parsed lockfile, and a hash of the lockfile's
// text with line endings normalised (a Windows checkout may turn LF into CRLF).
function readManifest(dir = MANIFEST_DIR) {
  const pkg = readJson(path.join(dir, 'package.json'));
  const lockText = fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8');
  const deps = pkg.dependencies || {};
  const bad = Object.entries(deps).filter(([, v]) => !/^\d+\.\d+\.\d+$/.test(v)).map(([k]) => k);
  if (!Object.keys(deps).length || bad.length) throw err('E_ARGS', `the GPU runtime manifest must pin exact versions; unpinned: ${bad.join(', ') || 'no dependencies'}`, { dir });
  return {
    dir: fwd(dir), dependencies: deps, lock: JSON.parse(lockText),
    lock_sha256: crypto.createHash('sha256').update(lockText.replace(/\r\n/g, '\n')).digest('hex'),
    version: deps['node-llama-cpp'],
  };
}

// <root>/gpu-runtime beside the model cache: BELAY_GPU_RUNTIME names the base directly; else a named model
// cache (a test's) holds it inside itself; else it is the sibling of the default models directory.
function baseDir(env = process.env) {
  if (env.BELAY_GPU_RUNTIME) return fwd(path.resolve(env.BELAY_GPU_RUNTIME));
  if (env.BELAY_MODEL_CACHE) return fwd(path.join(path.resolve(env.BELAY_MODEL_CACHE), 'gpu-runtime'));
  return fwd(path.join(path.dirname(K.defaultCacheRoot(env)), 'gpu-runtime'));
}

function installDir(manifest, env = process.env) {
  return fwd(path.join(baseDir(env), `llama-${manifest.version}-${manifest.lock_sha256.slice(0, 12)}`));
}

function installedVersion(dir, name) {
  try { return readJson(path.join(dir, 'node_modules', ...name.split('/'), 'package.json')).version || null; } catch { return null; }
}

// Everything wrong with an installed tree, [] when sound. `deep` reads every installed package's own
// package.json; the light check (every use of the runtime) reads the three direct ones and the record.
function treeProblems(dir, manifest, { deep = false } = {}) {
  const bad = [];
  for (const [name, want] of Object.entries(manifest.dependencies)) {
    const got = installedVersion(dir, name);
    if (got === null) bad.push(`${name} is not installed`);
    else if (got !== want) bad.push(`${name} is ${got}, the manifest pins ${want}`);
  }
  let rec = null;
  try { rec = readJson(path.join(dir, RECORD)); } catch { /* absent */ }
  if (rec && rec.lock_sha256 !== manifest.lock_sha256) bad.push(`the install record names lockfile ${String(rec.lock_sha256).slice(0, 12)}, the manifest's is ${manifest.lock_sha256.slice(0, 12)}`);
  if (rec) bad.push(...fileProblems(dir, rec, deep)); // once installed, every file is held to the record: sizes and the file set always, hashes when deep
  if (!deep) return bad;
  let hidden = null;
  try { hidden = readJson(path.join(dir, HIDDEN_LOCK)).packages || null; } catch { /* absent */ }
  if (!hidden || !Object.keys(hidden).length) { bad.push(`npm left no installed-package record (${HIDDEN_LOCK})`); return bad; }
  const shipped = manifest.lock.packages || {};
  const direct = new Set(Object.keys(manifest.dependencies).map(n => `node_modules/${n}`));
  for (const [key, ent] of Object.entries(hidden)) {
    const want = shipped[key];
    if (!want) { bad.push(`${key} is installed and is not in the manifest's lockfile`); continue; }
    if (ent.version !== want.version || ent.integrity !== want.integrity || ent.resolved !== want.resolved) bad.push(`${key} differs from the lockfile (version ${ent.version} against ${want.version}, or another integrity or source)`);
    if (want.optional && !direct.has(key)) bad.push(`${key} is an optional package and must not be installed`);
    const real = installedVersion(dir, key.replace(/^node_modules\//, ''));
    if (real !== want.version) bad.push(`${key}: the files on disk are ${real === null ? 'absent' : real}, the lockfile says ${want.version}`);
  }
  try {
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8').replace(/\r\n/g, '\n')).digest('hex');
    if (sha !== manifest.lock_sha256) bad.push('the lockfile in the install was rewritten');
  } catch { bad.push('the install has no package-lock.json'); }
  return bad;
}


// ---- the file manifest (runtime.json `files`): what makes a replaced, removed or added file visible ----

// Every file and directory under `dir` except the record itself: { files: Map(rel -> size), dirs: Set(rel), odd: [rel] }.
function walkTree(dir) {
  const files = new Map(), dirs = new Set(), odd = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name, p = path.join(d, e.name);
      if (!rel && e.name === RECORD) continue;
      if (e.isDirectory()) { dirs.add(r); walk(p, r); } else if (e.isFile()) files.set(r, fs.statSync(p).size); else odd.push(r);
    }
  };
  walk(dir, '');
  return { files, dirs, odd };
}

const sha256File = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// The manifest written at install, after the tree verified: { "<rel path>": [size, sha256] } and the directory list.
function fileManifest(dir) {
  const t = walkTree(dir), files = {};
  for (const [rel, size] of [...t.files].sort(([a], [b]) => (a < b ? -1 : 1))) files[rel] = [size, sha256File(path.join(dir, rel))];
  return { files, dirs: [...t.dirs].sort() };
}

// What differs between the tree and its install record. The light check (every use of the runtime) compares the
// set of files and directories and every size, which a stat per file answers; the deep check also hashes every
// file. A quarantined llama.node or Vulkan DLL, a replaced dist file and an extra file or directory all show.
function fileProblems(dir, rec, deep) {
  if (!rec.files || !rec.dirs) return ['the install record has no file manifest'];
  const bad = [], t = walkTree(dir), want = rec.files;
  for (const o of t.odd) bad.push(`${o} is not a plain file or directory`);
  for (const rel of Object.keys(want)) {
    if (!t.files.has(rel)) bad.push(`${rel} is missing`);
    else if (t.files.get(rel) !== want[rel][0]) bad.push(`${rel} is ${t.files.get(rel)} bytes, the install recorded ${want[rel][0]}`);
    else if (deep && sha256File(path.join(dir, rel)) !== want[rel][1]) bad.push(`${rel} has changed (sha256 differs from the install record)`);
  }
  for (const rel of t.files.keys()) if (!(rel in want)) bad.push(`${rel} was added after the install`);
  const wantDirs = new Set(rec.dirs);
  for (const d of t.dirs) if (!wantDirs.has(d)) bad.push(`directory ${d} was added after the install`);
  for (const d of wantDirs) if (!t.dirs.has(d)) bad.push(`directory ${d} is missing`);
  return bad;
}

// { ok, dir, versions, problems, command }. Reads only; no process, no network.
function check({ env = process.env, manifestDir, deep = false } = {}) {
  const manifest = readManifest(manifestDir);
  const dir = installDir(manifest, env);
  const problems = fs.existsSync(path.join(dir, RECORD)) ? treeProblems(dir, manifest, { deep }) : [`the GPU runtime is not installed (${dir})`];
  const versions = Object.fromEntries(Object.keys(manifest.dependencies).map(n => [n, installedVersion(dir, n)]));
  return { ok: !problems.length, dir, versions, problems, command: INSTALL_COMMAND, manifest_version: manifest.version };
}

// The directory of a sound runtime, else E_MODEL_ABSENT naming the command that installs it.
function requireRuntime(opts = {}) {
  const c = check(opts);
  if (c.ok) return c.dir;
  const shown = `${c.problems.slice(0, 5).join('; ')}${c.problems.length > 5 ? ` (and ${c.problems.length - 5} more)` : ''}`;
  throw err('E_MODEL_ABSENT', `the GPU runtime is missing or wrong (${shown}); install it with \`${INSTALL_COMMAND}\``, { gpu: true, cause: 'absent', command: INSTALL_COMMAND, dir: c.dir, problems: c.problems.slice(0, 50) });
}

// ---- the install lock (a stale one is taken over by an atomic rename, never by a delete) ----

const readText = (p) => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return null; } };

// An exclusive lock file holding our pid. A lock whose holder is dead is stolen by RENAMING it to a name only we
// know, then reading what we moved: if it is the dead holder's, it is ours to delete; if another installer took
// the lock in between, we moved a live lock, so it is linked back and the steal fails. The deleting of a lock is
// never a path-name delete of whatever sits at the path. `seam.beforeSteal(deadText)` runs between the judgement
// and the rename, and a test uses it to force the interleaving. Residual: if a third installer creates the lock in
// the instant between our move and our link-back, two installers can hold it; the holder's release still deletes
// only a lock that names its own pid.
function takeLock(lock, { pid = process.pid, seam = {} } = {}) {
  for (let i = 0; i < 4; i += 1) {
    try { fs.writeFileSync(lock, String(pid), { flag: 'wx' }); return true; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const text = readText(lock), holder = Number(text);
      if (!Number.isInteger(holder) || holder <= 0 || pidAlive(holder)) return false; // held, or empty: its holder is between create and write
      if (seam.beforeSteal) seam.beforeSteal(text);
      const moved = `${lock}.stale-${pid}-${crypto.randomBytes(4).toString('hex')}`;
      try { renameInto(lock, moved, seam.rename); } catch (r) { if (r.code === 'ENOENT') continue; throw r; } // ENOENT: another installer stole it first; EPERM or EBUSY: retried, then a coded E_BUSY
      if (readText(moved) === text) { rmrf(moved); continue; } // the dead holder's, and now gone: take it with a fresh exclusive create
      try { fs.linkSync(moved, lock); } catch { /* a third installer holds the path now */ }
      rmrf(moved);
      return false;
    }
  }
  return false;
}

// Releases the lock only if it still names `pid`.
function releaseLock(lock, pid = process.pid) {
  if (readText(lock) === String(pid)) rmrf(lock);
}

// Leftovers of an interrupted install: `.tmp-*` and `.old-*` directories whose NAMED pid is dead. The pid is the
// last-but-one number in the name (`.tmp-<target>-<pid>-<ms>`, `.old-<pid>-<ms>`), so a live installer's tree is
// never swept by another.
function sweepLeftovers(base) {
  const swept = [];
  for (const n of fs.readdirSync(base)) {
    const m = /^\.(?:tmp|old)-(?:.*-)?(\d+)-\d+$/.exec(n);
    if (m && !pidAlive(Number(m[1]))) { rmrf(path.join(base, n)); swept.push(n); }
  }
  return swept;
}

// ---- running npm ----

// The npm that ships beside this node, run through node itself (a .cmd cannot be spawned without a shell).
function npmCli(env = process.env) {
  const beside = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  for (const p of [beside, env.npm_execpath]) if (p && /npm-cli\.js$/.test(p) && fs.existsSync(p)) return p;
  return null;
}

// What npm sees: the allow-list, plus the npm_config_ settings that name a proxy or a CA file (a network that needs
// them needs them for this install too). The registry is NOT passed: the lockfile's `resolved` URLs decide where
// packages come from. Nothing else, so npm_config_include=optional cannot pull the CUDA packages back in.
const NPM_CONFIG_KEPT = new Set(['npm_config_proxy', 'npm_config_https_proxy', 'npm_config_http_proxy', 'npm_config_noproxy', 'npm_config_cafile']);
function npmEnv(env = process.env) {
  const e = {};
  for (const k of NPM_ENV) if (env[k] !== undefined) e[k] = env[k];
  for (const k of Object.keys(env)) if (NPM_CONFIG_KEPT.has(k.toLowerCase())) e[k] = env[k];
  return e;
}

// The default installer: `npm ci` in `dir`, under a bound, killed by its exact child handle. Resolves
// { code, ms, tail }; rejects only when npm cannot be started.
function defaultInstaller(dir, { env = process.env, boundMs = INSTALL_BOUND_MS } = {}) {
  const cli = npmCli(env);
  if (!cli) return Promise.reject(err('E_MODEL_ABSENT', 'npm was not found beside node; install Node.js with npm to install the GPU runtime', { gpu: true, cause: 'absent' }));
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    let out = '';
    const c = spawn(process.execPath, [cli, ...INSTALL_ARGS], { cwd: dir, env: npmEnv(env), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const take = d => { out = (out + d).slice(-4000); };
    c.stdout.on('data', take); c.stderr.on('data', take);
    const timer = setTimeout(() => { killPid(c); out += `\nnpm ci did not finish within ${boundMs} ms and was stopped`; }, boundMs);
    c.on('error', (x) => { clearTimeout(timer); reject(err('E_MODEL_ABSENT', `npm could not be started: ${x.message}`, { gpu: true, cause: 'absent' })); });
    c.on('exit', (code, signal) => { clearTimeout(timer); const drop = setTimeout(() => { try { c.stdout.destroy(); c.stderr.destroy(); } catch { /* closed */ } }, 2000); drop.unref(); c.once('close', () => clearTimeout(drop)); resolve({ code: code === null ? -1 : code, signal, ms: Date.now() - t0, tail: out.trim() }); });
  });
}

// A rename onto a directory whose files a live GPU child has loaded (its DLLs) fails with EPERM or EBUSY. After a
// few tries that is a coded E_BUSY naming the directory, never a raw errno. `rename` is a test seam.
function renameInto(from, to, rename = fs.renameSync) {
  for (let i = 0; ; i += 1) {
    try { rename(from, to); return; } catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      if (i >= 4) throw err('E_BUSY', `${fwd(to)} is in use (${e.code}); a GPU process may hold its files. Stop the run that owns it and try again`, { gpu: true, dir: fwd(to), errno: e.code });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); // a scanner may hold a fresh tree for a moment
    }
  }
}

// Installs the runtime, or reports it already sound. Resolves the receipt { dir, already_present, versions,
// bytes, mb, npm_ms, total_ms }. `installer(dir, { env })` resolves { code, ms, tail } after filling dir/node_modules.
// Seams: `rename`, and `lockSeam` (takeLock's).
async function installRuntime({ env = process.env, manifestDir, installer = defaultInstaller, emit, rename, lockSeam } = {}) {
  const t0 = Date.now();
  const manifest = readManifest(manifestDir);
  const target = installDir(manifest, env);
  const sound = check({ env, manifestDir, deep: true });
  if (sound.ok) return { dir: target, already_present: true, versions: sound.versions, bytes: 0, mb: 0, npm_ms: 0, total_ms: Date.now() - t0 };
  const base = path.dirname(target);
  fs.mkdirSync(base, { recursive: true });
  const lock = path.join(base, '.install.lock');
  if (!takeLock(lock, { seam: lockSeam })) throw err('E_BUSY', `another GPU runtime install holds ${fwd(lock)}; nothing was touched`, { gpu: true, lock: fwd(lock) });
  const tmp = path.join(base, `.tmp-${path.basename(target)}-${process.pid}-${Date.now()}`);
  try {
    sweepLeftovers(base);
    fs.mkdirSync(tmp, { recursive: true });
    for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(manifest.dir, f), path.join(tmp, f));
    if (emit) emit(`  npm ci --omit=optional --ignore-scripts in ${fwd(tmp)}\n`);
    const r = await installer(tmp, { env });
    if (!r || r.code !== 0) throw err('E_MODEL_ABSENT', `npm ci failed${r && r.code !== undefined ? ` with exit code ${r.code}` : ''}; nothing was kept${r && r.tail ? `: ${r.tail.split('\n').slice(-3).join(' | ')}` : ''}`, { gpu: true, cause: 'mismatch', npm_code: r && r.code });
    const problems = treeProblems(tmp, manifest, { deep: true });
    if (problems.length) throw err('E_MODEL_ABSENT', `the installed GPU runtime does not match the manifest and was refused: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? ` (and ${problems.length - 5} more)` : ''}`, { gpu: true, cause: 'mismatch', problems });
    const versions = Object.fromEntries(Object.keys(manifest.dependencies).map(n => [n, installedVersion(tmp, n)]));
    const fm = fileManifest(tmp);
    const bytes = Object.values(fm.files).reduce((n, f) => n + f[0], 0);
    fs.writeFileSync(path.join(tmp, RECORD), `${JSON.stringify({ runtime: 'node-llama-cpp', versions, lock_sha256: manifest.lock_sha256, omit_optional: true, ignore_scripts: true, bytes, installed_at: new Date().toISOString(), ...fm }, null, 1)}\n`);
    if (fs.existsSync(target)) { const old = path.join(base, `.old-${process.pid}-${Date.now()}`); renameInto(target, old, rename); rmrf(old); } // an incomplete or wrong earlier tree is not a runtime
    renameInto(tmp, target, rename);
    return { dir: target, already_present: false, versions, bytes, mb: Math.round(bytes / 1048576), files: Object.keys(fm.files).length, npm_ms: r.ms, total_ms: Date.now() - t0 };
  } finally { rmrf(tmp); releaseLock(lock); }
}

module.exports = { MANIFEST_DIR, INSTALL_COMMAND, INSTALL_ARGS, readManifest, baseDir, installDir, treeProblems, check, requireRuntime, installRuntime, defaultInstaller, npmCli, npmEnv, takeLock, releaseLock, sweepLeftovers, fileManifest };
