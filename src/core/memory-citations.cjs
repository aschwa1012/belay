'use strict';
// memory-citations.cjs — safeguard S3 of the notes lifecycle: belay checks that a quote appears verbatim in the
// evidence it names, never what the quote means (the shape of ADR 0044 decision 5's check). A cite is
// { where, quote }, and `where` is one of
//   a path relative to the run's worktree, read at the run's head commit (`git show <head>:<path>`), optionally
//   followed by `:<line>` or `:<line>-<line>`, which is ignored (the quote is what is checked); or
//   `stream:<path>`, where <path> is one of the recorded stream files the caller listed in `evidence_files`.
// Whitespace is collapsed on both sides, so a re-wrapped line still matches; nothing else is relaxed.
// A cite that cannot be checked is refused the same as one that is not found: E_CITATION, naming which and why.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { err } = require('./errors.cjs');
const rows = require('./rows.cjs');

const GIT_BOUND_MS = 10000;
const FILE_MAX = 8 * 1024 * 1024;
const norm = s => String(s).replace(/\s+/g, ' ').trim();
const fwd = p => String(p).split('\\').join('/');
const LINE_SUFFIX = /:\d+(?:-\d+)?$/;

// A file cite reads a blob only: `git show` of a directory prints its tree listing, which would make file names citable.
function gitType(worktree, head, rel) {
  return new Promise(resolve => {
    execFile('git', ['cat-file', '-t', `${head}:${rel}`], { cwd: worktree, timeout: GIT_BOUND_MS, windowsHide: true, encoding: 'utf8' }, (e, stdout) => resolve(e ? null : String(stdout).trim()));
  });
}
async function gitShow(worktree, head, rel) {
  const type = await gitType(worktree, head, rel);
  if (type !== null && type !== 'blob') return { error: `a ${type}, not a file, at` };
  return gitShowBlob(worktree, head, rel);
}
function gitShowBlob(worktree, head, rel) {
  return new Promise(resolve => {
    execFile('git', ['show', `${head}:${rel}`], { cwd: worktree, timeout: GIT_BOUND_MS, maxBuffer: FILE_MAX, windowsHide: true, encoding: 'utf8' },
      (e, stdout) => resolve(e ? { error: e.code === 128 || /exists on disk|does not exist|bad object|unknown revision/i.test(String(e.stderr || e.message)) ? 'not at that commit' : `git did not answer (${e.code || e.signal || 'error'})` } : { text: stdout }));
  });
}

// ---- shared rules (one module for every citation check) ---------------------------------------------------------------
// Evidence is what the world answered, not what belay said back: a tool result whose tool_use is one of belay's own tools
// (`mcp__belay__*`: a hand-back echoes the note's title, a search echoes other notes) never counts. A stream is JSON lines of
// either shape; lines that are not a tool-call record are kept as they are.
const QUOTE_MIN_BYTES = 24; // a shorter quote proves nothing about a claim
const BELAY_TOOL = /^mcp__belay__/;
function blocksOf(line) {
  let j;
  try { j = JSON.parse(line); } catch { return []; }
  const content = j && j.message && j.message.content;
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const b of content) {
    if (!b) continue;
    if (b.type === 'tool_use' && typeof b.id === 'string') out.push({ use: b.id, name: String(b.name || '') });
    if (b.type !== 'tool_result') continue;
    const texts = typeof b.content === 'string' ? [b.content] : Array.isArray(b.content) ? b.content.filter(p => p && typeof p.text === 'string').map(p => p.text) : [];
    for (const text of texts) out.push({ id: b.tool_use_id, text });
  }
  return out;
}
function belayUseIds(lines) {
  const ids = new Set();
  for (const line of lines) if (line.includes('tool_use')) for (const b of blocksOf(line)) if (b.use && BELAY_TOOL.test(b.name)) ids.add(b.use);
  return ids;
}
function withoutBelayResults(raw) {
  const lines = raw.split('\n');
  const ids = belayUseIds(lines);
  if (!ids.size) return raw;
  return lines.filter(line => !(line.includes('tool_result') && blocksOf(line).some(b => b.id !== undefined && ids.has(b.id)))).join('\n');
}
// The note's own words are no evidence about it, in a stream: a quote held by its title, text or evidence, or one that holds its
// title. (A file at the head commit is evidence even when it contains the same words, so files never come here.)
function selfQuoted(own, title, quote) {
  const q = norm(quote).toLowerCase();
  if ((own || []).some(t => norm(t).toLowerCase().includes(q))) return true;
  const t = title ? norm(title).toLowerCase() : '';
  return t.length >= 12 && q.includes(t);
}
// The shape of a cites array, checked before any read. Returns { cites } or { error }.
function checkShape(cites) {
  if (!Array.isArray(cites) || !cites.length) return { error: 'cites must be an array of at least one { where, quote }' };
  if (cites.length > 8) return { error: `cites holds ${cites.length} entries and the most is 8` };
  const out = [];
  for (const [i, c] of cites.entries()) {
    if (c === null || typeof c !== 'object' || Array.isArray(c)) return { error: `cites[${i}] must be an object { where, quote }` };
    for (const k of Object.keys(c)) if (k !== 'where' && k !== 'quote') return { error: `cites[${i}].${k} is not a field; use where and quote` };
    if (typeof c.where !== 'string' || !c.where.trim() || Buffer.byteLength(c.where) > 300) return { error: 'cites[' + i + '].where must be a non-empty string of at most 300 bytes' };
    if (typeof c.quote !== 'string' || Buffer.byteLength(c.quote.trim()) < QUOTE_MIN_BYTES || Buffer.byteLength(c.quote) > 2000) return { error: `cites[${i}].quote must be a string of ${QUOTE_MIN_BYTES} to 2000 bytes: a verbatim line` };
    out.push({ where: c.where.trim(), quote: c.quote });
  }
  return { cites: out };
}

// A review's cites against the evidence one TASK recorded (the note-review route): `where` is "stream" or "stream:<worker id>"
// (a tool result in that task's worker streams) or a repository path read with git at the head commit of a worker of the task.
// note: { title, text, evidence } of the note judged; its own words are refused for stream cites only.
// Returns { ok, failures: [{ index, where, reason }] }.
const seam = { afterCheck: null }; // tests only: lets a test land another review between the check and the write
function streamResultHas(file, quote) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { found: false, reason: `no stream at ${file}` }; }
  if (raw.length > FILE_MAX * 8) return { found: false, reason: 'the stream is too large to search' };
  const lines = raw.split('\n');
  const belay = belayUseIds(lines);
  const q = norm(quote);
  for (const line of lines) {
    if (!line.includes('tool_result')) continue;
    for (const b of blocksOf(line)) if (b.text !== undefined && !(b.id !== undefined && belay.has(b.id)) && norm(b.text).includes(q)) return { found: true };
  }
  return { found: false, reason: 'the quote is in no tool result of that stream (results of belay\'s own tools are not evidence)' };
}
async function checkTaskCites(E, taskId, cites, note = null) {
  const workers = rows.currentAll(E.store, 'worker').filter(w => w.task_id === taskId);
  const own = note ? [note.title, note.when, note.text, ...((note.evidence || []).flatMap(e => [e && e.saw, e && e.where]))].filter(t => typeof t === 'string' && t.trim()) : [];
  const failures = [];
  const fail = (index, where, reason) => failures.push({ index, where, reason });
  for (const [i, c] of cites.entries()) {
    if (c.where === 'stream' || c.where.startsWith('stream:')) {
      if (selfQuoted(own, note && note.title, c.quote)) { fail(i, c.where, 'the quote is the note\'s own text, which cannot be evidence about the note'); continue; }
      const only = c.where === 'stream' ? null : c.where.slice(7);
      const pool = only ? workers.filter(w => w.id === only) : workers;
      if (!pool.length) { fail(i, c.where, only ? `worker ${only} did not work task ${taskId}` : `task ${taskId} has no worker row`); continue; }
      const misses = [];
      let hit = false;
      for (const w of pool) {
        const r = streamResultHas(path.join(E.dataDir, 'workers', w.id, 'stream.jsonl'), c.quote);
        if (r.found) { hit = true; break; }
        misses.push(`${w.id}: ${r.reason}`);
      }
      if (!hit) fail(i, c.where, misses.join('; '));
      continue;
    }
    const rel = fwd(c.where.replace(LINE_SUFFIX, '')).replace(/^\.\//, '');
    if (!relativeOk(rel)) { fail(i, c.where, 'a file cite is a path to a file inside the repository, relative to its root (not "./", not a directory)'); continue; }
    const pool = workers.filter(w => w.head_sha && w.worktree);
    if (!pool.length) { fail(i, c.where, `task ${taskId} has no worker row with a head commit and a worktree, so no file can be read at its head`); continue; }
    let hit = false;
    const misses = [];
    for (const w of pool) {
      const r = await gitShow(w.worktree, w.head_sha, rel);
      if (r.error) { misses.push(`${w.id}: ${r.error}`); continue; }
      if (norm(r.text).includes(norm(c.quote))) { hit = true; break; }
      misses.push(`${w.id}: the quote is not in ${rel} at ${String(w.head_sha).slice(0, 12)}`);
    }
    if (!hit) fail(i, c.where, misses.join('; '));
  }
  if (seam.afterCheck) await seam.afterCheck();
  return { ok: failures.length === 0, failures };
}

function relativeOk(p) {
  if (!p || path.isAbsolute(p) || /^[A-Za-z]:/.test(p) || p.startsWith('/')) return false;
  return !fwd(p).split('/').some(seg => seg === '..' || seg === '');
}

// ctx: { head_sha, worktree, evidence_files: [absolute stream paths] }. Resolves to one { where, source } per cite.
async function checkCitations(cites, ctx) {
  const out = [];
  const cache = new Map();
  const files = (ctx.evidence_files || []).map(fwd);
  for (const [i, c] of cites.entries()) {
    const fail = reason => err('E_CITATION', `cites[${i}] (${c.where}) refused: ${reason}`, { index: i, where: c.where, reason });
    const quote = norm(c.quote);
    let text;
    if (c.where.startsWith('stream:')) {
      const want = fwd(c.where.slice('stream:'.length));
      if (!files.includes(want)) throw fail('that stream file is not among the evidence files named for this call');
      if (!cache.has(c.where)) {
        try {
          const st = fs.statSync(want);
          if (st.size > FILE_MAX) cache.set(c.where, { error: `the stream file is over ${FILE_MAX} bytes` });
          else cache.set(c.where, { text: withoutBelayResults(fs.readFileSync(want, 'utf8')) });
        } catch (e) { cache.set(c.where, { error: `cannot read it (${e.code || e.message})` }); }
      }
      const got = cache.get(c.where);
      if (got.error) throw fail(got.error);
      // A stream carries the note's own index line, and quoting that back proves nothing. A file read at the head commit
      // is evidence even when the note quoted the same line, so this applies to streams only.
      if (selfQuoted(ctx.own, ctx.title, quote)) throw fail('the quote is the note\'s own text, which cannot be evidence about the note');
      // A stream is JSON lines: a quote with a quote mark or a newline in it is stored escaped.
      const escaped = JSON.stringify(c.quote.trim()).slice(1, -1);
      if (!norm(got.text).includes(quote) && !got.text.includes(escaped)) throw fail('the quote does not appear in that stream');
      out.push({ where: c.where, source: 'stream' });
      continue;
    }
    const rel = fwd(c.where.replace(LINE_SUFFIX, ''));
    if (!relativeOk(rel)) throw fail('where must be a path inside the worktree (relative, no ..) or stream:<recorded file>');
    if (!ctx.head_sha || !ctx.worktree) throw fail('no head commit and worktree were given, so a file cannot be read at the run\'s head');
    const key = `${ctx.head_sha}:${rel}`;
    if (!cache.has(key)) cache.set(key, await gitShow(ctx.worktree, ctx.head_sha, rel));
    const got = cache.get(key);
    if (got.error) throw fail(`${rel}: ${got.error} ${ctx.head_sha.slice(0, 12)}`);
    text = got.text;
    if (!norm(text).includes(quote)) throw fail(`the quote does not appear in ${rel} at ${ctx.head_sha.slice(0, 12)}`);
    out.push({ where: c.where, source: `${rel}@${ctx.head_sha.slice(0, 12)}` });
  }
  return out;
}

// The evidence arguments of a call, checked: a head commit, a worktree that exists, absolute stream paths.
function evidenceOf(args) {
  const head = args.head_sha;
  if (head !== undefined && head !== null && !(typeof head === 'string' && /^[0-9a-fA-F]{7,40}$/.test(head))) throw err('E_ARGS', 'head_sha must be 7 to 40 hex digits', { field: 'head_sha' });
  const wt = args.worktree;
  if (wt !== undefined && wt !== null && (typeof wt !== 'string' || !path.isAbsolute(wt))) throw err('E_ARGS', 'worktree must be an absolute path', { field: 'worktree' });
  const ev = args.evidence_files;
  if (ev !== undefined && ev !== null && (!Array.isArray(ev) || ev.length > 50 || ev.some(p => typeof p !== 'string' || !path.isAbsolute(p)))) throw err('E_ARGS', 'evidence_files must be an array of at most 50 absolute paths', { field: 'evidence_files' });
  return { head_sha: head || null, worktree: wt || null, evidence_files: ev || [] };
}

module.exports = { checkCitations, evidenceOf, checkTaskCites, checkShape, selfQuoted, withoutBelayResults, seam, QUOTE_MIN_BYTES };
