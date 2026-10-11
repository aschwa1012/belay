'use strict';
// memory-corpus.cjs — ADR 0043 decision 1: the corpus the knowledge agent is primed with. A read method for
// every role: it collects the verified rows, the summaries and the decision rows of one project namespace (the
// run namespace when no project is given), renders each as `[<id>] [type/status] title` and the text, and fits
// the lot to a byte budget through the one renderer every injected block uses (fit-budget.cjs).
//
// Reading never writes: every statement is a SELECT, nothing stamps accessed_at, and nothing here requires the
// embedder. The result carries no clock, so the same rows give the same bytes and the same sha256, which is
// what lets the run manager tell whether the agent must be primed again.

const crypto = require('node:crypto');
const { err } = require('./errors.cjs');
const { deriveTitle, validId, safeType, FRAME } = require('./memory-rows.cjs');
const { checkReach } = require('./memory-reach.cjs');
const { fit } = require('./fit-budget.cjs');

const DEFAULT_MAX = 65536;
const CEILING_MAX = 262144;
const FETCH_CAP = 5000; // rows read from the store before fitting; the rest are counted in `dropped`
const PROJECT_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// A decision outranks a summary, and a summary outranks a verified fact, when the budget forces a drop.
const PRIORITY = { decision: 3, summary: 2 };

const bad = (msg, field) => err('E_ARGS', msg, field ? { field } : undefined);

function namespaceOf(E, caller, args) {
  const p = args.project;
  if (p === undefined || p === null) return `run/${caller.run_id}`;
  if (typeof p !== 'string' || !PROJECT_RE.test(p)) throw bad('project must match ^[a-z0-9][a-z0-9._-]{0,63}$', 'project');
  checkReach(E, caller, [`project/${p}`], 'read');
  return `project/${p}`;
}

function maxBytesOf(v) {
  if (v === undefined || v === null) return DEFAULT_MAX;
  if (!Number.isInteger(v) || v < 1 || v > CEILING_MAX) throw bad(`max_bytes must be an integer from 1 to ${CEILING_MAX}`, 'max_bytes');
  return v;
}

// The row line at column 0, then every line of the text indented two spaces: a row's own text can hold a line that
// looks like a row header or the END marker, and indented it reads as what it is, the row's words.
const indent = (s) => String(s).split(/\r\n|\r|\n/).map((l) => `  ${l}`).join('\n');
const lineOf = (r) => {
  const title = deriveTitle(r.title || r.text);
  return `[${r.id}] [${safeType(r.type)}/${r.status || 'unverified'}] ${title}\n${indent(r.text)}`;
};

// memory.corpus { project?, max_bytes = 65536 } -> { text, bytes, row_ids, sha256, dropped, over_budget }
async function corpus(E, caller, args = {}) {
  const namespace = namespaceOf(E, caller, args);
  const maxBytes = maxBytesOf(args.max_bytes);
  const db = E.store.db;
  // Live rows only: not expired, not superseded by another row of the same namespace (as memory-index.cjs reads it). Verified rows, summaries and decisions qualify;
  // a refuted row never does, whatever its type.
  // +s.namespace keeps the inner lookup on ix_entries_supersedes (memory-search.cjs baseWhere explains why).
  const where = `e.namespace = ?
    AND (e.ttl_at IS NULL OR e.ttl_at >= ?)
    AND NOT EXISTS (SELECT 1 FROM memory_entries s WHERE s.supersedes = e.id AND +s.namespace = e.namespace)
    AND COALESCE(e.status, 'unverified') <> 'refuted'
    AND (COALESCE(e.status, 'unverified') = 'verified' OR e.type IN ('summary', 'decision'))`;
  const params = [namespace, Date.now()];
  const total = db.prepare(`SELECT COUNT(*) AS n FROM memory_entries e WHERE ${where}`).get(...params).n;
  // Newest first under the cap, so a very large namespace loses its oldest rows; the text reads oldest first.
  const found = db.prepare(`SELECT e.id, e.type, e.status, e.title, e.text FROM memory_entries e WHERE ${where}
    ORDER BY e.created_at DESC, e.id DESC LIMIT ?`).all(...params, FETCH_CAP).reverse();
  // A row whose id predates id validation would not render as one token, so it is left out (and counted dropped).
  const items = found.filter(r => validId(r.id)).map(r => ({ id: r.id, text: lineOf(r), priority: PRIORITY[r.type] || 1 }));
  const fitted = fit(items, {
    max_bytes: maxBytes,
    header: `# belay memory corpus: ${namespace}\n${FRAME.full}`,
    footer: found.length ? FRAME.end : `(no verified rows, summaries or decisions in this namespace)\n${FRAME.end}`,
    drop_order: 'priority-then-oldest',
  });
  return {
    text: fitted.text,
    bytes: fitted.bytes,
    row_ids: fitted.kept,
    sha256: crypto.createHash('sha256').update(fitted.text).digest('hex'),
    dropped: fitted.dropped + (total - items.length),
    over_budget: fitted.over_budget,
  };
}

module.exports = { corpus, DEFAULT_MAX, CEILING_MAX };
