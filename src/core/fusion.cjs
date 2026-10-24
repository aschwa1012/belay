'use strict';
// fusion.cjs — reciprocal rank fusion of a semantic list and a keyword list (ADR 0040 §2).
//   score = alpha / (k + rank_semantic) + (1 - alpha) / (k + rank_keyword)
// Ranks are 1-based positions in each list, best first. A hit missing from one list gets no term from it.
// alpha is provisional until the hybrid evaluation sets it; the caller supplies it, this module only validates it.

const { err } = require('./errors.cjs');

const K = 60;
// ADR 0040 amendment (hybrid default), chosen by the second hybrid evaluation: the fusion memory.search and the first-message
// index share, so a worker's index and its own search rank the same way.
const HYBRID_ALPHA = 0.3, HYBRID_K = 10;

// An item is an id or an object carrying one. The first occurrence of an id is its rank.
const idOf = x => (x !== null && typeof x === 'object' ? x.id : x);

function rankMap(list, name) {
  if (!Array.isArray(list)) throw err('E_ARGS', `rrf: ${name} must be an array`);
  const m = new Map();
  for (const x of list) {
    const id = idOf(x);
    if (id === undefined || id === null) throw err('E_ARGS', `rrf: an item in ${name} has no id`);
    if (!m.has(id)) m.set(id, m.size + 1);
  }
  return m;
}

function rrf(semantic, keyword, { alpha = 0.5, k = K } = {}) {
  if (typeof alpha !== 'number' || !(alpha >= 0 && alpha <= 1)) throw err('E_ARGS', 'rrf: alpha must be a number from 0 to 1');
  if (!Number.isInteger(k) || k < 1) throw err('E_ARGS', 'rrf: k must be a positive integer');
  const sem = rankMap(semantic, 'semantic');
  const kw = rankMap(keyword, 'keyword');
  const out = [];
  for (const id of new Set([...sem.keys(), ...kw.keys()])) {
    const rs = sem.get(id) ?? null;
    const rk = kw.get(id) ?? null;
    const score = (rs === null ? 0 : alpha / (k + rs)) + (rk === null ? 0 : (1 - alpha) / (k + rk));
    out.push({ id, score, ranks: { semantic: rs, keyword: rk } });
  }
  // Ties (alpha 0 or 1 leaves the other list at zero, and equal ranks across lists tie at alpha 0.5) break by
  // the better single rank, then by first appearance, so the order is stable and does not depend on the sort.
  const best = h => Math.min(h.ranks.semantic ?? Infinity, h.ranks.keyword ?? Infinity);
  return out
    .map((h, i) => ({ h, i }))
    .sort((a, b) => b.h.score - a.h.score || best(a.h) - best(b.h) || a.i - b.i)
    .map(x => x.h);
}

// Several semantic lists (one per query vector) and one keyword list. The semantic weight alpha is shared among the n lists
// (alpha / n each), so the keyword weight does not change with the number of queries, and an id that several lists
// rank scores higher than one that a single list ranks equally well: score = alpha/n * sum(1/(k + rank_i)) + (1-alpha)/(k + rank_kw).
// With one list this is rrf's own score.
function rrfMany(semanticLists, keyword, { alpha = 0.5, k = K } = {}) {
  if (typeof alpha !== 'number' || !(alpha >= 0 && alpha <= 1)) throw err('E_ARGS', 'rrfMany: alpha must be a number from 0 to 1');
  if (!Number.isInteger(k) || k < 1) throw err('E_ARGS', 'rrfMany: k must be a positive integer');
  if (!Array.isArray(semanticLists)) throw err('E_ARGS', 'rrfMany: semanticLists must be an array of lists');
  const sems = semanticLists.map((l, i) => rankMap(l, `semantic[${i}]`));
  const kw = rankMap(keyword, 'keyword');
  const n = sems.length || 1;
  const ids = new Set([...sems.flatMap(m => [...m.keys()]), ...kw.keys()]);
  const out = [];
  for (const id of ids) {
    const ranks = sems.map(m => m.get(id) ?? null);
    const rk = kw.get(id) ?? null;
    const score = ranks.reduce((s, r) => s + (r === null ? 0 : (alpha / n) / (k + r)), 0) + (rk === null ? 0 : (1 - alpha) / (k + rk));
    out.push({ id, score, ranks: { semantic: ranks, keyword: rk } });
  }
  const best = h => Math.min(...h.ranks.semantic.map(r => r ?? Infinity), h.ranks.keyword ?? Infinity);
  return out
    .map((h, i) => ({ h, i }))
    .sort((a, b) => b.h.score - a.h.score || best(a.h) - best(b.h) || a.i - b.i)
    .map(x => x.h);
}

module.exports = { rrf, rrfMany, K, HYBRID_ALPHA, HYBRID_K };
