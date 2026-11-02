'use strict';
// check-env.cjs — the environment a check ran in, recorded as facts (ADR 0080 decision 1). A check is keyed on what git can see; this
// adds what git cannot: which binary the command named, the owner's node and OS, the node_modules in use, PATH and the temp drive,
// and the environment variables belay and its hosts set. Each input gets its own digest, salted per store, so a later record can name
// which input changed without showing a value; `env_fp` is the digest of the digests. This only records: nothing here refuses a
// check, changes its key, or decides reuse. A credential-named variable is listed by name and never hashed. The ADR's check_flake
// columns (last_env_fp, env_changes) are not built: that table does not exist in this release.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TRACKED = /^(BELAY_|FAKE_|CLAUDE_|CODEX_|NODE_|npm_config_|MCP_)/i;
const SECRET = /TOKEN|KEY|SECRET|OAUTH|PASS|AUTH|COOKIE|CREDENTIAL|SESSION|PRIVATE|CERT/i; // a match is listed by name; its value is not hashed at all
const VERSION_MS = 2000;
const CAPTURE_MS = 3000; // the whole capture is bounded; past it the record is left out and the check runs
const HAS_EXT = new RegExp(['[.][^', String.fromCharCode(92, 92), '/.]*$'].join('')); // a final extension
const SEP = new RegExp(['[', String.fromCharCode(92, 92), '/]'].join(''));
const versions = new Map(); // resolved binary -> its --version line, once per owner process (a binary replaced under a running owner is not re-read)

const digest = (salt, name, value) => crypto.createHash('sha256').update(`${salt}\0${name}\0${value}`).digest('hex').slice(0, 16);

// The store's salt for these digests: random, made on first use, so fingerprints compare only within one store. Written in a
// transaction of its own; callers hold none.
function saltOf(store) {
  const get = () => store.db.prepare("SELECT value FROM meta WHERE key = 'env_salt'").get();
  const have = get();
  if (have && have.value) return have.value;
  return store.tx(() => {
    const again = get();
    if (again && again.value) return again.value;
    const v = crypto.randomBytes(16).toString('hex');
    store.db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('env_salt', v);
    return v;
  });
}

const stat = (f) => fs.promises.stat(f).then((st) => (st.isFile() ? st : null), () => null);

// The file a spawn of `name` runs, the way the spawn resolves it, read without blocking the owner's thread. On Windows libuv looks in
// the cwd and then each PATH entry, trying the name as written only when it already has an extension, then `.com`, then `.exe` (not
// PATHEXT); elsewhere execvp looks in PATH only, and a name with a separator is taken relative to the cwd. A bare `git` is the answer
// evaluate.cjs's runCommand already gave it. -> { file, st } or null.
async function resolveBinary(name, cwd, env = process.env, platform = process.platform) {
  const win = platform === 'win32';
  const tries = (base) => (win ? (HAS_EXT.test(base) ? [base, `${base}.com`, `${base}.exe`] : [`${base}.com`, `${base}.exe`]) : [base]);
  const hit = async (dir) => { for (const f of tries(path.resolve(dir, name))) { const st = await stat(f); if (st) return { file: f, st }; } return null; };
  if (SEP.test(name)) return hit(cwd || process.cwd());
  if (name === 'git') { const g = require('./git-safe.cjs').gitPath(); const st = await stat(g); return st ? { file: g, st } : null; }
  if (win) { const f = await hit(cwd || process.cwd()); if (f) return f; }
  for (const d of String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) { const f = await hit(d); if (f) return f; }
  return null;
}

// A version is asked only of the two binaries belay itself chose: the owner's own node, and the git belay runs (`gitPath()`). Any other
// binary is a file a worker may have placed, and running it here would be worker code outside the judged checks and outside the spawn
// register; for those the record holds the resolved path, size and mtime and runs nothing.
async function versionOf(bin) {
  if (path.resolve(bin) === path.resolve(process.execPath)) return process.version;
  if (path.resolve(bin) !== path.resolve(require('./git-safe.cjs').gitPath())) return null;
  if (versions.has(bin)) return versions.get(bin);
  const r = await require('./evaluate.cjs').runCommand([bin, '--version'], path.dirname(bin), VERSION_MS);
  const v = r.executable && r.exit_code === 0 ? String(r.stdout).split(String.fromCharCode(10))[0].trim().slice(0, 80) || null : null;
  versions.set(bin, v);
  return v;
}

const real = (f) => fs.promises.realpath(f).catch(() => null);
const fileDigest = (f) => fs.promises.readFile(f).then((b) => crypto.createHash('sha256').update(b).digest('hex'), () => null);
const driveOf = (p) => (p ? path.parse(p).root || null : null);

// `commands`: [{ argv, cwd }]; the inputs are those of every command named. `previous`: an earlier record of the same task or check,
// to name the inputs that changed since. Returns { env_fp, facts, inputs, changed? }; `inputs` are the salted per-input digests.
async function capture(commands, { salt, previous = null, env = process.env } = {}) {
  const inputs = {};
  const facts = { node: process.version, arch: process.arch, os: os.release() };
  const put = (name, value) => { inputs[name] = digest(salt, name, value == null ? '' : String(value)); };
  const bins = {};
  for (const c of commands) {
    if (!c || !Array.isArray(c.argv) || !c.argv.length || typeof c.argv[0] !== 'string') continue;
    const { resolveWindowsShim } = require('./evaluate.cjs');
    const argv = resolveWindowsShim(c.argv);
    const hit = await resolveBinary(argv[0], c.cwd, env), bin = hit && hit.file;
    put(`bin:${c.argv[0]}`, bin);
    put(`bin_file:${c.argv[0]}`, hit ? `${hit.st.size}:${Math.floor(hit.st.mtimeMs)}` : null);
    const base = path.basename(argv[0]).toLowerCase().replace(/\.(exe|cmd|com)$/, '');
    if (bin && (base === 'node' || base === 'git') && bins[base] === undefined) bins[base] = await versionOf(bin);
  }
  for (const [n, v] of Object.entries(bins)) { if (v) facts[`${n}_version`] = v; put(`version:${n}`, v); }
  put('node_version', process.version); put('node_arch', process.arch); put('os_release', os.release());
  const cwd = (commands.find((c) => c && c.cwd) || {}).cwd || process.cwd();
  const modules = await real(path.join(cwd, 'node_modules'));
  put('node_modules', modules);
  put('node_modules_lock', await fileDigest(path.join(cwd, 'node_modules', '.package-lock.json')));
  if (modules) facts.node_modules = modules;
  put('PATH', env.PATH || env.Path);
  for (const k of ['TEMP', 'TMP']) {
    const r = env[k] ? (await real(env[k])) || env[k] : null;
    put(k, r); if (k === 'TEMP' && r) facts.temp_drive = driveOf(r);
  }
  put('USERPROFILE', env.USERPROFILE);
  const withheld = [];
  for (const k of Object.keys(env).sort()) {
    if (!TRACKED.test(k)) continue;
    if (SECRET.test(k)) withheld.push(k); else put(`env:${k}`, env[k]);
  }
  if (withheld.length) facts.withheld = withheld; // named only: a credential does not change a check's outcome, and kept stores travel
  const names = Object.keys(inputs).sort();
  const env_fp = crypto.createHash('sha256').update(names.map((n) => `${n}=${inputs[n]}`).join('\n')).digest('hex').slice(0, 16);
  const out = { env_fp, facts, inputs };
  if (previous && previous.inputs) {
    const was = previous.inputs;
    out.changed = [...new Set([...names, ...Object.keys(was)])].sort().filter((n) => was[n] !== inputs[n]);
  }
  return out;
}

// The record for commands, null when there are none or the facts cannot be read (a fact that cannot be read is left out, and the
// check stands). `previous` is the same task's earlier record, to name the inputs that changed.
async function forCommands(store, commands, previous = null) {
  if (!commands.length) return null;
  try {
    let timer;
    const r = await Promise.race([capture(commands, { salt: saltOf(store), previous }), new Promise((done) => { timer = setTimeout(() => done(null), CAPTURE_MS); })]).finally(() => clearTimeout(timer));
    if (!r) return null;
    return { env_fp: r.env_fp, facts: r.facts, inputs: r.inputs, ...(r.changed ? { changed: r.changed } : {}) };
  } catch { return null; }
}

// A task's command checks, against its previous evaluation.
function forTask(store, task, worktree) {
  const list = task.acceptance && Array.isArray(task.acceptance.commands) ? task.acceptance.commands.filter((c) => c && Array.isArray(c.argv)) : [];
  return forCommands(store, list.map((c) => ({ argv: c.argv, cwd: c.cwd ? path.resolve(worktree, c.cwd) : worktree })), task.results && task.results.env);
}

// An executed integration check keeps the fingerprint and the facts, not the digests (they are one call's, not a history).
const brief = (r) => (r ? { env_fp: r.env_fp, env_facts: r.facts } : {});

module.exports = { capture, forTask, forCommands, brief, saltOf, resolveBinary, SECRET, TRACKED };
