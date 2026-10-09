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
  const target = path.join(dir, INSTRUCTIONS_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, target);
  return { path: target.replace(/\\/g, '/'), bytes: bytes.length, sha256: sha256(bytes), source };
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

module.exports = { INSTRUCTIONS_FILE, snapshotInstructions, existingInstructions, instructionsFields };
