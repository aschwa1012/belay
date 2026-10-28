'use strict';
// cost-estimate.cjs — what a worker's unreported turns cost, from its own stream (ADR 0068, proposed).
// Claude Code reports cost and tokens only on a turn's `result` line. A worker killed or closed mid-turn never writes one, so its
// row would say $0 for work it did. On a terminal write the core reads the worker's stream, splits it into lives at each
// `system/init` line, takes each life's assistant messages that follow its last `result` line, and prices them from their
// per-message usage (usage-price.cjs). The figure goes in its OWN columns, `cost_estimate` (JSON: dollars and tokens) and
// `cost_source`; `cost_usd` and the token columns stay what Claude Code reported. The estimate is recomputed from the stream on
// every terminal write, never accumulated; a live row carries none.
//
// The stream is read backward in chunks and the scan stops at SCAN_CAP bytes (the estimate then says `truncated`), so the work on
// the store owner's thread is bounded. An unchanged stream (the restating writes of one death) is answered from a memo.

const fs = require('node:fs');
const path = require('node:path');
const { PRICES, messageUsd } = require('./usage-price.cjs');

const SOURCE = 'transcript_estimate';
const CHUNK = 4 * 1024 * 1024;
const SCAN_CAP = 16 * 1024 * 1024;
const INIT_MARK = '"subtype":"init"';
const RESULT_MARK = '"type":"result"';
const ASSISTANT_MARK = '"type":"assistant"';
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const memo = new Map(); // stream path -> { size, mtimeMs, est }; the owner is one process, and a changed file misses

// The usage of one assistant line, or null when it carries none the estimate can use.
function lineUsage(line) {
  let j;
  try { j = JSON.parse(line); } catch { return null; }
  if (!j || j.type !== 'assistant' || j.isSidechain === true || !j.message || typeof j.message.usage !== 'object' || !j.message.usage) return null;
  const msg = j.message;
  if (typeof msg.model !== 'string' || msg.model === '<synthetic>') return null;
  const uu = msg.usage;
  const cc = num(uu.cache_creation_input_tokens);
  const split = uu.cache_creation && typeof uu.cache_creation === 'object' && !Array.isArray(uu.cache_creation);
  return {
    id: typeof msg.id === 'string' && msg.id ? msg.id : null, model: msg.model,
    u: {
      input: num(uu.input_tokens), output: num(uu.output_tokens), cache_read: num(uu.cache_read_input_tokens), cache_creation: cc,
      cc5m: split ? num(uu.cache_creation.ephemeral_5m_input_tokens) : cc, cc1h: split ? num(uu.cache_creation.ephemeral_1h_input_tokens) : 0,
    },
  };
}

const parseOf = (line, type) => {
  try { const j = JSON.parse(line); return j && j.type === type ? j : null; } catch { return null; } // a cut line is not one
};
const newLife = () => ({ tail: [], resultSeen: false, lastTotal: null, firstTotal: null, session: null });

// Feed whole lines, newest first. A "life" is the run of lines from one `system/init` to the next. Claude Code emits an init at
// every TURN within one process (par-1 t21-coder: 2 inits, 2 results, one session, one process, cumulative totals), so in practice
// a life here is a turn; a relaunch (resume or fresh session) also starts one. Going backward, the assistant
// lines before the first result met are the life's unreported tail; the result totals bound what the life reported.
function walk(text, st) {
  let end = text.length;
  if (end && text.charCodeAt(end - 1) === 10) end -= 1;
  while (end >= 0) {
    const ls = end > 0 ? text.lastIndexOf('\n', end - 1) + 1 : 0;
    const line = text.slice(ls, end);
    end = ls - 1;
    if (line.includes(ASSISTANT_MARK)) { if (!st.life.resultSeen) st.life.tail.push(line); continue; }
    if (line.includes(RESULT_MARK)) {
      const j = parseOf(line, 'result');
      if (j) {
        st.life.resultSeen = true;
        if (typeof j.total_cost_usd === 'number') { if (st.life.lastTotal == null) st.life.lastTotal = j.total_cost_usd; st.life.firstTotal = j.total_cost_usd; }
      }
      continue;
    }
    if (line.includes(INIT_MARK)) {
      const j = parseOf(line, 'system');
      if (j && j.subtype === 'init') { st.life.session = typeof j.session_id === 'string' ? j.session_id : null; st.lives.push(st.life); st.life = newLife(); }
    }
  }
}

// scanLives(streamPath, cap) -> { lives (oldest first), truncated, size, mtimeMs }, or null when the file cannot be read. Reads
// backward in CHUNK pieces and stops at `cap` bytes.
function scanLives(streamPath, cap = SCAN_CAP) {
  let fd;
  try { fd = fs.openSync(streamPath, 'r'); } catch { return null; }
  try {
    const st = fs.fstatSync(fd);
    const w = { lives: [], life: newLife() };
    let pos = st.size; let carry = Buffer.alloc(0); let scanned = 0; let truncated = false;
    while (pos > 0) {
      if (scanned >= cap) { truncated = true; break; }
      const n = Math.min(CHUNK, pos); pos -= n;
      const chunk = Buffer.allocUnsafe(n);
      let got = 0;
      while (got < n) { const r = fs.readSync(fd, chunk, got, n - got, pos + got); if (r <= 0) break; got += r; }
      scanned += n;
      const buf = carry.length ? Buffer.concat([chunk.subarray(0, got), carry]) : chunk.subarray(0, got);
      let body;
      if (pos === 0) { body = buf; carry = Buffer.alloc(0); } else {
        const nl = buf.indexOf(10);
        if (nl < 0) { carry = buf; continue; } // one line longer than this chunk: keep reading back
        carry = buf.subarray(0, nl); body = buf.subarray(nl + 1);
      }
      walk(body.toString('utf8'), w);
    }
    w.lives.push(w.life); // the oldest life seen; its init lies before the scan when the stream was cut
    for (const l of w.lives) l.tail.reverse();
    return { lives: w.lives.reverse(), truncated, size: st.size, mtimeMs: st.mtimeMs };
  } catch { return null; } finally { try { fs.closeSync(fd); } catch { /* closed */ } }
}

// estimateLines(lines) -> null when no message is left, else { messages, usd, tokens, unpriced_models }.
// One API message spans several lines; the last line of an id has its final output count, and each id is counted once.
function estimateLines(lines, prices = PRICES) {
  const byId = new Map();
  const anon = [];
  for (const line of lines) {
    if (!line.includes(ASSISTANT_MARK)) continue;
    const m = lineUsage(line);
    if (!m) continue;
    if (m.id) byId.set(m.id, m); else anon.push(m);
  }
  const msgs = [...byId.values(), ...anon];
  if (!msgs.length) return null;
  const tokens = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
  const unpriced = new Set();
  let usd = 0;
  for (const m of msgs) {
    tokens.input += m.u.input; tokens.output += m.u.output; tokens.cache_read += m.u.cache_read; tokens.cache_creation += m.u.cache_creation;
    const d = messageUsd(prices, m.model, m.u);
    if (d === null) unpriced.add(m.model); else usd += d;
  }
  return { messages: msgs.length, usd: unpriced.size ? null : usd, tokens, unpriced_models: [...unpriced] };
}

// Per life: the assistant messages after the life's last result are unreported. When the NEXT life resumed the same session, its
// first result total carries the session's earlier spend (a graceful resume: measured). Whether a hard-killed life's spend is
// carried is UNMEASURED, so only the part of (carried total + this tail) that the resumed life's first total does not reach is
// counted (an under-estimate, since that total includes the resumed life's own first turn). A fresh session starts at zero, so
// its predecessor's tail counts whole.
function combine(scan, prices) {
  const sum = { messages: 0, usd: 0, priced: true, tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0 }, unpriced: new Set(), lives: 0, partial: 0 };
  let carried = 0; let session = null;
  scan.lives.forEach((life, i) => {
    if (life.session !== session) { session = life.session; carried = 0; }
    const est = estimateLines(life.tail, prices);
    const next = scan.lives[i + 1];
    if (est) {
      let frac = 1;
      if (next && next.session != null && next.session === life.session && next.firstTotal != null && est.usd != null && est.usd > 0) {
        const have = (life.lastTotal != null ? life.lastTotal : carried) + est.usd;
        frac = Math.min(1, Math.max(0, have - next.firstTotal) / est.usd);
      }
      if (frac > 0) {
        sum.lives += 1; if (frac < 1) sum.partial += 1;
        sum.messages += est.messages;
        for (const mdl of est.unpriced_models) sum.unpriced.add(mdl);
        if (est.usd === null) sum.priced = false; else sum.usd += frac * est.usd;
        for (const k of Object.keys(sum.tokens)) sum.tokens[k] += Math.round(frac * est.tokens[k]);
      }
    }
    if (life.lastTotal != null) carried = life.lastTotal;
  });
  if (!sum.lives) {
    // Nothing to price. If the scan stopped before the newest turn's result was seen, its tail is unknown, not empty: say so.
    const newest = scan.lives[scan.lives.length - 1];
    if (scan.truncated && newest && !newest.resultSeen) {
      return { messages: 0, usd: null, tokens: sum.tokens, unpriced_models: [], lives: 0, partial_lives: 0, truncated: true };
    }
    return null;
  }
  return {
    messages: sum.messages, usd: sum.priced && !sum.unpriced.size ? sum.usd : null, tokens: sum.tokens,
    unpriced_models: [...sum.unpriced], lives: sum.lives, partial_lives: sum.partial, truncated: scan.truncated,
  };
}

// The estimate for a worker's stream file, or null when there is nothing to add (no stream, none unreported).
function estimateStream(streamPath, prices = PRICES, cap = SCAN_CAP) {
  let st;
  try { st = fs.statSync(streamPath); } catch { return null; }
  const memoable = prices === PRICES && cap === SCAN_CAP;
  const hit = memoable ? memo.get(streamPath) : null;
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.est;
  const scan = scanLives(streamPath, cap);
  if (!scan) return null;
  const out = combine(scan, prices);
  if (memoable) {
    if (memo.size >= 64) memo.delete(memo.keys().next().value);
    memo.set(streamPath, { size: scan.size, mtimeMs: scan.mtimeMs, est: out });
  }
  return out;
}

const estimateOf = (row) => (row && row.cost_estimate && typeof row.cost_estimate === 'object' ? row.cost_estimate : null);

// Applied by the core to a worker row about to be written (`merged` = prev + args). A stopped or dead claude-code row gets the
// estimate for the assistant messages no `result` line reported, or none; every other row carries none. cost_usd and the token
// columns are never touched: they are what Claude Code reported.
function apply(dataDir, merged) {
  const terminal = merged.state === 'stopped' || merged.state === 'dead';
  merged.cost_estimate = null;
  merged.cost_source = null;
  if (!terminal || merged.substrate !== 'claude-code' || typeof merged.id !== 'string' || !SAFE_ID.test(merged.id)) return merged;
  const est = estimateStream(path.join(dataDir, 'workers', merged.id, 'stream.jsonl'));
  if (!est) return merged;
  merged.cost_estimate = {
    source: SOURCE, messages: est.messages, lives: est.lives, partial_lives: est.partial_lives, usd: est.usd, unpriced_models: est.unpriced_models, truncated: est.truncated,
    input_tokens: est.tokens.input, output_tokens: est.tokens.output,
    cache_read_tokens: est.tokens.cache_read, cache_creation_tokens: est.tokens.cache_creation,
  };
  merged.cost_source = SOURCE;
  return merged;
}

// The figures a reader shows for one worker row: reported, estimated and their sum. Each is null when not recorded; the sum is
// null when neither is, and the estimate's dollars are null when a model had no price.
function figures(row) {
  const e = estimateOf(row);
  const reported = row && row.cost_usd != null ? Number(row.cost_usd) : null;
  const estimated = e && typeof e.usd === 'number' ? e.usd : null;
  return { reported, estimated, combined: reported == null && estimated == null ? null : (reported || 0) + (estimated || 0), estimate: e };
}

// What status.get shows beside cost_usd (reported): the estimate and the sum, each labelled; null fields when there is none.
function statusFigures(row) {
  const f = figures(row);
  return { cost_estimated_usd: f.estimated, cost_combined_usd: f.combined, cost_source: row.cost_source == null ? null : row.cost_source };
}

module.exports = { apply, figures, statusFigures, estimateLines, estimateStream, scanLives, estimateOf, SOURCE, SCAN_CAP };
