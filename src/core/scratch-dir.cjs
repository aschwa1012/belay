'use strict';
// scratch-dir.cjs — ADR 0054 amendment 1: a reviewer's scratch folder, <data>/workers/<id>/scratch/, beside the run marker
// `scratch-run.txt`. Every read, write and delete of either goes through the checks here, so nothing is reached through a
// link: the worker's directory and the scratch folder must each be a real directory by lstat (not a symlink, and not a
// junction, which Node reports as a symlink), and the folder's real path must lie under the real path of <data>/workers. A
// worker directory planted as a junction to somewhere else is therefore never read, measured or emptied. The walk that
// measures a folder follows no link inside it either. Pure fs; never throws.

const fs = require('node:fs');
const path = require('node:path');

const SCRATCH_FLAG_BYTES = 50 * 1024 * 1024;
const RUN_MARK = 'scratch-run.txt';
const fwd = (p) => String(p).split(path.sep).join('/');

const workersRoot = (dataDir) => path.join(String(dataDir), 'workers');
const scratchOf = (dataDir, workerId) => fwd(path.join(workersRoot(dataDir), String(workerId), 'scratch'));

function realDir(p) {
  try { const s = fs.lstatSync(p); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; }
}

// True when `p`'s real path is strictly under `root`'s real path.
function under(p, root) {
  try {
    const rel = path.relative(fs.realpathSync.native(root), fs.realpathSync.native(p));
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch { return false; }
}

// The worker's directory when it is a real directory under <data>/workers, else null.
function workerDir(dataDir, workerId) {
  const root = workersRoot(dataDir), wd = path.join(root, String(workerId));
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

// Bytes and files under a checked folder, following no link; null when `dir` is not one.
function measure(dir) {
  if (!dir) return null;
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
  return { bytes, files };
}

// The hand-back's `scratch`, or null when the worker has no checked folder.
function facts(dataDir, workerId) {
  if (!dataDir || !workerId) return null;
  const dir = scratchDir(dataDir, workerId);
  const m = measure(dir);
  return m ? { path: dir, ...m, over_limit: m.bytes > SCRATCH_FLAG_BYTES, limit_bytes: SCRATCH_FLAG_BYTES } : null;
}

module.exports = { SCRATCH_FLAG_BYTES, RUN_MARK, workersRoot, scratchOf, realDir, under, workerDir, scratchDir, markOf, measure, facts };
