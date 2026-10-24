'use strict';
// note-paths.cjs — a note's `applies_to`, derived by belay and never typed by the worker. At hand-back the core reads the
// worker's worktree (git diff from the worker row's base_sha to HEAD, plus the working tree's status), takes the paths the
// note's own evidence names, and merges both with any the worker stated. The result records where each path came from:
// `worker`, `evidence` or `diff`. A diff that cannot be read is named in the result and the note is stored without those
// paths; nothing is guessed. Priority when the cap bites: worker, then evidence, then diff (sorted), so what a person
// wrote is never displaced by what a tool found.

const fs = require('node:fs');
const { runCommand, parseNameStatusZ, parsePorcelainZ } = require('./evaluate.cjs');

const APPLIES_MAX = 16;
const ITEM_MAX = 300;
const GIT_BOUND_MS = 15000;

const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '').trim();

// The changed files of a worker's worktree: committed since its base, plus uncommitted and untracked. Never throws.
// { paths, error }: error is a sentence when the diff could not be read (then paths holds what could be).
async function workerDiff(worktree, baseSha) {
  if (!worktree) return { paths: [], error: 'the worker row names no worktree' };
  if (!fs.existsSync(String(worktree))) return { paths: [], error: `worktree ${worktree} does not exist` };
  const paths = new Set();
  let error = null;
  if (baseSha) {
    const d = await runCommand(['git', 'diff', '--name-status', '-z', '-M', baseSha, 'HEAD'], String(worktree), GIT_BOUND_MS);
    if (!d.executable || d.exit_code !== 0) error = `git diff ${String(baseSha).slice(0, 12)}..HEAD exited ${d.exit_code}: ${String(d.stderr || d.spawn_error || '').trim().slice(0, 160)}`;
    else for (const p of parseNameStatusZ(d.stdout)) paths.add(norm(p));
  } else error = 'the worker row has no base_sha, so only uncommitted changes were read';
  const s = await runCommand(['git', '--no-optional-locks', 'status', '--porcelain', '-z', '--untracked-files=all'], String(worktree), GIT_BOUND_MS);
  if (!s.executable || s.exit_code !== 0) error = `${error ? `${error}; ` : ''}git status exited ${s.exit_code}: ${String(s.stderr || s.spawn_error || '').trim().slice(0, 160)}`;
  else for (const p of parsePorcelainZ(s.stdout)) paths.add(norm(p));
  return { paths: [...paths].filter(Boolean).sort(), error };
}

// Paths an evidence `where` names: "src/a.js:12", "tests/b.test.cjs (line 4)", "see docs/x.md". A token counts only when it is
// path-shaped: it holds a directory separator, or it is name.ext with an extension of letters. A URL, a flag, a bare word, a
// number ("22.1", "v1.2.3") and an abbreviation ("e.g", "i.e") do not.
const NOT_PATHS = new Set(['e.g', 'i.e', 'etc', 'vs']);
function evidencePaths(evidence, worktree) {
  const out = [];
  const root = worktree ? norm(worktree).replace(/\/+$/, '') + '/' : null;
  for (const e of evidence || []) {
    for (const raw of String(e && e.where || '').split(/[\s,;]+/)) {
      let t = raw.replace(/^[`'"(\[<]+|[`'")\]>.,]+$/g, '').replace(/(:\d+){1,2}$/, '').replace(/#L\d+.*$/, '');
      if (!t || t.includes('://') || t.startsWith('-')) continue;
      t = norm(t);
      if (root && t.toLowerCase().startsWith(root.toLowerCase())) t = t.slice(root.length);
      if (/^[A-Za-z]:/.test(t) || t.startsWith('/') || t.startsWith('..')) continue;
      if (NOT_PATHS.has(t.toLowerCase())) continue;
      if (!(t.includes('/') || /^[\w-][\w.-]*\.[A-Za-z]+$/.test(t))) continue;
      if (t.length <= ITEM_MAX) out.push(t);
    }
  }
  return out;
}

// The task's whole diff is not the note's: a task writes several unrelated notes, and giving each every file would make them look
// alike to the path facts. A diff file belongs to a note only when the note's own title or evidence names it, on a boundary:
//   - its full repo path, not part of a longer name ("src/a.js" is not in "src/a.json" or "data/src/a.js");
//   - or its file name, as a whole token ("a.js" is not in "data.js"), and only when exactly one changed file has that name:
//     a bare "index.cjs" with two changed index.cjs attaches none and is recorded as ambiguous.
// The whole list is kept apart, as `task_files`, bounded by bytes.
const TASK_FILES_BYTES = 1800;
const APPLIES_BYTES = 1400;
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function haystack(note, worktree) {
  const hay = [note.title, ...(note.evidence || []).flatMap((e) => [e && e.where, e && e.saw])].filter((t) => typeof t === 'string').join(' ').split('\\').join('/').toLowerCase();
  // An absolute path names the same file as the relative one: the worktree root is taken off, as evidence paths already do.
  const root = worktree ? norm(worktree).replace(/\/+$/, '').toLowerCase() + '/' : null;
  return root ? hay.split(root).join('') : hay;
}
function tokensOf(hay) {
  return new Set(hay.split(/[\s,;()[\]`'"<>]+/).map((t) => t.replace(/(:\d+){1,2}$/, '').replace(/[.:]+$/, '')).filter(Boolean));
}
function namedFiles(note, paths, worktree) {
  const hay = haystack(note, worktree), tokens = tokensOf(hay);
  const named = [], ambiguous = [];
  const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1).toLowerCase();
  const counts = new Map();
  for (const p of paths) counts.set(baseOf(p), (counts.get(baseOf(p)) || 0) + 1);
  const flagged = new Set();
  for (const p of paths) {
    const full = p.toLowerCase();
    if (new RegExp(`(^|[^a-z0-9_./-])${esc(full)}(?![a-z0-9_-]|\\.[a-z0-9])`).test(hay)) { named.push(p); continue; }
    const base = baseOf(p);
    if (!tokens.has(base)) continue;
    if (counts.get(base) > 1) { if (!flagged.has(base)) { flagged.add(base); ambiguous.push(base); } continue; }
    named.push(p);
  }
  return { named, ambiguous };
}

// { applies_to, applies_to_from, task_files, task_files_truncated, ambiguous, counts }: the note's own paths and, aligned with them,
// where each came from (the writer's role, evidence, or diff for a diff file the note names); and the task's whole diff list, apart.
// `writer` is the writing caller's role (B10: an orchestrator's own paths were labelled worker), default worker.
// Both lists are cut by bytes (what belay adds is bounded; what the worker wrote is checked separately and never cut here).
function merge(note, diff, worktree, writer = 'worker') {
  const seen = new Map();
  const add = (p, from) => { const k = norm(p); if (k && !seen.has(k)) seen.set(k, from); };
  for (const p of note.applies_to || []) add(p, writer);
  for (const p of evidencePaths(note.evidence, worktree)) add(p, 'evidence');
  const taskFiles = (diff && diff.paths) || [];
  const { named, ambiguous } = namedFiles(note, taskFiles, worktree);
  for (const p of named) add(p, 'diff');
  const all = [...seen.entries()];
  const kept = [];
  let bytes = 0;
  for (const e of all) {
    const b = Buffer.byteLength(e[0]) + 4;
    if (kept.length >= APPLIES_MAX || (e[1] !== writer && bytes + b > APPLIES_BYTES)) continue;
    kept.push(e); bytes += b;
  }
  const files = [];
  let fb = 0;
  for (const p of taskFiles) { const b = Buffer.byteLength(p) + 4; if (fb + b > TASK_FILES_BYTES) break; files.push(p); fb += b; }
  const counts = { total: kept.length, worker: 0, evidence: 0, diff: 0, dropped: all.length - kept.length, task_files: taskFiles.length };
  for (const [, from] of kept) counts[from] = (counts[from] || 0) + 1;
  if (ambiguous.length) counts.ambiguous = ambiguous;
  return { applies_to: kept.map(([p]) => p), applies_to_from: kept.map(([, from]) => from), task_files: files, task_files_truncated: taskFiles.length - files.length, ambiguous, counts };
}

module.exports = { workerDiff, evidencePaths, namedFiles, merge, APPLIES_MAX, TASK_FILES_BYTES, APPLIES_BYTES };
