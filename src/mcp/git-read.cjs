'use strict';
// git-read.cjs — the orchestrator's read-only git (ADR 0054 decision 2). The orchestrator has no shell, so belay runs
// four git reads for it: status, log, diff and show, in a named worktree, a task's worktree or the run's. The argv is
// belay's: the caller chooses only the op, a rev, a path, a count and whether to show a stat, and none of them can
// become an option. A command-pattern allowlist over Bash is not used, because `git diff --output=`, `-c`, aliases,
// pagers, external diff drivers and textconv filters all reach a write or a program from a "read".
//
// What belay fixes on every call:
// - git is the absolute path found on PATH, never a name the child's cwd can answer (a planted git.exe in the worktree).
// - The environment drops every inherited GIT_* variable (GIT_DIR, GIT_CONFIG_PARAMETERS and GIT_CONFIG_COUNT inject
//   config) and sets GIT_CONFIG_NOSYSTEM, GIT_ATTR_NOSYSTEM, GIT_OPTIONAL_LOCKS=0 (status refreshes no index: reading
//   never writes, invariant 6), GIT_TERMINAL_PROMPT=0, GIT_NO_LAZY_FETCH=1 and a `cat` pager.
// - `--no-pager` and belay's own `-c` settings: no fsmonitor program, no signature check (gpg), no pager.
// - `--no-ext-diff --no-textconv --no-color` on the ops that print diffs, then `--end-of-options` before the rev and
//   `--` before the path, beside the validation below.
// Output is bounded (MAX_OUT bytes, the rest counted and marked), and the call is bounded in time; a timeout ends the
// child by its own handle. Not imported by any read path of the CLI (invariant 9).

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const OPS = ['status', 'log', 'diff', 'show'];
const MAX_OUT = 16384;
const STDERR_TAIL = 2048;
const TIMEOUT_MS = 10000;
const LOG_N = 20;
const LOG_MAX = 200;
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
  const pre = ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false', '-c', 'core.pager=cat'];
  const quiet = ['--no-color', '--no-ext-diff', '--no-textconv'];
  let args;
  if (op === 'status') {
    if (r) throw bad('git_read: status takes no rev', { field: 'rev' });
    args = ['status', '--porcelain=v1', '--branch', '--untracked-files=normal'];
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
  return [...pre, ...args];
}

// The child's environment: the parent's without any GIT_* variable, plus belay's fixed ones.
function gitEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!/^GIT_/i.test(k)) out[k] = v;
  return { ...out, GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_PAGER: 'cat', PAGER: 'cat' };
}

// git's absolute path from PATH, never the cwd: on Windows a bare name is looked up in the child's cwd first.
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

// Runs one read. Resolves the result, or rejects E_ARGS, E_NOT_FOUND or E_GIT (git missing, failed or timed out).
async function gitRead(args, { runWorktree = null, taskWorktree = null, env = process.env, timeoutMs = TIMEOUT_MS, maxOut = MAX_OUT } = {}) {
  const a = args || {};
  const argv = gitArgs(a);
  const { worktree, from } = await resolveWorktree(a, { runWorktree, taskWorktree });
  const git = findGit(env);
  if (!git) throw Object.assign(new Error('git_read: git was not found on PATH'), { code: 'E_GIT', detail: { reason: 'no_git' } });
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const kept = []; let keptBytes = 0; let total = 0; let errTail = ''; let timedOut = false;
    let child;
    try {
      child = spawn(git, argv, { cwd: worktree, env: gitEnv(env), windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      reject(Object.assign(new Error(`git_read: git could not be started (${e.code || e.message})`), { code: 'E_GIT', detail: { reason: 'spawn', argv } }));
      return;
    }
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on('data', (b) => {
      total += b.length;
      if (keptBytes < maxOut) { const part = b.subarray(0, maxOut - keptBytes); kept.push(part); keptBytes += part.length; }
    });
    child.stderr.on('data', (b) => { errTail = (errTail + b.toString('utf8')).slice(-STDERR_TAIL); });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(Object.assign(new Error(`git_read: git could not be started (${e.code || e.message})`), { code: 'E_GIT', detail: { reason: 'spawn', argv } }));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const ms = Date.now() - t0;
      if (timedOut) return reject(Object.assign(new Error(`git_read: git ${a.op} timed out after ${timeoutMs} ms and was stopped`), { code: 'E_GIT', detail: { reason: 'timeout', argv, worktree, ms } }));
      if (code !== 0) return reject(Object.assign(new Error(`git_read: git ${a.op} exited ${code === null ? signal : code}: ${errTail.trim().split('\n').pop() || 'no stderr'}`), { code: 'E_GIT', detail: { reason: 'exit', exit_code: code, argv, worktree, stderr: errTail } }));
      let out = Buffer.concat(kept).toString('utf8');
      const truncated = total > keptBytes;
      if (truncated) out += `\n[truncated: ${keptBytes} of ${total} bytes shown; narrow with path or stat]`;
      resolve({ op: a.op, worktree, worktree_from: from, argv: ['git', ...argv], exit_code: code, ms, bytes: total, truncated, out });
    });
  });
}

module.exports = { gitRead, gitArgs, gitEnv, findGit, resolveWorktree, OPS, MAX_OUT, TIMEOUT_MS };
