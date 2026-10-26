'use strict';
// review-scratch.cjs — ADR 0054 amendment 1 (the operator, 2026-10-25): a reviewer's scratch folder, outside every worktree and
// apart from every worker's own directory, at <data>/scratch/<run id>/<reviewer id>/ (the root holds no transcript and no
// store file). A reviewer has Edit and Write so its probes go to disk, not through a Bash heredoc (this host mangles
// backslashes in those); the tree it judges stays read-only by the prompt and by detection (review-tree.cjs).
// The run manager makes the folder at spawn and names it in the first message; the core records its size at the hand-back
// (flagged past 50 MB, never cut); `belay run` deletes the run's folder at close, unless the run lever
// `keep_review_scratch` keeps it, and says in its receipt what it removed. Every path goes through the core's
// scratch-dir.cjs checks, and a delete never acts on a path it checked earlier: removeChecked renames the checked folder
// into <data>/scratch, then removes it only if it still has the identity the check saw. Never throws.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const SD = require('../core/scratch-dir.cjs'); // one layout and one set of link checks, shared with the core's hand-back

const codeOf = (e) => (e && e.code) || String(e);

// Removes `dir`, a folder whose identity `id` a check just took. It is renamed to <data>/scratch/.gone-<dev>-<ino>-<uuid>,
// measured there (the receipt's bytes are of what was moved, never of a path that could be swapped before the remove), and
// removed only if the renamed entry is still a real directory with that identity. Otherwise it is renamed back if it can be,
// and left alone. `{ removed, bytes, files, error? }`.
function removeChecked(dataDir, dir, id) {
  const root = SD.rootDir(dataDir);
  if (!root || !id) return { removed: false, bytes: 0, files: 0, error: 'not a real directory under a real scratch folder, so it was left alone' };
  const gone = path.join(root, SD.goneName(id, crypto.randomUUID()));
  const moved = renameRetry(dir, gone);
  if (moved !== true) return { removed: false, bytes: 0, files: 0, error: `it could not be moved aside (${moved}), so it was left alone` };
  return removeGone(gone, id, dir);
}

// An open handle (an editor, an indexer, a scanner) makes a rename fail for a moment on Windows: a few short tries, then the
// code. True when it moved.
const RENAME_TRIES = 3, RENAME_WAIT_MS = 100, BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);
function renameRetry(from, to) {
  for (let i = 1; ; i += 1) {
    try { fs.renameSync(from, to); return true; } catch (e) {
      if (i >= RENAME_TRIES || !BUSY.has(e && e.code)) return codeOf(e);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_WAIT_MS);
    }
  }
}

// The second half: `gone` is a renamed entry that should have identity `id`. `back` is where it came from (null for a sweep).
function removeGone(gone, id, back) {
  const size = SD.measure(gone) || { bytes: 0, files: 0 };
  if (!SD.sameId(SD.identity(gone), id)) {
    let where = 'left where it was moved, ' + gone.split(path.sep).join('/');
    if (back) { try { fs.renameSync(gone, back); where = 'moved back'; } catch { /* stays aside, named */ } }
    return { removed: false, ...size, error: `it changed between the check and the removal (not the folder that was checked), so it was ${where}` };
  }
  try { fs.rmSync(gone, { recursive: true, force: true }); } catch (e) { return { removed: false, ...size, error: codeOf(e) }; }
  return { removed: !fs.existsSync(gone), ...size };
}

// A `.gone-` entry a crash left between the rename and the remove: removed under the same identity rule, else named.
function sweep(dataDir) {
  const root = SD.rootDir(dataDir);
  if (!root) return [];
  let names = [];
  try { names = fs.readdirSync(root).filter(SD.isGone); } catch { return []; }
  return names.sort().map((n) => ({ entry: n, ...removeGone(path.join(root, n), SD.goneId(n), null) }));
}

// The folder, made for this run (an older leftover under a reused id is removed first, as at a close). Returns its path, or
// null when the scratch root or the run's folder is not a real directory or the folder's place is a link.
function ensure(dataDir, workerId, runId) {
  if (!SD.segment(workerId) || !SD.segment(runId)) return null;
  try {
    const root = SD.scratchRoot(dataDir);
    if (!fs.existsSync(root) && !isLink(root)) fs.mkdirSync(root, { recursive: true });
    if (!SD.rootDir(dataDir)) return null; // a link where the scratch root goes: nothing is made through it
    const own = path.join(root, String(runId));
    if (!fs.existsSync(own) && !isLink(own)) fs.mkdirSync(own);
    if (!SD.runDir(dataDir, runId)) return null;
    const dir = path.join(own, String(workerId));
    if (fs.existsSync(dir) || isLink(dir)) {
      const id0 = SD.identity(dir); // taken BEFORE the check: a swap after it cannot lend its identity
      const checked = SD.scratchDir(dataDir, runId, workerId);
      if (!checked) return null; // a link where the folder goes: left alone, and no folder is named
      if (!removeChecked(dataDir, checked, id0).removed) return null;
    }
    fs.mkdirSync(dir);
    const checked = SD.scratchDir(dataDir, runId, workerId);
    if (!checked) return null; // the run folder was swapped after its check: nothing is removed (the path may now be in another tree), and no folder is named
    return checked;
  } catch { return null; }
}

function isLink(p) { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } }

// The first message's line naming the folder.
const firstLine = (dir) => `\n\nYour scratch folder, outside the tree under review: ${dir}. Write probes and scratch files only there.`;

// The line naming the tree a review judges when the reviewer's working directory is another: a reused reviewer, or one spawned
// elsewhere, would otherwise read and run in its own cwd. `review` is the core's assign answer block ({ tree, cwd }).
const flat = (d) => String(d).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const sameDir = (a, b) => flat(a) === flat(b);
const treeLine = (review) => review && review.tree && review.cwd && !sameDir(review.tree, review.cwd)
  ? `\n\nReview the tree at ${review.tree} (your working directory is ${review.cwd}); cd there before you read or run anything.` : '';

// Run close: remove every scratch folder this run made, or keep them with the lever, after sweeping `.gone-` leftovers. The
// receipt's `review_scratch` block, or {} when there was nothing. A folder that fails a check is never touched; it is named.
// The run's own (empty) folder is removed when every folder in it went; a non-empty one is never removed.
function closeRun(dataDir, runId, levers) {
  const keep = !!(levers && levers.keep_review_scratch === true);
  const swept = sweep(dataDir);
  const rd = SD.runDir(dataDir, runId);
  if (!rd && !swept.length && SD.segment(runId)) {
    const root = SD.rootDir(dataDir);
    let near = null;
    try { near = root ? fs.readdirSync(root).find((n) => n.toLowerCase() === String(runId).toLowerCase() && n !== String(runId)) : null; } catch { near = null; }
    if (near) return { review_scratch: { kept: !!(levers && levers.keep_review_scratch === true), folders: [], removed_folders: 0, removed_bytes: 0, error: `the scratch folder "${near}" differs from the run id "${runId}" only by case, so it was left alone` } };
  }
  let ids = [];
  if (rd) { try { ids = fs.readdirSync(rd).filter(SD.segment); } catch { ids = []; } }
  if (!ids.length && !swept.length) return {};
  const folders = [];
  for (const id of ids.sort()) {
    const id0 = SD.identity(path.join(rd, id)); // taken BEFORE the check, so a swap right after it is caught at the remove
    const dir = SD.scratchDir(dataDir, runId, id);
    if (!dir) { folders.push({ worker_id: id, path: SD.scratchOf(dataDir, runId, id), bytes: 0, files: 0, removed: false, error: 'not a real directory under the scratch folder of the data directory, so it was left alone' }); continue; }
    if (keep) { folders.push({ worker_id: id, path: dir, ...(SD.measure(dir) || { bytes: 0, files: 0 }), removed: false }); continue; }
    folders.push({ worker_id: id, path: dir, ...removeChecked(dataDir, dir, id0) });
  }
  if (!keep && folders.every((f) => f.removed)) { try { if (SD.runDir(dataDir, runId)) fs.rmdirSync(rd); } catch { /* not empty, or gone: left */ } }
  const gone = folders.filter((f) => f.removed);
  return { review_scratch: { kept: keep, folders, removed_folders: gone.length, removed_bytes: gone.reduce((n, f) => n + f.bytes, 0), ...(swept.length ? { swept } : {}) } };
}

// The text receipt's line, when the run made scratch folders.
function lines(receipt) {
  const s = receipt && receipt.review_scratch;
  if (!s) return [];
  if (s.error) return [`review scratch: ${s.error}`];
  return [s.kept ? `review scratch: kept ${s.folders.length} folder(s) (keep_review_scratch)` : `review scratch: removed ${s.removed_folders} folder(s), ${s.removed_bytes} bytes`];
}

module.exports = { ensure, firstLine, treeLine, closeRun, lines, removeChecked, renameRetry, sweep, scratchOf: SD.scratchOf };
