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
  const s = await runCommand(['git', 'status', '--porcelain', '-z', '--untracked-files=all'], String(worktree), GIT_BOUND_MS);
  if (!s.executable || s.exit_code !== 0) error = `${error ? `${error}; ` : ''}git status exited ${s.exit_code}: ${String(s.stderr || s.spawn_error || '').trim().slice(0, 160)}`;
  else for (const p of parsePorcelainZ(s.stdout)) paths.add(norm(p));
  return { paths: [...paths].filter(Boolean).sort(), error };
}

// Paths an evidence `where` names: "src/a.js:12", "tests/b.test.cjs (line 4)", "see docs/x.md". A token counts when it has a
// directory separator or a file extension; a URL, a flag and a bare word do not.
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
      if (!(t.includes('/') || /^[\w.-]+\.[A-Za-z0-9]{1,8}$/.test(t))) continue;
      if (t.length <= ITEM_MAX) out.push(t);
    }
  }
  return out;
}

// The task's whole diff is not the note's: a task writes several unrelated notes, and giving each every file would make them look
// alike to the path facts. A diff file belongs to a note only when the note's own title or evidence names it (its full path, or its
// file name when that is at least 4 characters). The whole list is kept apart, as `task_files`.
const TASK_FILES_MAX = 30;
function namedBy(note, p) {
  const hay = [note.title, ...(note.evidence || []).flatMap((e) => [e && e.where, e && e.saw])].filter((t) => typeof t === 'string').join(' ').split('\\').join('/').toLowerCase();
  const full = p.toLowerCase();
  const base = full.slice(full.lastIndexOf('/') + 1);
  return hay.includes(full) || (base.length >= 4 && hay.includes(base));
}

// { applies_to, applies_to_from, task_files, counts }: the note's own paths and, aligned with them, where each came from
// (worker, evidence, or diff for a diff file the note names); and the task's whole diff list, apart.
function merge(note, diff, worktree) {
  const seen = new Map();
  const add = (p, from) => { const k = norm(p); if (k && !seen.has(k)) seen.set(k, from); };
  for (const p of note.applies_to || []) add(p, 'worker');
  for (const p of evidencePaths(note.evidence, worktree)) add(p, 'evidence');
  const taskFiles = (diff && diff.paths) || [];
  for (const p of taskFiles) if (namedBy(note, p)) add(p, 'diff');
  const all = [...seen.entries()];
  const kept = all.slice(0, APPLIES_MAX);
  const counts = { total: kept.length, worker: 0, evidence: 0, diff: 0, dropped: all.length - kept.length, task_files: taskFiles.length };
  for (const [, from] of kept) counts[from]++;
  return { applies_to: kept.map(([p]) => p), applies_to_from: kept.map(([, from]) => from), task_files: taskFiles.slice(0, TASK_FILES_MAX), counts };
}

module.exports = { workerDiff, evidencePaths, merge, APPLIES_MAX, TASK_FILES_MAX };
