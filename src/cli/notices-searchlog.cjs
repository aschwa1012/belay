'use strict';
// notices-searchlog.cjs — the retrieval failures only the search log records, as notices. A search answered without a stage (the semantic half
// down, the reranker off, a heavy tier behind) or refused leaves its failed stages in the log row's `fallback.failed`; the run row does not hold
// them. One event per (stage, code) for the run: how many searches, the first and the last time, what the first one said, what belay did and
// the next step. The log is written only with the search_log lever on, so a run without it has none here, and a notice never claims otherwise.
// Pure: it reads rows `core.memory.events({ kinds: ['search'] })` returned.

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const cut = (s, n) => { const x = String(s == null ? '' : s); return x.length > n ? `${x.slice(0, n - 3)}...` : x; };

// What belay did for a search whose stage failed, and the one next step that is true for every cause of it.
const STAGES = {
  semantic: { did: 'answered from the keyword half only', next: 'fix the cause; notes written meanwhile have no vector (belay memory embed embeds them, belay notices lists them as notes_unembedded)' },
  rerank: { did: 'returned the results in fusion order, not reranked', next: 'fix the reranker or raise rerank_bound_ms' },
  keyword: { did: 'answered from the semantic half only', next: 'see the message' },
  heavy_behind: { did: 'served the search on the fallback profile while a background catch-up embedded the rows', next: 'none needed once the catch-up finishes; later searches serve the heavy tier again' },
  heavy_embed: { did: 'served the search on the fallback profile', next: 'fix the cause and run again' },
  refused: { did: 'refused the search and answered nothing', next: 'see the code and message; a paused run is resumed with belay resume' },
};

function searchLogEvents(rows, runId, opts = {}) {
  const groups = new Map();
  for (const row of rows || []) {
    let d;
    try { d = JSON.parse(row.message); } catch { continue; }
    const failed = d && d.fallback && Array.isArray(d.fallback.failed) ? d.fallback.failed : [];
    for (const f of failed) {
      if (!f || !f.mode) continue;
      if (f.mode === 'heavy_embed' && opts.heavyFallbackInRow) continue; // already one notice: the heavy fallback in force on the run row
      const key = `${f.mode}|${f.code}`;
      const ts = num(row.written_at);
      const g = groups.get(key) || { mode: f.mode, code: f.code, count: 0, first: ts, last: ts, message: f.message, seq: row.seq };
      g.count += 1;
      if (ts !== null && (g.first === null || ts < g.first)) g.first = ts;
      if (ts !== null && (g.last === null || ts > g.last)) g.last = ts;
      groups.set(key, g);
    }
  }
  return [...groups.values()].map((g) => {
    const s = STAGES[g.mode] || { did: 'recorded the failure in the search log', next: 'see the message' };
    const span = g.count > 1 ? ` (first ${new Date(g.first).toISOString()}, last ${new Date(g.last).toISOString()})` : '';
    return {
      kind: `search_${g.mode}_failed`, retrieval: true, ts: g.first, run_id: runId, stage: g.mode, code: g.code, searches: g.count, last_ts: g.last,
      text: `${g.count} search${g.count === 1 ? '' : 'es'} in this run had ${g.mode === 'refused' ? 'a refusal' : `the ${g.mode.replace('_', ' ')} stage fail`}${span}: ${g.code}: ${cut(g.message, 400)}. Belay ${s.did}.`,
      options: [s.next], source: `search log, first at seq ${g.seq}`,
    };
  });
}

module.exports = { searchLogEvents };
