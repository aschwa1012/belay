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

const GIT_BOUND_MS = 10000;
const FILE_MAX = 8 * 1024 * 1024;
const norm = s => String(s).replace(/\s+/g, ' ').trim();
const fwd = p => String(p).split('\\').join('/');
const LINE_SUFFIX = /:\d+(?:-\d+)?$/;

function gitShow(worktree, head, rel) {
  return new Promise(resolve => {
    execFile('git', ['show', `${head}:${rel}`], { cwd: worktree, timeout: GIT_BOUND_MS, maxBuffer: FILE_MAX, windowsHide: true, encoding: 'utf8' },
      (e, stdout) => resolve(e ? { error: e.code === 128 || /exists on disk|does not exist|bad object|unknown revision/i.test(String(e.stderr || e.message)) ? 'not at that commit' : `git did not answer (${e.code || e.signal || 'error'})` } : { text: stdout }));
  });
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
          else cache.set(c.where, { text: fs.readFileSync(want, 'utf8') });
        } catch (e) { cache.set(c.where, { error: `cannot read it (${e.code || e.message})` }); }
      }
      const got = cache.get(c.where);
      if (got.error) throw fail(got.error);
      // A stream carries the note's own index line, and quoting that back proves nothing. A file read at the head commit
      // is evidence even when the note quoted the same line, so this applies to streams only.
      if ((ctx.own || []).some(t => norm(t).includes(quote))) throw fail('the quote is the note\'s own text, which cannot be evidence about the note');
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

module.exports = { checkCitations, evidenceOf };
