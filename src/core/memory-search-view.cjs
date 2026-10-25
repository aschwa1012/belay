'use strict';
// memory-search-view.cjs — what a memory search hands back (ADR 0057): the compact row, the one relevance score and its floor,
// and the warning. Pure: no store, no embedder, so any read path may load it.
//
// `relevance` is the cosine between the query and the row whenever the search has a query vector, whatever the mode: a keyword-only
// hit of a hybrid search takes its cosine from the same scan, so every row of a semantic or hybrid answer is on one scale. A keyword
// search has no query vector and answers relevance null. The floor flags; it never cuts: cosine separates relevant from unrelated rows
// only loosely on belay's own text (the measurement in ADR 0057), so a cut would hide relevant rows silently.
// When a reranker serves the search (ADR 0050), it reports `by: 'rerank'` with its own floor; nothing else in the shape changes.

const { deriveTitle } = require('./memory-rows.cjs');

// voyage-4-nano, query against row, chosen by the measurement in ADR 0057 (Evidence): below 0.35 lie 42% of the pairs judged unrelated and 2.8% of
// those judged highly relevant; "nothing reaches it" is wrong for 7.1% of answerable queries and holds for 29% of those with no answer.
// Re-measure for another model or a reranker.
const RELEVANCE_FLOOR = 0.35;
const HELD_REASON_MAX = 160;
const round = x => Math.round(x * 10000) / 10000;

const parse = s => { if (s == null) return null; if (typeof s === 'object') return s; try { return JSON.parse(s); } catch { return null; } };
const cut = (s, n) => (Buffer.byteLength(s) <= n ? s : Buffer.from(s).subarray(0, n).toString('utf8').replace(/�+$/, ''));

// The result's description of its relevance numbers.
function relevanceOf(sem, model) {
  if (!sem) return { by: 'none', why: 'no query vector: keyword search ranks by term match, which is not on the cosine scale' };
  return { by: 'cosine', model: model || null, floor: RELEVANCE_FLOOR };
}

// Below the floor, on the number the reader is shown (four decimals): a row shown at exactly the floor reaches it, here and in the absence claim.
const belowFloor = cosine => round(cosine) < RELEVANCE_FLOOR;

// The per-row relevance fields: { relevance, low_relevance? }.
function relevanceFields(cosine) {
  if (typeof cosine !== 'number') return { relevance: null };
  const r = round(cosine);
  return belowFloor(cosine) ? { relevance: r, low_relevance: true } : { relevance: r };
}

// A note's evidence as the reader needs it, with `checked: true` on an entry belay verified when the note was written, and `passed`, whether the
// evaluation it cites passed (ADR 0057 decision 7): a quote that is in the output of a failed run is still a true quote.
function evidenceOf(body) {
  const list = Array.isArray(body.evidence) ? body.evidence : [];
  const checked = new Map((Array.isArray(body.evidence_checked) ? body.evidence_checked : []).filter(c => c && c.ok).map(c => [c.index, c]));
  return list.map((e, i) => (checked.has(i) ? { ...e, checked: true, passed: !!checked.get(i).passed } : e));
}

// The compact row (ADR 0057 decision 1): what an orchestrator acts on, and nothing it does not. `hold` is the note's active hold
// ({ kind, reason }, from the hold row) or null; left undefined, the note's own pointer marks it.
function compactRow(r, cosine, superseded = false, hold = undefined) {
  const out = { id: r.id, type: r.type, title: r.title || deriveTitle(r.text), status: r.status || 'unverified', ...relevanceFields(cosine), created_at: r.created_at };
  if (r.supersedes) out.supersedes = r.supersedes; // the row this one replaced
  if (superseded) out.superseded = true; // replaced by a newer row (on the page only with include_superseded)
  if (r.type !== 'note') { out.text = r.text; return out; }
  const b = parse(r.body) || {};
  if (b.kind) out.kind = b.kind;
  if (b.when) out.when = b.when;
  if (b.basis) out.basis = b.basis;
  out.evidence = evidenceOf(b);
  if (Array.isArray(b.applies_to) && b.applies_to.length) out.applies_to = b.applies_to;
  const h = hold === undefined ? (b.held && typeof b.held === 'object' ? b.held : null) : hold;
  if (h) out.held = { kind: h.kind || null, reason: typeof h.reason === 'string' ? cut(h.reason, HELD_REASON_MAX) : null };
  const reported = Array.isArray(b.reported_wrong) ? b.reported_wrong.length : 0;
  if (reported) out.reported = reported;
  return out;
}

// What a search's numbers mean, for the debug view: the fused score of the mode that ranked it.
const scoreKind = (sem, kw) => (sem && kw ? 'rrf' : sem ? 'cosine' : kw ? 'bm25' : null);

const plural = (n, one, many) => (n === 1 ? one : many);

// The warning, first key of the result. Failures first; then rows the semantic scan could not see (with results or without, C4); then a
// page whose every row is below the floor; then the reasons an empty page proves nothing.
function warningFor(o, ran, failed, results, absence, unembedded, below) {
  if (failed.length) {
    const did = failed.map(f => `${f.mode} search did not run (${f.code})`).join('; ');
    const what = ran.length ? `these are ${ran.join(' and ')} matches only` : 'nothing was searched';
    return `${did}; ${what}; no match here does not mean no such entry`;
  }
  const gap = unembedded ? `${unembedded} in-scope ${plural(unembedded, 'row has', 'rows have')} no vector, so semantic search could not see ${plural(unembedded, 'it', 'them')}; keyword search alone covers ${plural(unembedded, 'it', 'them')}` : null;
  if (results.length) {
    const low = below && below === results.length ? `no result reaches the relevance floor (${RELEVANCE_FLOOR}); these are the nearest rows and are likely unrelated` : null;
    return [gap, low].filter(Boolean).join('; ') || null;
  }
  if (o.mode !== 'hybrid') {
    return `${o.mode} search only; ${o.mode === 'semantic' ? 'keyword' : 'semantic'} search did not run; no match here does not mean no such entry`;
  }
  if (gap) return `${gap}; no match here does not mean no such entry`;
  if (!absence) return 'both modes ran but offset or min_score narrowed the result; an empty page does not mean no such entry';
  return null;
}

module.exports = { RELEVANCE_FLOOR, belowFloor, relevanceOf, relevanceFields, compactRow, scoreKind, warningFor };
