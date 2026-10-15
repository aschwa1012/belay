'use strict';
// citation-check.cjs — ADR 0044 decision 5: belay checks the citations of a review verdict, never the meaning. A cite is
// { where, quote }; the quote must appear verbatim (line endings aside) in evidence the reviewed task itself recorded:
//   where "stream" or "stream:<worker id>"  a tool result in the stream.jsonl of a worker that worked the task
//   where "<repo path>"                      the file at the head commit of a worker that worked the task
// The model can be wrong about what the evidence means. It cannot cite evidence that is not there.
//
// Reads only: the data dir's streams and `git show`. A source that cannot be read is a failed cite with its reason,
// never a pass. Used by memory.noteVerdicts; loaded by a write path only.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const rows = require('./rows.cjs');

const QUOTE_MIN = 8; // shorter than this proves nothing about a claim
const QUOTE_MAX = 2000;
const WHERE_MAX = 300;
const CITES_MAX = 8;
const STREAM_MAX_BYTES = 64 * 1024 * 1024;
const FILE_MAX_BYTES = 8 * 1024 * 1024;
const GIT_MS = 10000;

const norm = (s) => String(s).replace(/\r\n/g, '\n');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// The shape of a cites array, checked before any read. Returns the cleaned list or { error }.
function checkShape(cites) {
  if (!Array.isArray(cites) || !cites.length) return { error: 'cites must be an array of at least one { where, quote }' };
  if (cites.length > CITES_MAX) return { error: `cites holds ${cites.length} entries and the most is ${CITES_MAX}` };
  const out = [];
  for (const [i, c] of cites.entries()) {
    if (!isObj(c)) return { error: `cites[${i}] must be an object { where, quote }` };
    for (const k of Object.keys(c)) if (k !== 'where' && k !== 'quote') return { error: `cites[${i}].${k} is not a field; use where and quote` };
    if (typeof c.where !== 'string' || !c.where.trim() || Buffer.byteLength(c.where) > WHERE_MAX) return { error: `cites[${i}].where must be a non-empty string of at most ${WHERE_MAX} bytes` };
    if (typeof c.quote !== 'string' || c.quote.trim().length < QUOTE_MIN || Buffer.byteLength(c.quote) > QUOTE_MAX) return { error: `cites[${i}].quote must be a string of ${QUOTE_MIN} to ${QUOTE_MAX} bytes: a verbatim line` };
    out.push({ where: c.where.trim(), quote: c.quote });
  }
  return { cites: out };
}

// The strings a stream line carries as tool results (Claude Code stream-json: user messages holding tool_result blocks).
function toolResultTexts(line) {
  let j;
  try { j = JSON.parse(line); } catch { return []; }
  const content = j && j.message && j.message.content;
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const b of content) {
    if (!b || b.type !== 'tool_result') continue;
    if (typeof b.content === 'string') out.push(b.content);
    else if (Array.isArray(b.content)) for (const p of b.content) if (p && typeof p.text === 'string') out.push(p.text);
  }
  return out;
}

function streamHas(file, quote) {
  let size;
  try { size = fs.statSync(file).size; } catch { return { found: false, reason: `no stream at ${file}` }; }
  if (size > STREAM_MAX_BYTES) return { found: false, reason: `the stream is ${size} bytes, over the ${STREAM_MAX_BYTES} bytes that are searched` };
  const q = norm(quote);
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('tool_result')) continue;
    for (const t of toolResultTexts(line)) if (norm(t).includes(q)) return { found: true };
  }
  return { found: false, reason: 'the quote is in no tool result of that stream' };
}

function gitShow(worktree, sha, rel) {
  return new Promise((resolve) => {
    execFile('git', ['-C', worktree, 'show', `${sha}:${rel}`], { maxBuffer: FILE_MAX_BYTES, timeout: GIT_MS, windowsHide: true, encoding: 'utf8' }, (e, stdout) => {
      if (e) return resolve({ error: e.killed ? `git did not answer inside ${GIT_MS} ms` : `git has no ${rel} at ${sha.slice(0, 12)}` });
      resolve({ text: stdout });
    });
  });
}

// The workers that worked the task, as rows; the check reads their streams, worktrees and head commits.
function workersOf(E, taskId) {
  return rows.currentAll(E.store, 'worker').filter((w) => w.task_id === taskId);
}

// cites: shaped by checkShape. Returns { ok, failures: [{ index, where, reason }] }.
async function checkCites(E, taskId, cites) {
  const workers = workersOf(E, taskId);
  const failures = [];
  const fail = (index, where, reason) => failures.push({ index, where, reason });
  for (const [i, c] of cites.entries()) {
    if (c.where === 'stream' || c.where.startsWith('stream:')) {
      const only = c.where === 'stream' ? null : c.where.slice(7);
      const pool = only ? workers.filter((w) => w.id === only) : workers;
      if (!pool.length) { fail(i, c.where, only ? `worker ${only} did not work task ${taskId}` : `task ${taskId} has no worker row`); continue; }
      const misses = [];
      let hit = false;
      for (const w of pool) {
        const r = streamHas(path.join(E.dataDir, 'workers', w.id, 'stream.jsonl'), c.quote);
        if (r.found) { hit = true; break; }
        misses.push(`${w.id}: ${r.reason}`);
      }
      if (!hit) fail(i, c.where, misses.join('; '));
      continue;
    }
    const rel = c.where.replace(/\\/g, '/').replace(/^\.\//, '');
    if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.split('/').includes('..')) { fail(i, c.where, 'a file cite is a path inside the repository, relative to its root'); continue; }
    const pool = workers.filter((w) => w.head_sha && w.worktree);
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
  return { ok: failures.length === 0, failures };
}

module.exports = { checkShape, checkCites, toolResultTexts, QUOTE_MIN, CITES_MAX };
