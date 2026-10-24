'use strict';
// git-facts.cjs — build step W2-3 (S4a), design item 3. The one git call the run side makes: the HEAD of a
// worker's worktree, for the worker row's base_sha (at spawn) and head_sha (at settle). No shell, an argv
// array, a bounded wait, and never a throw: any failure (no git, not a repository, a missing directory, a
// timeout) resolves to null, and a row with a null sha says "unknown", not an error. Not imported by any
// read path (invariant 9).

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const SHA = /^[0-9a-f]{40,64}$/;
const NO_REPO = 'not in a git repository';
// Spawn failures that a moment's wait can cure (a process or descriptor table full). Anything else, a timeout,
// a git that ran and exited nonzero, a missing git, is not retried: asking again cannot help or would eat the budget.
const SPAWN_RETRY = new Set(['EAGAIN', 'EMFILE', 'ENFILE', 'ENOMEM', 'EBUSY']);

// True when `dir` or any ancestor holds a `.git` entry (a directory, or the file a linked worktree has).
// A directory in no repository is answered null without spawning git: a spawn costs tens of milliseconds
// on Windows, and the settle-time write waits on it. Any doubt (a stat error, a non-string) says "maybe".
function maybeInRepo(dir) {
  try {
    let d = path.resolve(dir);
    for (;;) {
      if (fs.existsSync(path.join(d, '.git'))) return true;
      const up = path.dirname(d);
      if (up === d) return false;
      d = up;
    }
  } catch {
    return true;
  }
}

// Resolves `{ sha, reason, retry }`, never throws. `reason` names why there is no sha; `retry` is false when
// asking again cannot help (a directory in no repository), true for a timeout or a failed spawn or run.
function revParseHeadResult(cwd, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (sha, reason, retry) => { if (!done) { done = true; resolve({ sha, reason: sha ? null : reason, retry: !sha && retry }); } };
    if (typeof cwd === 'string' && !maybeInRepo(cwd)) return finish(null, NO_REPO, false);
    try {
      const child = execFile('git', ['rev-parse', 'HEAD'], { cwd, timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 64 },
        (error, stdout) => {
          const sha = String(stdout || '').trim();
          if (!error && SHA.test(sha)) return finish(sha, null, false);
          if (!error) return finish(null, 'git rev-parse HEAD printed no sha', false);
          if (error.killed) return finish(null, `git rev-parse HEAD timed out after ${timeoutMs} ms`, false);
          const spawnFailure = typeof error.code === 'string' && SPAWN_RETRY.has(error.code);
          finish(null, spawnFailure ? `git could not be spawned (${error.code})` : `git rev-parse HEAD failed (${error.code != null ? error.code : error.message})`, spawnFailure);
        });
      child.on('error', (e) => finish(null, `git could not be spawned (${e && e.code})`, !!(e && SPAWN_RETRY.has(e.code))));
    } catch (e) {
      finish(null, `git could not be spawned (${e && e.code})`, !!(e && SPAWN_RETRY.has(e.code)));
    }
  });
}

function revParseHead(cwd, opts) {
  return revParseHeadResult(cwd, opts).then((r) => r.sha);
}

module.exports = { revParseHead, revParseHeadResult, NO_REPO };
