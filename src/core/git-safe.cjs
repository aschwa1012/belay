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
// reads as changed. `run(git, argv, { cwd, env, timeoutMs, maxOut, system })` resolves `{ code, out: Buffer, total, kept,
// errTail }`; `system: true` reads with the system config.
async function filterOverrides(run, git, cwd, env, timeoutMs) {
  const out = [];
  const sys = await run(git, ['--no-pager', 'config', '--system', '--null', '--get-regexp', '^filter\\.'], { cwd, env, timeoutMs, maxOut: 65536, system: true });
  if (!(sys.code === 1 && sys.total === 0)) {
    if (sys.code !== 0) throw checkFailed('git config --system', sys);
    if (sys.total > sys.kept) throw tooMany();
    for (const entry of sys.out.toString('utf8').split('\0').filter(Boolean)) {
      const nl = entry.indexOf('\n');
      const key = nl < 0 ? entry : entry.slice(0, nl);
      if (badKey(key)) continue; // cannot be passed back; the filter stays absent, as NOSYSTEM leaves it
      out.push('-c', nl < 0 ? key : `${key}=${entry.slice(nl + 1)}`);
    }
  }
  const r = await run(git, ['--no-pager', 'config', '--null', '--show-scope', '--name-only', '--get-regexp', '^filter\\.'], { cwd, env, timeoutMs, maxOut: 65536 });
  if (r.code === 1 && r.total === 0) return out; // no filter key outside the system config
  if (r.code !== 0) throw checkFailed('git config', r);
  if (r.total > r.kept) throw tooMany();
  const parts = r.out.toString('utf8').split('\0');
  const drivers = new Set();
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const [scope, key] = [parts[i], parts[i + 1]];
    if (scope === 'global' || scope === 'system') continue;
    const m = /^filter\.(.+)\.[^.]+$/i.exec(key);
    if (m) drivers.add(m[1]);
  }
  for (const d of drivers) {
    if (badKey(d)) throw Object.assign(new Error(`git: the repository's filter driver ${JSON.stringify(d)} cannot be switched off, so the read is refused`), { code: 'E_GIT', detail: { reason: 'filter_name', driver: d } });
    for (const k of ['clean', 'smudge', 'process']) out.push('-c', `filter.${d}.${k}=`);
    out.push('-c', `filter.${d}.required=false`);
  }
  return out;
}

// The system config's line-ending keys (core.autocrlf, core.eol, core.safecrlf), passed back as `-c` like its filter keys: a
// read that hashes content (judged.cjs's add -A into a temporary index) must convert line endings as a commit will, and Git for
// Windows sets core.autocrlf=true in its system config, which GIT_CONFIG_NOSYSTEM drops.
async function systemLineEndings(run, git, cwd, env, timeoutMs) {
  const sys = await run(git, ['--no-pager', 'config', '--system', '--null', '--get-regexp', '^core\\.(autocrlf|eol|safecrlf)$'], { cwd, env, timeoutMs, maxOut: 4096, system: true });
  if (sys.code === 1 && sys.total === 0) return [];
  if (sys.code !== 0) throw checkFailed('git config --system core line endings', sys);
  const out = [];
  for (const entry of sys.out.toString('utf8').split('\0').filter(Boolean)) {
    const nl = entry.indexOf('\n');
    if (nl > 0 && !badKey(entry.slice(0, nl))) out.push('-c', `${entry.slice(0, nl)}=${entry.slice(nl + 1)}`);
  }
  return out;
}

// The hardened setup for one worktree: git's path, the environment and the filter overrides, read once. A caller making several
// reads of one tree (a review snapshot) prepares once and passes it to each safeGit. Resolves { git, env, filters } or { error }.
// `lineEndings` also passes back the system line-ending keys (systemLineEndings), for a caller that hashes content.
async function prepare(cwd, timeoutMs, env = process.env, { lineEndings = false } = {}) {
  const { runCommand } = require('./evaluate.cjs'); // lazy: evaluate.cjs requires this module
  const git = findGit(env);
  if (!git) return { error: 'git was not found on PATH' };
  const base = gitEnv(env);
  const run = async (g, argv, { cwd: c, timeoutMs: t, maxOut, system }) => {
    const e = { ...base };
    if (system) delete e.GIT_CONFIG_NOSYSTEM;
    const r = await runCommand([g, ...argv], c, t, { env: e, tail: maxOut });
    const out = Buffer.from(r.stdout || '', 'utf8');
    return { code: r.executable ? r.exit_code : -1, out, total: r.truncated ? out.length + 1 : out.length, kept: out.length, errTail: String(r.stderr || r.spawn_error || '') };
  };
  try {
    const filters = await filterOverrides(run, git, cwd, env, timeoutMs);
    return { git, env: base, filters: lineEndings ? [...filters, ...(await systemLineEndings(run, git, cwd, env, timeoutMs))] : filters };
  } catch (e) { return { error: e.message }; }
}

// One hardened git read for the core, through evaluate.cjs's runCommand: `args` follow belay's PRE and filter overrides.
// Resolves runCommand's shape; a missing git or a failed filter check is `executable: false` with `spawn_error` naming it.
async function safeGit(args, cwd, timeoutMs, { tail, env = process.env, prepared = null } = {}) {
  const { runCommand } = require('./evaluate.cjs');
  const p = prepared || await prepare(cwd, timeoutMs, env);
  if (p.error) return { executable: false, exit_code: null, stdout: '', stderr: '', spawn_error: p.error };
  return runCommand([p.git, ...PRE, ...p.filters, ...args], cwd, timeoutMs, { env: p.env, ...(tail ? { tail } : {}) });
}

module.exports = { PRE, NO_HOOKS, gitEnv, findGit, filterOverrides, systemLineEndings, prepare, safeGit };
