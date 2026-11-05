'use strict';
// worker-temp.cjs — ADR 0084 amendment 1: every worker gets its own temp folder, <worker dir>/tmp, made at each launch and removed
// when the run's manager shuts down. buildEnv points TEMP, TMP and TMPDIR at it, so `os.tmpdir()`, `tempfile` and Git Bash's own
// `/tmp` mount land in a folder belay owns instead of the operator's. Never throws: a folder that cannot be made means the worker
// keeps the inherited temp dir (make returns null) and a folder that cannot be removed is left where it is.
const fs = require('node:fs');
const path = require('node:path');

const NAME = 'tmp';

// The folder, made if it is not there. A link in its place is refused (a worker's own `mklink` must not turn the cleanup into a
// delete of another tree), and so is a worker dir that is not a real directory.
function make(workerDir) {
  if (typeof workerDir !== 'string' || !workerDir) return null;
  try {
    const dir = path.join(workerDir, NAME);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const st = fs.lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink() ? path.resolve(dir) : null;
  } catch { return null; }
}

// Bytes under a folder, links not followed.
function size(dir) {
  let n = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      n += e.isDirectory() ? size(p) : (fs.lstatSync(p).size || 0);
    }
  } catch { /* counted as far as it could be read */ }
  return n;
}
// Removes the folder of each worker in the map; a link is unlinked, not followed. `{ removed, bytes, failed }`, bytes counted first.
// Removes the folder of each worker in the map; a link is unlinked, not followed. `{ removed, bytes, failed }`, bytes counted first.
function removeAll(workers) {
  const out = { removed: 0, bytes: 0, failed: [] };
  for (const w of workers.values()) {
    if (!w || !w.dir) continue;
    const dir = path.join(w.dir, NAME);
    let st = null;
    try { st = fs.lstatSync(dir); } catch { continue; }
    try {
      if (st.isSymbolicLink()) { try { fs.unlinkSync(dir); } catch { fs.rmdirSync(dir); } } // a junction goes as a directory entry, never followed
      else { out.bytes += size(dir); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
      out.removed += 1;
    } catch (e) { out.failed.push({ worker_id: w.id, code: (e && e.code) || String(e) }); }
  }
  return out;
}

module.exports = { make, removeAll, NAME };
