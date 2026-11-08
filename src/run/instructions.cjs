'use strict';
// instructions.cjs — build step S2-2, ADR 0024 amendment 1: with `--setting-sources=` Claude Code no
// longer loads the worktree's CLAUDE.md, so belay copies it once, at spawn, into the worker's (or the
// orchestrator's) own data directory and passes the copy with --append-system-prompt-file on every
// launch. The copy is the only instruction text a later launch sees: an adoption reuses it and never
// re-reads the worktree, so a worker cannot edit its own instructions for its next resume. That holds
// only while the data directory lies outside the worker's worktree; nothing here refuses a data
// directory inside it (carried, not closed in this step). A spawn first removes any copy a previous
// spawn of the same worker id left, so an id reused from a worktree without CLAUDE.md is never
// adopted with the earlier spawn's instructions.
// No read path imports this module (invariant 9): it is used by the spawn path only.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const G = require('../core/git.cjs');
const { gitPath, withoutInjected } = require('../core/git-safe.cjs');
const { execFile } = require('node:child_process');

// Deliberately not CLAUDE.md: nothing that walks a directory for instruction files should find it.
const INSTRUCTIONS_FILE = 'instructions.md';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Called only at spawn. Copies `<worktree>/CLAUDE.md` when it is a regular file, byte for byte; writes
// nothing and names why otherwise (absent, not a regular file, or unreadable).
function snapshotInstructions(worktree, dir) {
  const source = path.join(worktree, 'CLAUDE.md');
  fs.rmSync(path.join(dir, INSTRUCTIONS_FILE), { force: true }); // B1: never leave a previous spawn's copy
  let st;
  try {
    if (fs.lstatSync(source).isSymbolicLink()) return { path: null, reason: 'CLAUDE.md in the worktree is a symbolic link, so it was not copied', source }; // a committed link would deliver a file from outside the tree
    st = fs.statSync(source);
  } catch (e) {
    if (e && e.code === 'ENOENT') return { path: null, reason: 'no CLAUDE.md in the worktree', source };
    return { path: null, reason: `CLAUDE.md unreadable: ${e && e.code ? e.code : e}`, source };
  }
  if (!st.isFile()) return { path: null, reason: 'CLAUDE.md in the worktree is not a regular file', source };
  let bytes;
  try {
    bytes = fs.readFileSync(source);
  } catch (e) {
    return { path: null, reason: `CLAUDE.md unreadable: ${e && e.code ? e.code : e}`, source };
  }
  return { ...writeCopy(bytes, dir), source };
}

function writeCopy(bytes, dir) {
  const target = path.join(dir, INSTRUCTIONS_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, target);
  return { path: target.replace(/\\/g, '/'), bytes: bytes.length, sha256: sha256(bytes) };
}

// Git for a trusted read: in the repository's own top (never a worker's tree), replace refs off.
const SAFE_ENV = { GIT_NO_REPLACE_OBJECTS: '1' };
const git = (cwd, args) => G.run(cwd, ['--no-replace-objects', ...args], { timeoutMs: 10000, env: SAFE_ENV });
const firstLine = (r) => String((r && (r.stderr || r.spawn_error)) || 'no message').split('\n')[0].slice(0, 160);

// A blob as bytes (G.run answers text, which would re-encode a file that is not UTF-8). Async; a timeout kills the child.
function catBlob(top, id) {
  return new Promise((resolve) => {
    // The absolute git and an environment without the repository-locating GIT_* variables (git-safe), as every other core spawn. `top`
    // is the repository's main checkout, not a worker's tree, and cat-file reads the object database only (no hook, no filter), so
    // there is no check process to register.
    execFile(gitPath(), ['--no-replace-objects', 'cat-file', 'blob', id], { cwd: top, encoding: 'buffer', timeout: 10000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: { ...withoutInjected(), ...SAFE_ENV, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' } },
      (e, stdout, stderr) => resolve(e ? { ok: false, stderr: String(stderr || e.message) } : { ok: true, bytes: stdout }));
  });
}

// The instructions of a worker that reads another worker's tree (a reviewer): never the working copy, which the reviewed
// coder can edit to address its reviewer. They are CLAUDE.md as committed at `commit` (a full commit id the caller has shown
// no worker authored), read from the object database of `top` (the repository's main checkout) with ls-tree and cat-file:
// no checkout, no write. A symbolic link, a missing file or a git failure copies nothing and names why. `dir` is the
// worker's data dir, as for snapshotInstructions.
async function snapshotTrusted(top, dir, commit) {
  fs.rmSync(path.join(dir, INSTRUCTIONS_FILE), { force: true });
  const source = `git:${commit || 'none'}:CLAUDE.md`;
  const none = (reason) => ({ path: null, reason, source });
  if (!top || !/^[0-9a-f]{40,64}$/i.test(String(commit))) return none('no trusted commit is known, so no instructions were copied');
  const ls = await git(top, ['ls-tree', '-z', commit, '--', 'CLAUDE.md']);
  if (!ls.ok) return none(`trusted CLAUDE.md unreadable: git ls-tree failed: ${firstLine(ls)}`);
  const entry = ls.stdout.split('\0')[0];
  if (!entry) return none('no CLAUDE.md in the trusted commit');
  const m = /^(\d+) (\w+) ([0-9a-f]+)\t/.exec(entry);
  if (!m || m[2] !== 'blob') return none('CLAUDE.md in the trusted commit is not a regular file');
  if (m[1] === '120000') return none('CLAUDE.md in the trusted commit is a symbolic link, so it was not copied');
  const blob = await catBlob(top, m[3]);
  if (!blob.ok) return none(`trusted CLAUDE.md unreadable: git cat-file failed: ${firstLine(blob)}`);
  return { ...writeCopy(blob.bytes, dir), source };
}

// Adoption: what an earlier spawn left in the data dir. Never reads the worktree; a worker spawned
// before this step, or from a worktree with no CLAUDE.md, has no copy and launches without one.
function existingInstructions(dir) {
  const target = path.join(dir, INSTRUCTIONS_FILE);
  let bytes;
  try {
    bytes = fs.readFileSync(target);
  } catch {
    return { path: null, reason: 'no spawn copy' };
  }
  return { path: target.replace(/\\/g, '/'), bytes: bytes.length, sha256: sha256(bytes) };
}

// The three fields a spawn/restart/resume result carries.
function instructionsFields(i) {
  if (!i) return null; // a Codex worker: this step does not touch it
  const { source, ...rest } = i; // eslint-disable-line no-unused-vars
  return rest;
}

module.exports = { INSTRUCTIONS_FILE, snapshotInstructions, snapshotTrusted, existingInstructions, instructionsFields };
