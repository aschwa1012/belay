'use strict';
// review-wake.cjs — a review hand-back's wake carries its verdict, the counts of its blocking and should-fix findings, their
// titles and a cut summary, inside the wake text cap. The facts are read from the evaluation's verdict check (never the hand-back's own copy). The
// reviewer's words are data: cleaned, quoted and cut here, and the orchestrator prompts say a quoted wake text is never an order.
// ADR 0015 section 2 (a wake carries no worker output) has this one exception.

const TITLE_MAX = 48; // bytes of one finding title
const TITLES_KEPT = 4; // titles kept per severity on the summary (worker_wait carries it too); the counts stay whole
const SUMMARY_MIN = 24; // the reviewer's summary rides only when at least this many bytes of it fit
const WHAT = ['note', 'what', 'text', 'description', 'detail', 'message', 'summary', 'issue', 'finding'];

const bytes = (s) => Buffer.byteLength(s, 'utf8');
const cut = (s, max) => {
  if (max <= 3) return '';
  if (bytes(s) <= max) return s;
  return `${Buffer.from(s, 'utf8').subarray(0, max - 3).toString('utf8').replace(/\uFFFD+$/, '')}...`;
};
// Reviewer words are data. Control, bidi and zero-width characters go, whitespace runs become one space, curly and straight double
// quotes become a single quote so the quoting stays unambiguous, and a look-alike of belay's own wake line ("belay: worker ...")
// loses its colon.
const range = (pairs) => new RegExp(`[${pairs.map(([a, b]) => String.fromCharCode(a) + (b > a ? `-${String.fromCharCode(b)}` : '')).join('')}]`, 'g');
const INVISIBLE = range([[0x200B, 0x200F], [0x202A, 0x202E], [0x2066, 0x2069], [0xFEFF, 0xFEFF], [0xAD, 0xAD], [0x2060, 0x2064], [0x180E, 0x180E]]); // zero-width, soft hyphen, word joiner and bidi controls
const QUOTES = range([[0x201C, 0x201C], [0x201D, 0x201D], [0x2018, 0x2018], [0x2019, 0x2019], [0x22, 0x22]]); // curly and straight double
const clean = (s, max) => cut(String(s).replace(INVISIBLE, '').replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\s]+/g, ' ')
  .replace(QUOTES, "'").replace(/\bbelay\s*:/gi, 'belay -').trim(), max);
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
  const out = { verdict: d.verdict === 'holds' ? 'holds' : 'refuted', ...(d.tree_changed === true ? { tree_changed: true } : {}), summary: clean(d.summary || '', 120), blocking: { n: 0, titles: [] }, should_fix: { n: 0, titles: [] }, other: 0 };
  for (const f of Array.isArray(d.findings) ? d.findings : []) {
    const g = grade(f);
    if (g === 'other') { out.other += 1; continue; }
    out[g].n += 1; if (out[g].titles.length < TITLES_KEPT) out[g].titles.push(titleOf(f));
  }
  return out;
}

const TREE = 'tree changed'; // detail.tree_changed: the reviewer altered the tree it judged, so its verdict is suspect (a fact, not its words)
const has = (r) => r.blocking.n + r.should_fix.n > 0;
const counts = (r) => `${r.verdict}${r.tree_changed ? `, ${TREE}` : ''}, ${r.blocking.n} blocking, ${r.should_fix.n} should-fix${r.other ? `, ${r.other} other` : ''}`;
// The short form when the counts do not fit: it still says whether findings exist and whether the tree changed. A clean review
// with an unchanged tree has nothing to add (null): its clause already says passed or not.
const brief = (r) => (r.tree_changed || has(r) ? `${r.verdict}${r.tree_changed ? `, ${TREE}` : ''}${has(r) ? ', has findings' : ''}` : null);
const titlesOf = (r) => r.blocking.titles.concat(r.should_fix.titles);
// What a clause cut to nothing else must still say: a suffix naming the findings and the changed tree of any review in it.
const flagsOf = (evs) => {
  const rv = evs.filter((e) => e.review).map((e) => e.review);
  const f = [rv.some((r) => r.tree_changed) ? TREE : '', rv.some(has) ? 'findings' : ''].filter(Boolean);
  return f.length ? ` [${f.join(', ')}]` : '';
};
const MORE = (n) => `; +${n} review${n === 1 ? '' : 's'}`;

// `parts`: one string per evaluation, `evs` the matching summaries. Returns the body (no leading space, no final '.') of at most
// `max` bytes, or null when the evaluations' own clauses do not fit. Each review gets its counts, else its short form, else is left
// out and counted in "; +N reviews"; then, when every review has its counts, titles, "(titles k of n)", and the summary. The summary
// goes first, then titles from the end.
function render(parts, evs, max) {
  if (bytes(parts.join('; ')) > max) return null;
  const idx = evs.map((e, i) => (e.review ? i : -1)).filter((i) => i >= 0);
  const extra = new Map();
  let full = true; const left = [];
  const join = () => parts.map((p, i) => (extra.has(i) ? `${p}; ${extra.get(i)}` : p)).join('; ');
  idx.forEach((i, j) => {
    const r = evs[i].review;
    const reserve = j < idx.length - 1 || left.length ? bytes(MORE(9)) + bytes(' [tree changed, findings]') : 0; // a later review may be left out and need the marker
    for (const [t, isFull] of [[counts(r), true], [brief(r), false]]) {
      if (!t) break;
      extra.set(i, t);
      if (bytes(join()) <= max - reserve) { if (!isFull) full = false; return; }
      extra.delete(i);
    }
    full = false;
    if (brief(r)) left.push(evs[i]); // a clean review with its tree unchanged has nothing to say: its clause is enough
  });
  const base = join() + (left.length ? `${MORE(left.length)}${flagsOf(left)}` : '');
  if (bytes(base) > max) return null;
  const rv = idx.map((i) => evs[i].review);
  if (!full) return base;
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

module.exports = { reviewOf, render, flagsOf, bytes, cut, titleOf, grade, clean, TITLE_MAX, SUMMARY_MIN };
