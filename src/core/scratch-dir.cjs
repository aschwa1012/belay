'use strict';
// scratch-dir.cjs — ADR 0054 amendment 1: a reviewer's scratch folder, <data>/workers/<id>/scratch/, beside the run marker
// `scratch-run.txt`. Every read, write and delete of either goes through the checks here, so nothing is reached through a
// link: <data>/workers itself, the worker's directory and the scratch folder must each be a real directory by lstat (not a
// symlink, and not a junction, which Node reports as a symlink), and the folder's real path must lie under the real path of
// <data>/workers. A data directory reached through a link higher up still works: only the workers folder and what is in it
// are held to lstat. A delete is a rename into <data>/workers/.gone-<dev>-<ino>-<uuid> and a remove only of what still has
// the identity (device and inode) the check saw (review-scratch.cjs removeChecked); a `.gone-` entry is never a worker. The
// walk that measures a folder follows no link inside it, and its answer stands only if the folder kept its identity.
// Pure fs; never throws.

const fs = require('node:fs');
const path = require('node:path');

const SCRATCH_FLAG_BYTES = 50 * 1024 * 1024;
const RUN_MARK = 'scratch-run.txt';
const GONE = '.gone-';
const fwd = (p) => String(p).split(path.sep).join('/');

const workersRoot = (dataDir) => path.join(String(dataDir), 'workers');
const scratchOf = (dataDir, workerId) => fwd(path.join(workersRoot(dataDir), String(workerId), 'scratch'));
const isGone = (name) => String(name).startsWith(GONE);

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

// <data>/workers when it is a real directory (not itself a link), else null.
function rootDir(dataDir) {
  const root = workersRoot(dataDir);
  return realDir(root) ? root : null;
}

// The worker's directory when it is a real directory under a real <data>/workers, else null. A `.gone-` name is never one.
function workerDir(dataDir, workerId) {
  if (isGone(workerId)) return null;
  const root = rootDir(dataDir);
  if (!root) return null;
  const wd = path.join(root, String(workerId));
  return realDir(wd) && under(wd, root) ? wd : null;
}

// The scratch folder's path when it exists as a real directory inside a real worker directory, else null.
function scratchDir(dataDir, workerId) {
  const wd = workerDir(dataDir, workerId);
  if (!wd) return null;
  const dir = path.join(wd, 'scratch');
  return realDir(dir) && under(dir, workersRoot(dataDir)) ? fwd(dir) : null;
}

// The run that made the folder, from the marker when it is a plain file in a real worker directory, else null.
function markOf(dataDir, workerId) {
  const wd = workerDir(dataDir, workerId);
  if (!wd) return null;
  const f = path.join(wd, RUN_MARK);
  try { const s = fs.lstatSync(f); return s.isFile() && !s.isSymbolicLink() ? fs.readFileSync(f, 'utf8') : null; } catch { return null; }
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
function facts(dataDir, workerId) {
  if (!dataDir || !workerId) return null;
  const dir = scratchDir(dataDir, workerId);
  const m = module.exports.measure(dir);
  return m ? { path: dir, ...m, over_limit: m.bytes > SCRATCH_FLAG_BYTES, limit_bytes: SCRATCH_FLAG_BYTES } : null;
}

// A `.gone-` name carrying the identity the check saw, so a sweep after a crash can hold a leftover to the same rule.
const goneName = (id, uuid) => `${GONE}${id.dev}-${id.ino}-${uuid}`;
function goneId(name) {
  const m = /^\.gone-(\d+)-(\d+)-/.exec(String(name));
  return m ? { dev: BigInt(m[1]), ino: BigInt(m[2]) } : null;
}

module.exports = { SCRATCH_FLAG_BYTES, RUN_MARK, GONE, workersRoot, scratchOf, isGone, realDir, identity, sameId, under, rootDir, workerDir, scratchDir, markOf, measure, facts, goneName, goneId };
