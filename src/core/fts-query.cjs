'use strict';
// fts-query.cjs — turns a free-text query into an FTS5 MATCH expression for the trigram index (ADR 0040 §2).
// Every term becomes a quoted phrase, so the FTS operators and column filters in a query (" * : ^ ( ) -, AND,
// OR, NOT, NEAR) are searched as text and never parsed. The trigram tokenizer matches nothing for a term under
// three characters and says nothing about it, so such terms are dropped, and a query left with none is an
// error by name (E_QUERY_SHORT) instead of an empty result that looks like no match.

// The shortest term the trigram tokenizer can match.
const MIN_TERM = 3;

// A cap keeps one pasted page from becoming a thousand-phrase expression.
const MAX_TERMS = 32;

// Terms split on whitespace and on the double quote, the one character a quoted phrase cannot carry. Length is
// counted in code points, which is how the trigram tokenizer counts characters.
function toMatch(query) {
  if (typeof query !== 'string') return { error: 'E_QUERY_SHORT' };
  const seen = new Set();
  const terms = [];
  for (const t of query.split(/[\s"]+/)) {
    if (!t || [...t].length < MIN_TERM || seen.has(t)) continue;
    seen.add(t);
    terms.push(`"${t}"`);
    if (terms.length === MAX_TERMS) break;
  }
  if (!terms.length) return { error: 'E_QUERY_SHORT' };
  // Space between phrases is FTS5's implicit AND: a row must contain every term.
  return { match: terms.join(' ') };
}

module.exports = { toMatch, MIN_TERM, MAX_TERMS };
