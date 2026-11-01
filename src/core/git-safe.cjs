'use strict';
// git-safe.cjs — the hardening every belay git read shares (ADR 0054 decision 2): a repository's own config must not make a
// read run a program or write. git_read (src/mcp/git-read.cjs) and the core's reads of a worker's tree (a review's tree
// snapshot, files_within_owned's status) build their argv and environment here.
// - git is the absolute path found in the absolute PATH entries, never a bare name and never the cwd.
// - The environment drops every inherited GIT_* variable (GIT_DIR, GIT_CONFIG_PARAMETERS and GIT_CONFIG_COUNT inject
//   config) and sets GIT_CONFIG_NOSYSTEM, GIT_ATTR_NOSYSTEM, GIT_OPTIONAL_LOCKS=0 (status writes no index: invariant 6),
//   GIT_TERMINAL_PROMPT=0, GIT_NO_LAZY_FETCH=1 and a `cat` pager.
// - PRE: `--no-pager` and `-c` settings for no fsmonitor program, no signature check, no pager, no index refresh by diff,
//   and a hooks path that can never be a directory; then filterOverrides switches off every clean, smudge and process
//   filter named outside the global and system configs, and passes the system config's filter keys back as `-c`.
// Pure at load: it requires node built-ins only, and evaluate.cjs's runner lazily, inside safeGit.

const fs = require('node:fs');
const path = require('node:path');

// diff.autoRefreshIndex=false: GIT_OPTIONAL_LOCKS stops status's index refresh but not diff's, which writes the index and
// runs a post-index-change hook; core.hooksPath names a path under this file, which can never be a directory, so no
// hook runs at all.
const NO_HOOKS = `${__filename.split(path.sep).join('/')}/no-hooks`;
const PRE = Object.freeze(['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false', '-c', 'core.pager=cat', '-c', 'diff.autoRefreshIndex=false', '-c', `core.hooksPath=${NO_HOOKS}`]);

// The child's environment: the parent's without any GIT_* variable, plus belay's fixed ones.
function gitEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!/^GIT_/i.test(k)) out[k] = v;
  return { ...out, GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_PAGER: 'cat', PAGER: 'cat' };
}

// git's absolute path from the absolute PATH entries; never a relative entry and never the cwd.
function findGit(env = process.env) {
  const win = process.platform === 'win32';
  const names = win ? ['git.exe', 'git.cmd'] : ['git'];
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter((d) => d && path.isAbsolute(d));
  for (const d of dirs) {
    for (const n of names) {
      const f = path.join(d, n);
      try { if (fs.statSync(f).isFile()) return f; } catch { /* not here */ }
    }
  }
  return null;
}

const checkFailed = (what, r) => Object.assign(new Error(`git: the filter check (${what}) exited ${r.code}: ${r.errTail.trim().split('\n').pop() || 'no stderr'}`), { code: 'E_GIT', detail: { reason: 'filter_check', exit_code: r.code, stderr: r.errTail } });
const tooMany = () => Object.assign(new Error('git: the configuration names too many filter keys to check'), { code: 'E_GIT', detail: { reason: 'filter_check' } });
const badKey = (k) => k.includes('=') || /[\x00-\x1f]/.test(k);

// A clean or process filter named in the repository's own config runs on a plain `git status` of a stat-dirty file
// (the ADR 0054 evidence). Every filter driver named outside the global and system configs (local, worktree, an include
// of them) is switched off with belay's own `-c`; a driver name git's `-c` cannot carry (one holding '=') refuses the
// read. The system config is not read (GIT_CONFIG_NOSYSTEM), so its filter keys, which only an administrator writes (Git
// for Windows installs git-lfs there), are read on their own and passed back as `-c`: without them a stat-dirty LFS file
// reads as changed. The same system read takes the core keys that run nothing (CORE_KEYS), passed back the same way, since
// GIT_CONFIG_NOSYSTEM drops them too: every read gets core.fscache (a cache switch Git for Windows sets there; without it a
// status of a large tree costs several times as long), and a read that hashes content (`lineEndings`: judged.cjs's add -A
// into a temporary index) also gets core.autocrlf, core.eol, core.safecrlf and core.symlinks, so content hashes as a commit of
// it would. One read, so a prepare spawns two git config calls, as before the core keys; nothing is cached across calls, since
// the system config can change under a long-lived owner. `run(git, argv, { cwd, env, timeoutMs, maxOut, system })` resolves
// `{ code, out: Buffer, total, kept, errTail }`; `system: true` reads with the system config.
const CONTENT_KEYS = new Set(['core.autocrlf', 'core.eol', 'core.safecrlf', 'core.symlinks']);
const CORE_KEYS = new Set(['core.fscache', ...CONTENT_KEYS]);
async function filterOverrides(run, git, cwd, env, timeoutMs, { lineEndings = false } = {}) {
  // One read, with the system config on, tags each entry with its scope (`scope\0key\nvalue\0`): the system entries are passed back
  // and the entries of any other scope but global are switched off, so a hardened read costs one config spawn, not two.
  const r = await run(git, ['--no-pager', 'config', '--null', '--show-scope', '--get-regexp', '^(filter\.|merge\..+\.driver$|core\.(fscache|autocrlf|eol|safecrlf|symlinks)$)'], { cwd, env, timeoutMs, maxOut: 65536, system: true });
  if (r.code === 1 && r.total === 0) return []; // no such key anywhere
  if (r.code !== 0) throw checkFailed('git config', r);
  if (r.total > r.kept) throw tooMany();
  const parts = r.out.toString('utf8').split('\0');
  const out = [];
  const drivers = new Set();
  const mergers = new Set(); // merge.<name>.driver: merge-tree and merge run it for a path whose attributes name it
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const [scope, entry] = [parts[i], parts[i + 1]];
    const nl = entry.indexOf('\n');
    const key = nl < 0 ? entry : entry.slice(0, nl);
    if (scope === 'global') continue;
    if (scope === 'system') {
      if (badKey(key)) continue; // cannot be passed back; the filter stays absent, as NOSYSTEM leaves it
      const core = key.toLowerCase();
      if (CORE_KEYS.has(core) && (nl < 0 || (CONTENT_KEYS.has(core) && !lineEndings))) continue;
      if (/^merge\./i.test(key)) continue; // an administrator's driver is not passed back: NOSYSTEM leaves it absent
      out.push('-c', nl < 0 ? key : `${CORE_KEYS.has(core) ? core : key}=${entry.slice(nl + 1)}`);
      continue;
    }
    const mm = /^merge\.(.+)\.driver$/i.exec(key);
    if (mm) { mergers.add(mm[1]); continue; }
    const m = /^filter\.(.+)\.[^.]+$/i.exec(key);
    if (m) drivers.add(m[1]);
  }
  for (const d of mergers) {
    if (badKey(d)) throw Object.assign(new Error(`git: the repository's merge driver ${JSON.stringify(d)} cannot be switched off, so the read is refused`), { code: 'E_GIT', detail: { reason: 'merge_driver_name', driver: d } });
    out.push('-c', `merge.${d}.driver=`);
  }
  for (const d of drivers) {
    if (badKey(d)) throw Object.assign(new Error(`git: the repository's filter driver ${JSON.stringify(d)} cannot be switched off, so the read is refused`), { code: 'E_GIT', detail: { reason: 'filter_name', driver: d } });
    for (const k of ['clean', 'smudge', 'process']) out.push('-c', `filter.${d}.${k}=`);
    out.push('-c', `filter.${d}.required=false`);
  }
  return out;
}
// The hardened setup for one worktree: git's path, the environment and the filter overrides, read once. A caller making several
// reads of one tree (a review snapshot) prepares once and passes it to each safeGit. Resolves { git, env, filters } or { error }.
// `lineEndings` adds the system content keys (filterOverrides), for a caller that hashes content.
// `register` is the spawn-register kind of the config reads ('check' by default: every caller is the core reading a worker's or an
// integration tree, whose config and hooks are a worker's code; null: none).
async function prepare(cwd, timeoutMs, env = process.env, { lineEndings = false, register = 'check' } = {}) {
  const { runCommand } = require('./evaluate.cjs'); // lazy: evaluate.cjs requires this module
  const git = findGit(env);
  if (!git) return { error: 'git was not found on PATH' };
  const base = gitEnv(env);
  const run = async (g, argv, { cwd: c, timeoutMs: t, maxOut, system }) => {
    const e = { ...base };
    if (system) delete e.GIT_CONFIG_NOSYSTEM;
    const r = await runCommand([g, ...argv], c, t, { env: e, tail: maxOut, register });
    const out = Buffer.from(r.stdout || '', 'utf8');
    return { code: r.executable ? r.exit_code : -1, out, total: r.truncated ? out.length + 1 : out.length, kept: out.length, errTail: String(r.stderr || r.spawn_error || '') };
  };
  try {
    return { git, env: base, filters: await filterOverrides(run, git, cwd, env, timeoutMs, { lineEndings }) };
  } catch (e) { return { error: e.message }; }
}

// One hardened git read for the core, through evaluate.cjs's runCommand: `args` follow belay's PRE and filter overrides.
// Resolves runCommand's shape; a missing git or a failed filter check is `executable: false` with `spawn_error` naming it.
async function safeGit(args, cwd, timeoutMs, { tail, env = process.env, prepared = null, lineEndings = false, register = 'check' } = {}) {
  const { runCommand } = require('./evaluate.cjs');
  const p = prepared || await prepare(cwd, timeoutMs, env, { lineEndings, register });
  if (p.error) return { executable: false, exit_code: null, stdout: '', stderr: '', spawn_error: p.error };
  return runCommand([p.git, ...PRE, ...p.filters, ...args], cwd, timeoutMs, { env: p.env, ...(tail ? { tail } : {}), register });
}

// The absolute git every belay spawn uses, found once per PATH value: a bare 'git' is searched in the child's cwd first on Windows, so a
// git.exe committed into a worker's tree would run. Only git.exe on Windows (execFile cannot run a .cmd). When PATH holds no git it is
// a path that cannot exist, so the spawn fails with ENOENT: there is no fall back to the bare name.
let pathKey = null, pathGit = null;
const NO_GIT = path.join(__dirname, 'belay-git-not-found-on-path');
function gitPath() {
  const key = String(process.env.PATH || process.env.Path || '');
  if (key !== pathKey) {
    pathKey = key;
    pathGit = null;
    for (const d of key.split(path.delimiter).filter((x) => x && path.isAbsolute(x))) {
      const f = path.join(d, process.platform === 'win32' ? 'git.exe' : 'git');
      try { if (fs.statSync(f).isFile()) { pathGit = f; break; } } catch { /* not here */ }
    }
  }
  return pathGit || NO_GIT;
}

// The variables that name which repository, index or object store a call acts on, or inject configuration or an external diff program.
// A call that follows them acts on, or runs, what an owner born inside a git hook inherited (git sets GIT_DIR and GIT_INDEX_FILE there,
// and `git -c` sets GIT_CONFIG_PARAMETERS). Reads under safeGit drop every GIT_* variable; the writing calls drop these.
const INJECTED = /^GIT_(DIR|INDEX_FILE|WORK_TREE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|EXTERNAL_DIFF)$/i;
function withoutInjected(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!INJECTED.test(k)) out[k] = v;
  return out;
}

module.exports = { PRE, NO_HOOKS, gitEnv, findGit, gitPath, withoutInjected, filterOverrides, prepare, safeGit };
