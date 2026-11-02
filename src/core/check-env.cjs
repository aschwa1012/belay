'use strict';
// check-env.cjs — the environment a check ran in, recorded as facts (ADR 0080 decision 1). A check is keyed on what git can see; this
// adds what git cannot: which binary the command named, the owner's node and OS, the node_modules in use, PATH and the temp drive,
// and the environment variables belay and its hosts set. Each input gets its own digest, salted per store, so a later record can name
// which input changed without showing a value; `env_fp` is the digest of the digests. This only records: nothing here refuses a
// check, changes its key, or decides reuse. A credential-named variable is listed by name and never hashed.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TRACKED = /^(BELAY_|FAKE_|CLAUDE_|CODEX_|NODE_|npm_config_|MCP_)/i;
const SECRET = /TOKEN|KEY|SECRET|OAUTH|PASSWORD|AUTH/i;
const VERSION_MS = 5000;
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

const isFile = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };

// The file a spawn of `name` runs, the way the spawn resolves it. On Windows libuv looks in the cwd and then each PATH entry, trying
// the name as written, then `.com`, then `.exe` (not PATHEXT); elsewhere execvp looks in PATH only, and a name with a separator is
// taken relative to the cwd. A bare `git` is the answer evaluate.cjs's runCommand already gave it.
function resolveBinary(name, cwd, env = process.env, platform = process.platform) {
  const win = platform === 'win32';
  const tries = (base) => (win ? [base, `${base}.com`, `${base}.exe`] : [base]);
  const hit = (dir) => { for (const f of tries(path.resolve(dir, name))) if (isFile(f)) return f; return null; };
  if (/[\\/]/.test(name)) return hit(cwd || process.cwd());
  if (name === 'git') { const g = require('./git-safe.cjs').gitPath(); return isFile(g) ? g : null; }
  if (win) { const f = hit(cwd || process.cwd()); if (f) return f; }
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) { const f = hit(d); if (f) return f; }
  return null;
}

async function versionOf(bin) {
  if (path.resolve(bin) === path.resolve(process.execPath)) return process.version;
  if (versions.has(bin)) return versions.get(bin);
  const r = await require('./evaluate.cjs').runCommand([bin, '--version'], path.dirname(bin), VERSION_MS);
  const v = r.executable && r.exit_code === 0 ? String(r.stdout).split('\n')[0].trim().slice(0, 80) || null : null;
  versions.set(bin, v);
  return v;
}

const real = (f) => { try { return fs.realpathSync(f); } catch { return null; } };
const fileDigest = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return null; } };
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
    const bin = resolveBinary(argv[0], c.cwd, env);
    put(`bin:${c.argv[0]}`, bin);
    const base = path.basename(argv[0]).toLowerCase().replace(/\.(exe|cmd|com)$/, '');
    if (bin && (base === 'node' || base === 'git') && !bins[base]) bins[base] = await versionOf(bin);
  }
  for (const [n, v] of Object.entries(bins)) { facts[`${n}_version`] = v; put(`version:${n}`, v); }
  put('node_version', process.version); put('node_arch', process.arch); put('os_release', os.release());
  const cwd = (commands.find((c) => c && c.cwd) || {}).cwd || process.cwd();
  const modules = real(path.join(cwd, 'node_modules'));
  put('node_modules', modules);
  put('node_modules_lock', fileDigest(path.join(cwd, 'node_modules', '.package-lock.json')));
  if (modules) facts.node_modules = modules;
  put('PATH', env.PATH || env.Path);
  for (const k of ['TEMP', 'TMP']) {
    const r = env[k] ? real(env[k]) || env[k] : null;
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
    const r = await capture(commands, { salt: saltOf(store), previous });
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
