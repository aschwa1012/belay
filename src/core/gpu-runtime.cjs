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

function sizeOf(dir) {
  let n = 0;
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) n += fs.statSync(p).size; } };
  walk(dir);
  return n;
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
  throw err('E_MODEL_ABSENT', `the GPU runtime is missing or wrong (${c.problems.join('; ')}); install it with \`${INSTALL_COMMAND}\``, { gpu: true, cause: 'absent', command: INSTALL_COMMAND, dir: c.dir, problems: c.problems });
}

// An exclusive lock file holding our pid; a lock whose pid is dead is stolen.
function takeLock(lock) {
  for (let i = 0; i < 3; i += 1) {
    try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); return true; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let text = '';
      try { text = fs.readFileSync(lock, 'utf8').trim(); } catch { continue; }
      const pid = Number(text);
      if (!Number.isInteger(pid) || pid <= 0 || pidAlive(pid)) return false; // held, or empty: its holder is between create and write
      let again = null;
      try { again = fs.readFileSync(lock, 'utf8').trim(); } catch { continue; }
      if (again === text) rmrf(lock); // still the dead holder's: another install may have stolen it first
    }
  }
  return false;
}

// The npm that ships beside this node, run through node itself (a .cmd cannot be spawned without a shell).
function npmCli(env = process.env) {
  const beside = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  for (const p of [beside, env.npm_execpath]) if (p && /npm-cli\.js$/.test(p) && fs.existsSync(p)) return p;
  return null;
}

// The default installer: `npm ci` in `dir`, under a bound, killed by its exact child handle. Resolves
// { code, ms, tail }; rejects only when npm cannot be started.
function defaultInstaller(dir, { env = process.env, boundMs = INSTALL_BOUND_MS } = {}) {
  const cli = npmCli(env);
  if (!cli) return Promise.reject(err('E_MODEL_ABSENT', 'npm was not found beside node; install Node.js with npm to install the GPU runtime', { gpu: true, cause: 'absent' }));
  const e = {};
  for (const k of NPM_ENV) if (env[k] !== undefined) e[k] = env[k];
  for (const k of Object.keys(env)) if (k.startsWith('npm_config_')) e[k] = env[k];
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    let out = '';
    const c = spawn(process.execPath, [cli, ...INSTALL_ARGS], { cwd: dir, env: e, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const take = d => { out = (out + d).slice(-4000); };
    c.stdout.on('data', take); c.stderr.on('data', take);
    const timer = setTimeout(() => { killPid(c); out += `\nnpm ci did not finish within ${boundMs} ms and was stopped`; }, boundMs);
    c.on('error', (x) => { clearTimeout(timer); reject(err('E_MODEL_ABSENT', `npm could not be started: ${x.message}`, { gpu: true, cause: 'absent' })); });
    c.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code: code === null ? -1 : code, signal, ms: Date.now() - t0, tail: out.trim() }); });
  });
}

function renameInto(from, to) {
  for (let i = 0; ; i += 1) {
    try { fs.renameSync(from, to); return; } catch (e) {
      if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); // a scanner may hold a fresh tree for a moment
    }
  }
}

// Installs the runtime, or reports it already sound. Resolves the receipt { dir, already_present, versions,
// bytes, mb, npm_ms, total_ms }. `installer(dir, { env })` resolves { code, ms, tail } after filling dir/node_modules.
async function installRuntime({ env = process.env, manifestDir, installer = defaultInstaller, emit } = {}) {
  const t0 = Date.now();
  const manifest = readManifest(manifestDir);
  const target = installDir(manifest, env);
  const sound = check({ env, manifestDir, deep: true });
  if (sound.ok) return { dir: target, already_present: true, versions: sound.versions, bytes: 0, mb: 0, npm_ms: 0, total_ms: Date.now() - t0 };
  const base = path.dirname(target);
  fs.mkdirSync(base, { recursive: true });
  const lock = path.join(base, '.install.lock');
  if (!takeLock(lock)) throw err('E_BUSY', `another GPU runtime install holds ${fwd(lock)}; nothing was touched`, { gpu: true, lock: fwd(lock) });
  const tmp = path.join(base, `.tmp-${path.basename(target)}-${process.pid}-${Date.now()}`);
  try {
    for (const n of fs.readdirSync(base)) if (n.startsWith('.tmp-') || n.startsWith('.old-')) rmrf(path.join(base, n)); // an interrupted install's leftovers
    fs.mkdirSync(tmp, { recursive: true });
    for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(manifest.dir, f), path.join(tmp, f));
    if (emit) emit(`  npm ci --omit=optional --ignore-scripts in ${fwd(tmp)}\n`);
    const r = await installer(tmp, { env });
    if (!r || r.code !== 0) throw err('E_MODEL_ABSENT', `npm ci failed${r && r.code !== undefined ? ` with exit code ${r.code}` : ''}; nothing was kept${r && r.tail ? `: ${r.tail.split('\n').slice(-3).join(' | ')}` : ''}`, { gpu: true, cause: 'mismatch', npm_code: r && r.code });
    const problems = treeProblems(tmp, manifest, { deep: true });
    if (problems.length) throw err('E_MODEL_ABSENT', `the installed GPU runtime does not match the manifest and was refused: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? ` (and ${problems.length - 5} more)` : ''}`, { gpu: true, cause: 'mismatch', problems });
    const versions = Object.fromEntries(Object.keys(manifest.dependencies).map(n => [n, installedVersion(tmp, n)]));
    const bytes = sizeOf(tmp);
    fs.writeFileSync(path.join(tmp, RECORD), `${JSON.stringify({ runtime: 'node-llama-cpp', versions, lock_sha256: manifest.lock_sha256, omit_optional: true, ignore_scripts: true, bytes, installed_at: new Date().toISOString() }, null, 2)}\n`);
    if (fs.existsSync(target)) { const old = path.join(base, `.old-${process.pid}-${Date.now()}`); renameInto(target, old); rmrf(old); } // an incomplete or wrong earlier tree is not a runtime
    renameInto(tmp, target);
    return { dir: target, already_present: false, versions, bytes, mb: Math.round(bytes / 1048576), npm_ms: r.ms, total_ms: Date.now() - t0 };
  } finally { rmrf(tmp); rmrf(lock); }
}

module.exports = { MANIFEST_DIR, INSTALL_COMMAND, INSTALL_ARGS, readManifest, baseDir, installDir, treeProblems, check, requireRuntime, installRuntime, defaultInstaller, npmCli };
