'use strict';
// memory-citations.cjs — safeguard S3 of the notes lifecycle: belay checks that a quote appears verbatim in the
// evidence it names, never what the quote means (the shape of ADR 0044 decision 5's check). A cite is
// { where, quote }, and `where` is one of
//   a path relative to the run's worktree, read at the run's head commit (`git show <head>:<path>`), optionally
//   followed by `:<line>` or `:<line>-<line>`, which is ignored (the quote is what is checked); for the note-review route, where the
//   writer may not have committed (a worker's head is recorded only when it settles, and workers do not commit), a file git lists in
//   the worker's working tree is read too; or
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
// A quote of fewer than SHORT_SOLID (6) non-space characters must be a whole line of the evidence (a Read result's "41->" line number is not part of
// the line), so a real short line is citable and a fragment such as "e" is not. It must also be a word, not a bracket: at least SHORT_MIN
// non-space characters with a letter or digit among them, so "done." and "ok" can be cited and "}" and ");" (lines every code file has) cannot.
// Longer quotes may be any span.
const SHORT_SOLID = 6, SHORT_MIN = 2;
const solid = s => s.replace(/\s/g, '').length;
const NUMBERED = /^\s*\d+(?:\u2192|\t|:|\|)\s?/;
const WORDY = /[\p{L}\p{N}]/u;
function wholeLine(raw, q) {
  if (solid(q) < SHORT_MIN || !WORDY.test(q)) return false;
  return String(raw).split(/\r?\n/).some(l => norm(l) === q || norm(l.replace(NUMBERED, '')) === q);
}
// forms: the quote as written and with JSON escapes decoded, whitespace collapsed (quoteForms).
function holds(raw, forms) {
  const t = norm(raw);
  return forms.some(q => (solid(q) >= SHORT_SOLID ? t.includes(q) : wholeLine(raw, q)));
}

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

// The working tree of a worker that has not committed: a file git lists there (tracked, or untracked and not ignored, so a secret in an
// ignored file is not an oracle; git never lists .git), and read only when its real path stays inside the worktree.
async function worktreeShow(worktree, rel) {
  const listed = await new Promise(resolve => {
    execFile('git', ['--literal-pathspecs', 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', rel], { cwd: worktree, timeout: GIT_BOUND_MS, windowsHide: true, encoding: 'utf8' }, (e, stdout) => resolve(e ? null : String(stdout)));
  });
  if (listed === null) return { error: 'git did not answer' };
  if (!listed.split('\0').includes(rel)) return { error: 'not a file git lists in the working tree' };
  try {
    const root = fs.realpathSync(worktree);
    const real = fs.realpathSync(path.join(worktree, rel));
    const within = path.relative(root, real);
    if (!within || within.startsWith('..') || path.isAbsolute(within)) return { error: 'resolves outside the worktree' };
    const st = fs.statSync(real);
    if (!st.isFile()) return { error: 'not a file in the working tree' };
    if (st.size > FILE_MAX) return { error: 'too large to search' };
    return { text: fs.readFileSync(real, 'utf8') };
  } catch { return { error: 'not in the working tree' }; }
}

// ---- shared rules (one module for every citation check) ---------------------------------------------------------------
// Evidence is what the world answered, not what belay said back: a tool result whose tool_use is one of belay's own tools
// (`mcp__belay__*`: a hand-back echoes the note's title, a search echoes other notes) never counts. A stream is JSON lines of
// either shape; lines that are not a tool-call record are kept as they are.
const BELAY_TOOL = /^mcp__belay__/;
function blocksOf(line) {
  let j;
  try { j = JSON.parse(line); } catch { return []; }
  const it = j && j.type === 'item.completed' && j.item && typeof j.item === 'object' ? j.item : null;
  if (it) return codexBlocks(it);
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
// A Codex stream records a finished command as an item.completed line with its output, and a finished MCP call with its result. The output of
// a command is what a tool printed; an MCP call counts unless its server or tool is belay's (a result whose server is not stated is not trusted).
function codexBlocks(it) {
  if (it.type === 'command_execution') return typeof it.aggregated_output === 'string' && it.aggregated_output ? [{ id: it.id, text: it.aggregated_output }] : [];
  if (it.type !== 'mcp_tool_call') return [];
  if (typeof it.server !== 'string' || !it.server || /belay/i.test(it.server) || /belay/i.test(String(it.tool || ''))) return [];
  const r = it.result;
  const texts = typeof r === 'string' ? [r] : r && Array.isArray(r.content) ? r.content.filter(p => p && typeof p.text === 'string').map(p => p.text) : [];
  return texts.map(text => ({ id: it.id, text }));
}
function belayUseIds(lines) {
  const ids = new Set();
  for (const line of lines) if (line.includes('tool_use')) for (const b of blocksOf(line)) if (b.use && BELAY_TOOL.test(b.name)) ids.add(b.use);
  return ids;
}
// A reviewer reads a stream as raw JSON lines, where a quote mark, backslash, newline or tab is escaped, and may copy the line as it
// saw it. A quote is therefore compared as written and with the JSON string escapes decoded (\" \\ \/ \b \f \n \r \t \uXXXX);
// both forms are checked against the decoded tool-result text, so nothing is accepted that is not there.
const JSON_ESCAPE = /\\(?:u([0-9a-fA-F]{4})|(["\\/bfnrt]))/g;
const SIMPLE = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
function unescapeJson(s) {
  return String(s).replace(JSON_ESCAPE, (m, hex, c) => (hex ? String.fromCharCode(parseInt(hex, 16)) : SIMPLE[c] || c));
}
function quoteForms(quote) {
  const a = norm(quote);
  const b = norm(unescapeJson(quote));
  return b && b !== a ? [a, b] : [a];
}
// The note's own words are no evidence about it, in a stream: a quote held by its title, text or evidence, or one that holds its
// title. (A file at the head commit is evidence even when it contains the same words, so files never come here.)
function selfQuoted(own, title, quote) {
  const t = title ? norm(title).toLowerCase() : '';
  return quoteForms(quote).some(form => {
    const q = form.toLowerCase();
    return (own || []).some(o => quoteForms(o).some(of => of.toLowerCase().includes(q))) || (t.length >= 12 && q.includes(t));
  });
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
    if (typeof c.quote !== 'string' || !c.quote.trim() || Buffer.byteLength(c.quote) > 2000) return { error: `cites[${i}].quote must be a non-empty string of at most 2000 bytes: a verbatim line` };
    out.push({ where: c.where.trim(), quote: c.quote });
  }
  return { cites: out };
}

// A review's cites against the evidence one TASK recorded (the note-review route): `where` is "stream" or "stream:<worker id>"
// (a tool result in that task's worker streams) or a repository path read with git at the head commit of a worker of the task.
// note: { title, text, evidence } of the note judged; its own words are refused for stream cites only.
// Returns { ok, failures: [{ index, where, reason }] }.
const seam = { afterCheck: null }; // tests only: lets a test land another review between the check and the write
const ECHO = 'the quote is in a tool result that also shows the note\'s own text (its title, or a long sentence of the note), so that result is not independent evidence; quote a line of a different tool result, or cite a file';
function streamResultHas(file, quote, skip = null) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { found: false, reason: `no stream at ${file}` }; }
  if (raw.length > FILE_MAX * 8) return { found: false, reason: 'the stream is too large to search' };
  const lines = raw.split('\n');
  const belay = belayUseIds(lines);
  const forms = quoteForms(quote);
  let echoed = false;
  for (const line of lines) {
    if (!line.includes('tool_result') && !line.includes('item.completed')) continue;
    for (const b of blocksOf(line)) {
      if (b.text === undefined || (b.id !== undefined && belay.has(b.id))) continue;
      if (!holds(b.text, forms)) continue;
      if (skip && skip(norm(b.text), b.text)) { echoed = true; continue; }
      return { found: true };
    }
  }
  if (echoed) return { found: false, echoed: true, reason: ECHO };
  return { found: false, reason: 'the quote is in no tool result of that stream (results of belay\'s own tools are not evidence)' };
}
// A stream cite for a note. A quote that the note's own words also hold is accepted only when a non-belay tool result holds it and
// that result is not an echo of the note (echoOf below). A quote found only in the note, in belay's own calls,
// or in the worker's hand-back or prose is in no such result, and is refused as before.
const SELF = 'the quote is the note\'s own text, which cannot be evidence about the note';
function streamCite(file, quote, own, title, saws = []) {
  if (!selfQuoted(own, title, quote)) return streamResultHas(file, quote);
  const r = streamResultHas(file, quote, echoOf(own, title, quote, saws));
  return r.found || r.echoed ? r : { found: false, reason: SELF };
}
// Echo rule. A tool result is an echo of the note, and no evidence about it, when its text (JSON string escapes decoded, whitespace
// collapsed, case folded; also checked as printed) shows the note rather than independent output:
//   - it holds a title of 20 or more characters, or the first 32 characters of a longer title (a listing that cuts titles);
//   - a line of it IS the title (a shorter title, 4 or more characters, counts only as a whole line);
//   - it holds a sentence of the note's own fields (16 or more characters with a space: when, text, a saw) of 60 or more characters, or any
//     such sentence when the title is a single token with no space (an identifier such as RETRIES=3) that the result also holds.
// A short saw that a tool really printed, or a short phrase title that a heading or log line holds, is not an echo: the result that proves the
// saw is not its echo. What this leaves open: a worker that prints its own short saw with a tool.
// `saws` are the `saw` fields among `own`: a copy of printed output by contract, so the line that holds the quote is left out of the long-sentence
// check for a saw, and for a saw only. A `when` or a text sentence is the writer's own prose: a printed copy of it is an echo wherever the quote is.
// `opts.file` is a file read from a working tree rather than a tool result: the identifier rule is left out (a source file names its identifiers).
const PREFIX_LEN = 32, ANCHOR_MIN = 16, SENTENCE_LONG = 60, TITLE_LONG = 20, TITLE_MIN = 4;
function echoOf(own, title, quote = null, saws = [], opts = {}) {
  const low = s => norm(s).toLowerCase();
  const t = title ? low(title) : '';
  // A saw is exempt only as a saw, and by span: a saw that appears anywhere inside another of the writer's fields (when, text, a title,
  // an evidence `where`), alone or embedded in a longer sentence, is the writer's prose there, so it is not exempt. The saws' own copies are
  // taken out of `own` first (one copy each); what is left is the writer's prose.
  const unspent = new Map();
  for (const s of saws || []) unspent.set(low(s), (unspent.get(low(s)) || 0) + 1);
  const prose = [];
  for (const o of own || []) {
    const k = low(o);
    if ((unspent.get(k) || 0) > 0) unspent.set(k, unspent.get(k) - 1); else prose.push(k, low(unescapeJson(o)));
  }
  const sawSet = new Set((saws || []).map(low).filter(s => !prose.some(f => f.includes(s) || f.includes(low(unescapeJson(s))))));
  const sentences = (own || []).map(low).filter(a => a.length >= ANCHOR_MIN && a.includes(' ') && a !== t);
  const idLike = t.length >= TITLE_MIN && !t.includes(' ');
  const wanted = quote == null ? [] : quoteForms(quote).map(q => q.toLowerCase());
  return (text, raw) => {
    const forms = [text.toLowerCase(), norm(unescapeJson(text)).toLowerCase()];
    const has = a => forms.some(f => f.includes(a));
    // The line that holds the quote is the evidence itself: a note that copied a printed line into its saw does not make that line an echo.
    // For a saw, the 60-character sentence rule looks at the rest of the result only; every other rule looks at all of it.
    const rest = String(raw || '').split(/\r?\n/).filter(l => !wanted.some(q => low(l).includes(q) || low(unescapeJson(l)).includes(q)));
    const restForms = wanted.length ? [norm(rest.join('\n')).toLowerCase(), norm(unescapeJson(rest.join('\n'))).toLowerCase()] : forms;
    const restHas = a => restForms.some(f => f.includes(a));
    const lines = String(raw || '').split(/\r?\n/).flatMap(l => [low(l), low(unescapeJson(l))]);
    const titleHeld = t.length >= TITLE_LONG ? has(t) : t.length >= TITLE_MIN && lines.includes(t);
    if (titleHeld || (t.length > PREFIX_LEN && has(t.slice(0, PREFIX_LEN)))) return true;
    const idHeld = !opts.file && idLike && has(t);
    return sentences.some(a => (idHeld ? has(a) : a.length >= SENTENCE_LONG && (sawSet.has(a) ? restHas(a) : has(a))));
  };
}
async function checkTaskCites(E, taskId, cites, note = null) {
  const workers = rows.currentAll(E.store, 'worker').filter(w => w.task_id === taskId);
  const own = note ? [note.title, note.when, note.text, ...((note.evidence || []).flatMap(e => [e && e.saw, e && e.where]))].filter(t => typeof t === 'string' && t.trim()) : [];
  const failures = [];
  const fail = (index, where, reason) => failures.push({ index, where, reason });
  for (const [i, c] of cites.entries()) {
    if (c.where === 'stream' || c.where.startsWith('stream:')) {
      const only = c.where === 'stream' ? null : c.where.slice(7);
      const pool = only ? workers.filter(w => w.id === only) : workers;
      if (!pool.length) { fail(i, c.where, only ? `worker ${only} did not work task ${taskId}` : `task ${taskId} has no worker row`); continue; }
      const misses = [];
      let hit = false;
      for (const w of pool) {
        const r = streamCite(path.join(E.dataDir, 'workers', w.id, 'stream.jsonl'), c.quote, own, note && note.title, note ? sawsOf(note) : []);
        if (r.found) { hit = true; break; }
        misses.push(`${w.id}: ${r.reason}`);
      }
      if (!hit) fail(i, c.where, misses.join('; '));
      continue;
    }
    const rel = fwd(c.where.replace(LINE_SUFFIX, '')).replace(/^\.\//, '');
    if (!relativeOk(rel)) { fail(i, c.where, 'a file cite is a path to a file inside the repository, relative to its root (not "./", not a directory)'); continue; }
    const pool = workers.filter(w => w.worktree);
    if (!pool.length) { fail(i, c.where, `task ${taskId} has no worker row with a worktree, so no file can be read`); continue; }
    let hit = false;
    const misses = [];
    const forms = [norm(c.quote)];
    const echoes = note ? text => echoOf(own, note.title, c.quote, sawsOf(note), { file: true })(norm(text), text) : () => false;
    for (const w of pool) {
      if (w.head_sha) { // the head is recorded when the worker settles; a worker still running has none
        const r = await gitShow(w.worktree, w.head_sha, rel);
        if (r.error) misses.push(`${w.id}: ${r.error}`);
        else if (holds(r.text, forms)) { hit = true; break; }
        else misses.push(`${w.id}: the quote is not in ${rel} at ${String(w.head_sha).slice(0, 12)}`);
      }
      const t = await worktreeShow(w.worktree, rel); // work that is not committed: workers do not commit
      if (t.error) { misses.push(`${w.id}: ${rel} in its working tree: ${t.error}`); continue; }
      if (holds(t.text, forms)) {
        // The writer may have made this file, so a file that holds the note's title or a long sentence of its own text (a draft, a hand-off file)
        // proves nothing about the note. A committed file is not asked: its writer could not have changed it.
        if (echoes(t.text)) { misses.push(`${w.id}: ${rel} in its working tree also holds the note's own text, so it is not independent evidence`); continue; }
        hit = true; break;
      }
      misses.push(`${w.id}: the quote is not in ${rel} in its working tree`);
    }
    if (!hit) fail(i, c.where, misses.join('; '));
  }
  if (seam.afterCheck) await seam.afterCheck();
  return { ok: failures.length === 0, failures };
}

const sawsOf = note => (note.evidence || []).map(e => e && e.saw).filter(t => typeof t === 'string' && t.trim());

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
          cache.set(c.where, st.size > FILE_MAX ? { error: `the stream file is over ${FILE_MAX} bytes` } : {});
        } catch (e) { cache.set(c.where, { error: `cannot read it (${e.code || e.message})` }); }
      }
      const got = cache.get(c.where);
      if (got.error) throw fail(got.error);
      // A stream carries the note's own index line, and quoting that back proves nothing. A file read at the head commit
      // is evidence even when the note quoted the same line, so this applies to streams only.
      // The same search as a note review: decoded tool results only, JSON escapes tolerated, belay's own tools excluded. The JSON
      // structure of the stream (braces, field names, ids) is not something a tool printed, so it is no evidence.
      const r = streamCite(want, c.quote, ctx.own, ctx.title, ctx.saws);
      if (!r.found) throw fail(r.reason);
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
    if (!holds(text, [quote])) throw fail(`the quote does not appear in ${rel} at ${ctx.head_sha.slice(0, 12)}`);
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

module.exports = { checkCitations, evidenceOf, checkTaskCites, checkShape, streamResultHas, streamCite, selfQuoted, seam };
