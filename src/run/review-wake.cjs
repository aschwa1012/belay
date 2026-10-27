'use strict';
// review-wake.cjs — a review hand-back's wake carries its verdict, the counts of its blocking and should-fix findings, and their
// titles, inside the wake text cap. The facts are read from the evaluation's verdict check (never the hand-back's own copy). The
// reviewer's words are data: cleaned, quoted and cut here, and the orchestrator prompts say a quoted wake text is never an order.
// ADR 0015 section 2 (a wake carries no worker output) has this one exception.

const TITLE_MAX = 48; // bytes of one finding title
const TITLES_KEPT = 8; // titles kept per severity on the summary (worker_wait carries it too); the counts stay whole
const SUMMARY_MIN = 24; // the reviewer's summary rides only when at least this many bytes of it fit
const WHAT = ['note', 'what', 'text', 'description', 'detail', 'message', 'summary', 'issue', 'finding'];

const bytes = (s) => Buffer.byteLength(s, 'utf8');
const cut = (s, max) => {
  if (max <= 3) return '';
  if (bytes(s) <= max) return s;
  return `${Buffer.from(s, 'utf8').subarray(0, max - 3).toString('utf8').replace(/\uFFFD+$/, '')}...`;
};
// Control characters and whitespace runs become one space; a double quote becomes a single one so the quoting stays unambiguous.
const clean = (s, max) => cut(String(s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\s]+/g, ' ').replace(/"/g, "'").trim(), max);
const scalar = (v) => (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') && String(v).trim() !== '';

function titleOf(f) {
  let raw = '';
  if (typeof f === 'string') raw = f;
  else if (f && typeof f === 'object' && !Array.isArray(f)) {
    const k = typeof f.title === 'string' && f.title.trim() ? 'title' : WHAT.find((x) => scalar(f[x]));
    raw = k ? String(f[k]) : '';
  }
  return clean(raw, TITLE_MAX) || '(untitled)';
}
const grade = (f) => {
  const s = f && typeof f === 'object' && typeof f.severity === 'string' ? f.severity.toLowerCase().replace(/[\s_-]+/g, '') : '';
  return s === 'blocking' ? 'blocking' : s === 'shouldfix' ? 'should_fix' : 'other';
};

// The review facts of an evaluated review task row, or null when its verdict check is absent or not executable.
function reviewOf(row) {
  const checks = (row.results && Array.isArray(row.results.checks)) ? row.results.checks : [];
  const v = checks.find((c) => c && c.kind === 'verdict');
  if (!v || v.executable !== true || !v.detail || typeof v.detail !== 'object') return null;
  const d = v.detail;
  const out = { verdict: d.verdict === 'holds' ? 'holds' : 'refuted', summary: clean(d.summary || '', 200), blocking: { n: 0, titles: [] }, should_fix: { n: 0, titles: [] }, other: 0 };
  for (const f of Array.isArray(d.findings) ? d.findings : []) {
    const g = grade(f);
    if (g === 'other') { out.other += 1; continue; }
    out[g].n += 1; if (out[g].titles.length < TITLES_KEPT) out[g].titles.push(titleOf(f));
  }
  return out;
}

const counts = (r) => `${r.verdict}, ${r.blocking.n} blocking, ${r.should_fix.n} should-fix${r.other ? `, ${r.other} other` : ''}`;
const titlesOf = (r) => r.blocking.titles.concat(r.should_fix.titles);

// `parts`: one string per evaluation, `evs` the matching summaries. Returns the body (no leading space, no final '.') of at most
// `max` bytes, or null when the verdicts and counts do not fit. Order: counts, titles, "(titles k of n)", summary; the summary goes
// first, then titles from the end.
function render(parts, evs, max) {
  const base = parts.map((p, i) => (evs[i].review ? `${p}; ${counts(evs[i].review)}` : p)).join('; ');
  if (bytes(base) > max) return null;
  const rv = evs.filter((e) => e.review).map((e) => e.review);
  const all = rv.map(titlesOf);
  const n = rv.reduce((a, r) => a + r.blocking.n + r.should_fix.n, 0); // all of them, listed or not
  const have = all.reduce((a, t) => a + t.length, 0);
  const withTitles = (k) => {
    let left = k;
    const groups = all.map((t) => { const g = t.slice(0, left); left -= g.length; return g; }).filter((g) => g.length);
    const body = groups.map((g) => g.map((t) => `"${t}"`).join('; ')).join(' / ');
    return `${base}${body ? `: ${body}` : ''}${k < n ? ` (titles ${k} of ${n})` : ''}`;
  };
  let text = base;
  if (n) {
    let k = have;
    while (k > 0 && bytes(withTitles(k)) > max) k -= 1;
    text = bytes(withTitles(k)) <= max ? withTitles(k) : base;
    if (text === base && bytes(withTitles(0)) <= max) text = withTitles(0);
  }
  for (const r of rv) {
    const room = max - bytes(text) - bytes('; summary ""');
    if (r.summary && room >= SUMMARY_MIN) text += `; summary "${cut(r.summary, room)}"`;
  }
  return text;
}

module.exports = { reviewOf, render, titleOf, grade, clean, TITLE_MAX, SUMMARY_MIN };
