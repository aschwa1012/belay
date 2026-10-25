'use strict';
// scratch-dir.cjs — ADR 0054 amendment 1: a reviewer's scratch folder, <data>/scratch/<run id>/<worker id>/. The root holds no
// worker transcript and no store file, so a reviewer that lists it finds only scratch folders (never a coder's stream.jsonl,
// which lives under <data>/workers). Every read, write and delete goes through the checks here, so nothing is reached through a
// link: <data>/scratch, the run's folder and the worker's folder must each be a real directory by lstat (not a symlink, and not
// a junction, which Node reports as a symlink), and the folder's real path must lie under the real path of <data>/scratch. A
// data directory reached through a link higher up still works: only the scratch root and what is in it are held to lstat. A
// delete is a rename into <data>/scratch/.gone-<dev>-<ino>-<uuid> and a remove only of what still has the identity (device and
// inode) the check saw (review-scratch.cjs removeChecked); a `.gone-` entry is never a run. The walk that measures a folder
// follows no link inside it, and its answer stands only if the folder kept its identity. Pure fs; never throws.

const fs = require('node:fs');
const path = require('node:path');

const SCRATCH_FLAG_BYTES = 50 * 1024 * 1024;
const GONE = '.gone-';
const fwd = (p) => String(p).split(path.sep).join('/');

const scratchRoot = (dataDir) => path.join(String(dataDir), 'scratch');
const isGone = (name) => String(name).startsWith(GONE);
// A name that is one path segment: the run id and the worker id are joined into a path here, so neither may climb out.
const segment = (n) => typeof n === 'string' && n !== '' && n !== '.' && n !== '..' && !/[\\/:\x00]/.test(n) && !isGone(n);
const scratchOf = (dataDir, runId, workerId) => fwd(path.join(scratchRoot(dataDir), String(runId), String(workerId)));

function realDir(p) {
  try { const s = fs.lstatSync(p); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; }
}

// `{ dev, ino }` (bigint) of a real directory, or null for a link, a file or nothing.
function identity(p) {
  try { const s = fs.lstatSync(p, { bigint: true }); return s.isDirectory() && !s.isSymbolicLink() ? { dev: s.dev, ino: s.ino } : null; } catch { return null; }
}
const sameId = (a, b) => !!(a && b && a.dev === b.dev && a.ino === b.ino);

// True when `p`'s real path is strictly under `root`'s real path.
function under(p, root) {
  try {
    const rel = path.relative(fs.realpathSync.native(root), fs.realpathSync.native(p));
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch { return false; }
}

// <data>/scratch when it is a real directory (not itself a link), else null.
function rootDir(dataDir) {
  const root = scratchRoot(dataDir);
  return realDir(root) ? root : null;
}

// The run's folder when it is a real directory under a real <data>/scratch, else null. A `.gone-` name is never one.
function runDir(dataDir, runId) {
  if (!segment(runId)) return null;
  const root = rootDir(dataDir);
  if (!root) return null;
  const rd = path.join(root, String(runId));
  return realDir(rd) && under(rd, root) ? rd : null;
}

// The scratch folder's path when it exists as a real directory inside a real run folder, else null.
function scratchDir(dataDir, runId, workerId) {
  if (!segment(workerId)) return null;
  const rd = runDir(dataDir, runId);
  if (!rd) return null;
  const dir = path.join(rd, String(workerId));
  return realDir(dir) && under(dir, scratchRoot(dataDir)) ? fwd(dir) : null;
}

// Bytes and files under a checked folder, following no link; null when `dir` is not a real directory, or when it did not
// keep its identity through the walk (it was swapped for something else while it was read).
function measure(dir) {
  if (!dir) return null;
  const before = identity(dir);
  if (!before) return null;
  let bytes = 0, files = 0;
  const walk = (d) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { try { bytes += fs.lstatSync(p).size; files += 1; } catch { /* gone */ } }
    }
  };
  walk(dir);
  return sameId(before, identity(dir)) ? { bytes, files } : null;
}

// The hand-back's `scratch`, or null when the worker has no checked folder.
function facts(dataDir, runId, workerId) {
  if (!dataDir || !runId || !workerId) return null;
  const dir = scratchDir(dataDir, runId, workerId);
  const m = module.exports.measure(dir);
  return m ? { path: dir, ...m, over_limit: m.bytes > SCRATCH_FLAG_BYTES, limit_bytes: SCRATCH_FLAG_BYTES } : null;
}

// A `.gone-` name carrying the identity the check saw, so a sweep after a crash can hold a leftover to the same rule.
const goneName = (id, uuid) => `${GONE}${id.dev}-${id.ino}-${uuid}`;
function goneId(name) {
  const m = /^\.gone-(\d+)-(\d+)-/.exec(String(name));
  return m ? { dev: BigInt(m[1]), ino: BigInt(m[2]) } : null;
}

module.exports = { SCRATCH_FLAG_BYTES, GONE, scratchRoot, scratchOf, isGone, segment, realDir, identity, sameId, under, rootDir, runDir, scratchDir, measure, facts, goneName, goneId };
