'use strict';
// review-scratch.cjs — ADR 0054 amendment 1 (the operator, 2026-10-25): a reviewer's scratch folder, outside every worktree, at
// <data>/workers/<reviewer id>/scratch/. A reviewer has Edit and Write so its probes go to disk, not through a Bash heredoc
// (this host mangles backslashes in those); the tree it judges stays read-only by the prompt and by detection (review-tree.cjs).
// The run manager makes the folder at spawn and names it in the first message; the core records its size at the hand-back
// (flagged past 50 MB, never cut); `belay run` deletes the run's scratch folders at close, unless the run lever
// `keep_review_scratch` keeps them, and says in its receipt what it removed. Every path goes through the core's
// scratch-dir.cjs checks, so a worker directory or folder that is a link (a junction) is never followed, emptied or
// deleted. Never throws.

const fs = require('node:fs');
const path = require('node:path');
const SD = require('../core/scratch-dir.cjs'); // one layout and one set of link checks, shared with the core's hand-back

// The folder, made for this run (an older run's leftover under a reused id is emptied first). Returns its path, or null when
// the worker directory is not a real directory under <data>/workers or the folder's place is taken by a link.
function ensure(dataDir, workerId, runId) {
  const own = path.join(SD.workersRoot(dataDir), String(workerId));
  try { if (!fs.existsSync(own) && !isLink(own)) fs.mkdirSync(own, { recursive: true }); } catch { return null; } // the run manager has made it; a caller with none gets one
  const wd = SD.workerDir(dataDir, workerId);
  if (!wd) return null;
  const dir = path.join(wd, 'scratch');
  try {
    if (fs.existsSync(dir) || isLink(dir)) {
      if (!SD.scratchDir(dataDir, workerId)) return null; // a link where the folder goes: left alone, and no folder is named
      fs.rmSync(dir, { recursive: true, force: true });
    }
    fs.mkdirSync(dir);
    const mark = path.join(wd, SD.RUN_MARK);
    fs.rmSync(mark, { force: true }); // a link planted as the marker is removed, never written through
    fs.writeFileSync(mark, String(runId), { flag: 'wx' });
    return SD.scratchDir(dataDir, workerId);
  } catch { return null; }
}

function isLink(p) { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } }

// The first message's line naming the folder.
const firstLine = (dir) => `\n\nYour scratch folder, outside the tree under review: ${dir}. Write probes and scratch files only there.`;

// Run close: remove every scratch folder this run made, or keep them with the lever. The receipt's `review_scratch` block,
// or {} when the run made none. A worker directory or folder that fails the link checks is never touched; it is named.
function closeRun(dataDir, runId, levers) {
  const keep = !!(levers && levers.keep_review_scratch === true);
  let ids = [];
  try { ids = fs.readdirSync(SD.workersRoot(dataDir)).filter((id) => SD.markOf(dataDir, id) === String(runId)); } catch { return {}; }
  if (!ids.length) return {};
  const folders = [];
  for (const id of ids.sort()) {
    const dir = SD.scratchDir(dataDir, id);
    if (!dir) { folders.push({ worker_id: id, path: SD.scratchOf(dataDir, id), bytes: 0, files: 0, removed: false, error: 'not a real directory under the data directory\'s workers folder, so it was left alone' }); continue; }
    const size = SD.measure(dir);
    let removed = false, error = null;
    if (!keep) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(path.join(SD.workerDir(dataDir, id) || dir, SD.RUN_MARK), { force: true });
        removed = !fs.existsSync(dir);
      } catch (e) { error = (e && e.code) || String(e); }
    }
    folders.push({ worker_id: id, path: dir, ...size, removed, ...(error ? { error } : {}) });
  }
  const gone = folders.filter((f) => f.removed);
  return { review_scratch: { kept: keep, folders, removed_folders: gone.length, removed_bytes: gone.reduce((n, f) => n + f.bytes, 0) } };
}

// The text receipt's line, when the run made scratch folders.
function lines(receipt) {
  const s = receipt && receipt.review_scratch;
  if (!s) return [];
  return [s.kept ? `review scratch: kept ${s.folders.length} folder(s) (keep_review_scratch)` : `review scratch: removed ${s.removed_folders} folder(s), ${s.removed_bytes} bytes`];
}

module.exports = { ensure, firstLine, closeRun, lines, scratchOf: SD.scratchOf, RUN_MARK: SD.RUN_MARK };
