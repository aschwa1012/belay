'use strict';
// review-scratch.cjs — ADR 0054 amendment 1 (the operator, 2026-10-25): a reviewer's scratch folder, outside every worktree, at
// <data>/workers/<reviewer id>/scratch/. A reviewer has Edit and Write so its probes go to disk, not through a Bash heredoc
// (this host mangles backslashes in those); the tree it judges stays read-only by the prompt and by detection (review-tree.cjs).
// The run manager makes the folder at spawn and names it in the first message; the core records its size at the hand-back
// (flagged past 50 MB, never cut); `belay run` deletes the run's scratch folders at close, unless the run lever
// `keep_review_scratch` keeps them, and says in its receipt what it removed. Never throws.

const fs = require('node:fs');
const path = require('node:path');

const RUN_MARK = 'scratch-run.txt'; // beside scratch/: the run that made it, so a close removes only its own run's folders

const { scratchOf, measure } = require('../core/review-tree.cjs'); // the core measures the folder at the hand-back; one layout

// The folder, made for this run (an older run's leftover under a reused id is emptied first). Returns its path, or null.
function ensure(dataDir, workerId, runId) {
  const dir = scratchOf(dataDir, workerId);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(path.dirname(dir), RUN_MARK), String(runId));
    return dir;
  } catch { return null; }
}

// The first message's line naming the folder.
const firstLine = (dir) => `\n\nYour scratch folder, outside the tree under review: ${dir}. Write probes and scratch files only there.`;

// Run close: remove every scratch folder this run made, or keep them with the lever. The receipt's `review_scratch` block,
// or {} when the run made none.
function closeRun(dataDir, runId, levers) {
  const keep = !!(levers && levers.keep_review_scratch === true);
  const root = path.join(dataDir, 'workers');
  let ids = [];
  try { ids = fs.readdirSync(root).filter((id) => { try { return fs.readFileSync(path.join(root, id, RUN_MARK), 'utf8') === String(runId); } catch { return false; } }); } catch { return {}; }
  if (!ids.length) return {};
  const folders = [];
  for (const id of ids.sort()) {
    const dir = scratchOf(dataDir, id);
    const size = measure(dir) || { bytes: 0, files: 0 };
    let removed = false, error = null;
    if (!keep) {
      try { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(path.join(root, id, RUN_MARK), { force: true }); removed = !fs.existsSync(dir); } catch (e) { error = (e && e.code) || String(e); }
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

module.exports = { scratchOf, ensure, firstLine, measure, closeRun, lines, RUN_MARK };
