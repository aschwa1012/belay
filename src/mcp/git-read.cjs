'use strict';
// git-read.cjs — the orchestrator's read-only git (ADR 0054 decision 2). The orchestrator has no shell, so belay runs
// four git reads for it: status, log, diff and show, in a named worktree, a task's worktree or the run's. The argv is
// belay's: the caller chooses only the op, a rev, a path, a count and whether to show a stat, and none of them can
// become an option. A command-pattern allowlist over Bash is not used, because `git diff --output=`, `-c`, aliases,
// pagers, external diff drivers and textconv filters all reach a write or a program from a "read".
//
// What belay fixes on every call:
// - git is the absolute path belay finds on PATH, skipping relative PATH entries, rather than a bare name left to the
//   platform's search (a planted git.exe in the worktree was not picked up by Node 24 on this host either way).
// - The environment drops every inherited GIT_* variable (GIT_DIR, GIT_CONFIG_PARAMETERS and GIT_CONFIG_COUNT inject
//   config) and sets GIT_CONFIG_NOSYSTEM, GIT_ATTR_NOSYSTEM, GIT_OPTIONAL_LOCKS=0 (status refreshes no index: reading
//   never writes, invariant 6), GIT_TERMINAL_PROMPT=0, GIT_NO_LAZY_FETCH=1 and a `cat` pager.
// - `--no-pager` and belay's own `-c` settings: no fsmonitor program, no signature check (gpg), no pager, no index
//   refresh by diff, no hooks, and no clean, smudge or process filter from the repository's own config (filterOverrides);
//   submodules are not read (`--ignore-submodules=all`).
// - `--no-ext-diff --no-textconv --no-color` on the ops that print diffs, then `--end-of-options` before the rev and
//   `--` before the path, beside the validation below.
// Output is bounded (MAX_OUT bytes, the rest counted and marked), and the call is bounded in time; a timeout ends the
// child by its own handle. Not imported by any read path of the CLI (invariant 9).

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const PROC = require('../core/process.cjs'); // killMany: verified targets from one snapshot (ADR 0039)
const ID = require('../core/proc-identity.cjs'); // the process snapshot and the descendant walk

const OPS = ['status', 'log', 'diff', 'show'];
const MAX_OUT = 16384;
const STDERR_TAIL = 2048;
const TIMEOUT_MS = 10000;
const KILL_WAIT_MS = 15000; // a timed-out call waits this long at most for git's tree to be killed (two process snapshots; each took 2-4 s on a loaded host)
const LOG_N = 20;
const LOG_MAX = 200;
// belay's own options, before the subcommand; gitRead adds the filter overrides after them.
// diff.autoRefreshIndex=false: GIT_OPTIONAL_LOCKS stops status's index refresh but not diff's, which writes the index and
// runs a post-index-change hook; core.hooksPath names a path under this file, which can never be a directory, so no
// hook runs at all.
const NO_HOOKS = `${__filename.split(path.sep).join('/')}/no-hooks`;
const PRE = ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false', '-c', 'core.pager=cat', '-c', 'diff.autoRefreshIndex=false', '-c', `core.hooksPath=${NO_HOOKS}`];
const PRE_LEN = PRE.length;
// One side of a rev: a ref name, a sha, HEAD~2, main@{1}, v1^{commit}. It cannot start with '-' (an option), and holds
// no ':' (a blob path; Read reads files), no '..' (a range is split first), no space or control character.
const SIDE = /^[A-Za-z0-9_][A-Za-z0-9._/@{}^~+-]{0,199}$/;

const bad = (message, detail) => Object.assign(new Error(message), { code: 'E_ARGS', detail });

function checkRev(rev, op) {
  if (rev === undefined || rev === null) return null;
  if (typeof rev !== 'string') throw bad('git_read: rev must be a string', { field: 'rev' });
  const m = /^(.*?)(\.{2,3})(.*)$/.exec(rev);
  const sides = m ? [m[1], m[3]] : [rev];
  if (m && op === 'show') throw bad('git_read: show takes one commit, not a range', { field: 'rev', rev });
  const ok = sides.every((s) => (m && s === '') || (SIDE.test(s) && !s.includes('..'))) && sides.some((s) => s !== '');
  if (!ok) throw bad('git_read: rev must be a ref, a sha or a range of two (a..b, a...b); it cannot start with "-" or hold ":", spaces or control characters', { field: 'rev', rev });
  return rev;
}

function checkPath(p) {
  if (p === undefined || p === null) return null;
  if (typeof p !== 'string' || p === '' || p.length > 500 || /[\x00-\x1f]/.test(p)) throw bad('git_read: path must be a non-empty string of at most 500 characters with no control characters', { field: 'path' });
  return p;
}

function checkN(n) {
  if (n === undefined || n === null) return LOG_N;
  if (!Number.isInteger(n) || n < 1 || n > LOG_MAX) throw bad(`git_read: n must be an integer from 1 to ${LOG_MAX}`, { field: 'n', n });
  return n;
}

// The git arguments for one call, after `git`. Pure: a test can read exactly what would run.
function gitArgs({ op, rev = null, path: p = null, stat = false, n = null }) {
  if (!OPS.includes(op)) throw bad(`git_read: op must be one of ${OPS.join(', ')}`, { field: 'op', op });
  const r = checkRev(rev, op);
  const pathspec = checkPath(p);
  if (stat !== undefined && stat !== null && typeof stat !== 'boolean') throw bad('git_read: stat must be a boolean', { field: 'stat' });
  // A submodule is a repository of its own: its config could name filters belay has not switched off. None is read.
  const quiet = ['--no-color', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all'];
  let args;
  if (op === 'status') {
    if (r) throw bad('git_read: status takes no rev', { field: 'rev' });
    args = ['status', '--porcelain=v1', '--branch', '--untracked-files=normal', '--ignore-submodules=all'];
  } else if (op === 'log') {
    args = ['log', ...quiet, '--no-show-signature', '--format=%H %aI %an%n    %s', '-n', String(checkN(n)), ...(stat ? ['--stat'] : [])];
  } else if (op === 'diff') {
    args = ['diff', ...quiet, ...(stat ? ['--stat'] : [])];
  } else {
    args = ['show', ...quiet, '--no-show-signature', ...(stat ? ['--stat'] : [])];
  }
  if (op !== 'log' && n !== undefined && n !== null) throw bad('git_read: n is for log only', { field: 'n' });
  if (op !== 'status') {
    args.push('--end-of-options');
    if (r) args.push(r);
    else if (op === 'show') args.push('HEAD');
  }
  if (pathspec) args.push('--', pathspec);
  return [...PRE, ...args];
}

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

function checkWorktree(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw bad('git_read: worktree must be an absolute path', { field: 'worktree', worktree: dir });
  // A UNC or device path (//host/share, \\?\) would open a network connection or reach a device before git runs.
  if (/^[\\/]{2}/.test(dir)) throw bad('git_read: worktree must be a local path, not a UNC or device path', { field: 'worktree', worktree: dir });
  let st = null;
  try { st = fs.statSync(dir); } catch { /* absent */ }
  if (!st || !st.isDirectory()) throw Object.assign(new Error(`git_read: the worktree ${dir} does not exist or is not a directory`), { code: 'E_NOT_FOUND', detail: { worktree: dir } });
  return dir.split('\\').join('/');
}

// Which directory: an explicit worktree, else the task's, else the run's. `taskWorktree(id)` answers a task's
// directory or null (the adapter's lookup through the core); `runWorktree` is the adapter's `--worktree`.
async function resolveWorktree(args, { runWorktree = null, taskWorktree = null } = {}) {
  if (args.worktree !== undefined && args.worktree !== null) {
    if (args.task_id !== undefined && args.task_id !== null) throw bad('git_read takes worktree or task_id, not both', { field: 'task_id' });
    return { worktree: checkWorktree(args.worktree), from: 'worktree' };
  }
  if (args.task_id !== undefined && args.task_id !== null) {
    if (typeof args.task_id !== 'string' || !args.task_id) throw bad('git_read: task_id must be a non-empty string', { field: 'task_id' });
    const dir = taskWorktree ? await taskWorktree(args.task_id) : null;
    if (!dir) throw Object.assign(new Error(`git_read: no worktree is recorded for task ${args.task_id}; name the worktree`), { code: 'E_NOT_FOUND', detail: { task_id: args.task_id } });
    return { worktree: checkWorktree(dir), from: `task ${args.task_id}` };
  }
  if (!runWorktree) throw bad('git_read: this adapter knows no run worktree; name the worktree', { field: 'worktree' });
  return { worktree: checkWorktree(runWorktree), from: 'run' };
}

// One git process, bounded in output and time. Resolves { code, out, total, kept, errTail, ms } or rejects E_GIT for a
// spawn failure or a timeout. On a timeout the pipes are destroyed (a filter or a submodule's git holding them open
// cannot keep the call waiting), git and its descendants are killed (killGitTree: the root by its handle, the rest by
// identity, ADR 0039), and the call rejects once that kill answers, or after KILL_WAIT_MS, naming what was killed. `system`: read with the system config (filterOverrides' read of the system filters only).
function run(git, argv, { cwd, env, timeoutMs, maxOut, system = false }) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const kept = []; let keptBytes = 0; let total = 0; let errTail = ''; let settled = false;
    const spawnFail = (e) => Object.assign(new Error(`git_read: git could not be started (${e.code || e.message})`), { code: 'E_GIT', detail: { reason: 'spawn', argv } });
    const childEnv = gitEnv(env);
    if (system) delete childEnv.GIT_CONFIG_NOSYSTEM;
    let child;
    try {
      child = spawn(git, argv, { cwd, env: childEnv, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { reject(spawnFail(e)); return; }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.stdout.destroy(); child.stderr.destroy();
      // The kill is waited for, at most KILL_WAIT_MS, so the caller's answer comes after git and its descendants are gone.
      const kill = killGitTree(child).catch((e) => ({ ok: false, error: e.code || e.message }));
      const bound = new Promise((r) => { const t = setTimeout(() => r({ ok: false, error: `kill not finished in ${KILL_WAIT_MS} ms` }), KILL_WAIT_MS); if (t.unref) t.unref(); });
      Promise.race([kill, bound]).then((k) => reject(Object.assign(new Error(`git_read: git timed out after ${timeoutMs} ms and was stopped`), { code: 'E_GIT', detail: { reason: 'timeout', argv, worktree: cwd, ms: Date.now() - t0, kill: k } })));
    }, timeoutMs);
    child.stdout.on('data', (b) => {
      total += b.length;
      if (keptBytes < maxOut) { const part = b.subarray(0, maxOut - keptBytes); kept.push(part); keptBytes += part.length; }
    });
    child.stderr.on('data', (b) => { errTail = (errTail + b.toString('utf8')).slice(-STDERR_TAIL); });
    child.on('error', (e) => { clearTimeout(timer); if (!settled) { settled = true; reject(spawnFail(e)); } });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ code: code === null ? signal : code, out: Buffer.concat(kept), total, kept: keptBytes, errTail, ms: Date.now() - t0 });
    });
  });
}

// A timed-out git and everything under it, parents before children. A process killed while its parent lives lets the
// parent start its next command (PROC.killTree kills leaves first: git started the next filter as soon as one died, and a
// filter's sh its next sleep), so every parent goes first: one snapshot while git lives names the tree and each process's
// creation time, the handle kills git, the named descendants are killed top-down by identity, and a second snapshot
// catches any child a killed process started before it died (parent pid a killed one's, created after it), with that
// child's own tree.
async function killGitTree(child) {
  const pid = child.pid;
  const snap1 = await ID.processSnapshot({ kind: 'kill' });
  const root = snap1 && snap1.get(pid);
  const first = snap1 ? ID.descendantsOf(pid, snap1).leavesFirst.reverse() : []; // top-down
  if (ID.handleLive(child)) child.kill();
  const killed = [pid];
  const a = await PROC.killMany(first, { snapshot: async () => snap1 }); // identities checked against the snapshot that named them
  for (const r of a) if (r.killed) killed.push(r.pid);
  if (!root || root.created == null) return { ok: !!snap1, killed, ...(snap1 ? {} : { error: 'process snapshot unreadable: descendants not killed' }) };
  const snap2 = await ID.processSnapshot({ kind: 'kill' });
  const created = new Map([[pid, root.created], ...first.map((t) => [t.pid, t.created])]);
  const late = [];
  const seen = new Set(created.keys());
  for (const [p, c] of created) {
    for (const k of ID.childrenOf(p, c, snap2)) {
      if (seen.has(k)) continue;
      seen.add(k);
      const e = snap2.get(k);
      late.push({ pid: k, created: e.created, image: e.image });
      for (const d of ID.descendantsOf(k, snap2).leavesFirst.reverse()) if (!seen.has(d.pid)) { seen.add(d.pid); late.push(d); }
    }
  }
  const b = await PROC.killMany(late, { snapshot: async () => snap2 });
  for (const r of b) if (r.killed) killed.push(r.pid);
  const refused = [...a, ...b].filter((r) => r.refused);
  return { ok: refused.length === 0, killed, ...(refused.length ? { refused: refused.map((r) => ({ pid: r.pid, kind: r.kind })) } : {}) };
}

const checkFailed = (what, r) => Object.assign(new Error(`git_read: the filter check (${what}) exited ${r.code}: ${r.errTail.trim().split('\n').pop() || 'no stderr'}`), { code: 'E_GIT', detail: { reason: 'filter_check', exit_code: r.code, stderr: r.errTail } });
const tooMany = () => Object.assign(new Error('git_read: the configuration names too many filter keys to check'), { code: 'E_GIT', detail: { reason: 'filter_check' } });
const badKey = (k) => k.includes('=') || /[\x00-\x1f]/.test(k);

// A clean or process filter named in the repository's own config runs on a plain `git status` of a stat-dirty file
// (measured on Windows). Every filter driver named outside the global and
// system configs (local, worktree, an include of them) is switched off with belay's own `-c`; a driver name git's `-c`
// cannot carry (one holding '=') refuses the read. The system config is not read (GIT_CONFIG_NOSYSTEM), so its filter
// keys, which only an administrator writes (Git for Windows installs git-lfs there), are read on their own and passed
// back as `-c`: without them a stat-dirty LFS file reads as changed. Submodules are not read at all
// (`--ignore-submodules=all`), so a submodule's own config is never consulted.
async function filterOverrides(git, cwd, env, timeoutMs) {
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
    if (badKey(d)) throw Object.assign(new Error(`git_read: the repository's filter driver ${JSON.stringify(d)} cannot be switched off, so the read is refused`), { code: 'E_GIT', detail: { reason: 'filter_name', driver: d } });
    for (const k of ['clean', 'smudge', 'process']) out.push('-c', `filter.${d}.${k}=`);
    out.push('-c', `filter.${d}.required=false`);
  }
  return out;
}

// Runs one read. Resolves the result, or rejects E_ARGS, E_NOT_FOUND or E_GIT (git missing, failed or timed out).
async function gitRead(args, { runWorktree = null, taskWorktree = null, env = process.env, timeoutMs = TIMEOUT_MS, maxOut = MAX_OUT } = {}) {
  const a = args || {};
  const base = gitArgs(a);
  const { worktree, from } = await resolveWorktree(a, { runWorktree, taskWorktree });
  const git = findGit(env);
  if (!git) throw Object.assign(new Error('git_read: git was not found on PATH'), { code: 'E_GIT', detail: { reason: 'no_git' } });
  const t0 = Date.now();
  const filters = await filterOverrides(git, worktree, env, timeoutMs);
  const argv = [...base.slice(0, PRE_LEN), ...filters, ...base.slice(PRE_LEN)];
  const r = await run(git, argv, { cwd: worktree, env, timeoutMs, maxOut });
  if (r.code !== 0) throw Object.assign(new Error(`git_read: git ${a.op} exited ${r.code}: ${r.errTail.trim().split('\n').pop() || 'no stderr'}`), { code: 'E_GIT', detail: { reason: 'exit', exit_code: r.code, argv: ['git', ...argv], worktree, stderr: r.errTail } });
  let out = r.out.toString('utf8');
  const truncated = r.total > r.kept;
  if (truncated) out += `\n[truncated: ${r.kept} of ${r.total} bytes shown; narrow with path or stat]`;
  return { op: a.op, worktree, worktree_from: from, argv: ['git', ...argv], exit_code: 0, ms: Date.now() - t0, bytes: r.total, truncated, out };
}

module.exports = { gitRead, gitArgs, gitEnv, findGit, resolveWorktree, OPS, MAX_OUT, TIMEOUT_MS };
