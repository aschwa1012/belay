'use strict';
// inflight-cost.cjs — what a turn that has not ended has cost so far, from its own stream (ADR 0066 amendment, proposed).
// Claude Code reports cost only on a turn's `result` line, so a long turn's spend reaches the ledger in one jump when it ends. Between
// two `result` lines the stream already carries each assistant message's usage; this prices those messages with the same table and
// arithmetic as ADR 0068's estimate (cost-estimate.cjs). The figure is an ESTIMATE at API rates, kept apart from the reported cost and
// replaced by it at the turn's end: the `result` line empties the in-flight total, and the ledger row then carries the reported cost.
//
// Two readers, neither parsing a whole transcript: the accumulator keeps a running total as lines arrive (the run process, for the
// orchestrator it spawned), and tailEstimate reads a stream file backward in small chunks and stops at the newest `result` line (a
// status read, for any live worker or the orchestrator), memoised on size and mtime.

const fs = require('node:fs');
const { PRICES } = require('./usage-price.cjs');
const CE = require('./cost-estimate.cjs');

const CHUNK = 256 * 1024;
const TAIL_CAP = 8 * 1024 * 1024; // past this the turn is unknown, not empty: the estimate says `truncated`
const RESULT_MARK = '"type":"result"';
const ASSISTANT_MARK = '"type":"assistant"';
const memo = new Map(); // stream path -> { size, mtimeMs, est }

const isResult = (line) => { try { const j = JSON.parse(line); return !!j && j.type === 'result'; } catch { return false; } };

// A running total. feed(line) takes one stream line; snapshot() is the in-flight estimate or null when no assistant message has
// arrived since the last `result`.
function createAccumulator(prices = PRICES) {
  let byId = new Map();
  let anon = [];
  return {
    feed(line) {
      if (typeof line !== 'string') return;
      if (line.includes(RESULT_MARK)) { if (isResult(line)) { byId = new Map(); anon = []; } return; }
      if (!line.includes(ASSISTANT_MARK)) return;
      const m = CE.lineUsage(line);
      if (!m) return;
      if (m.id) byId.set(m.id, m); else anon.push(m);
    },
    snapshot() { return CE.priceMessages([...byId.values(), ...anon], prices); },
  };
}

// The in-flight estimate of a stream file, or null (no stream, or nothing since the last `result`).
function tailEstimate(streamPath, prices = PRICES, cap = TAIL_CAP) {
  let fd;
  try { fd = fs.openSync(streamPath, 'r'); } catch { return null; }
  try {
    const st = fs.fstatSync(fd);
    const hit = prices === PRICES && cap === TAIL_CAP ? memo.get(streamPath) : null;
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.est;
    const lines = [];
    let pos = st.size; let carry = Buffer.alloc(0); let scanned = 0; let truncated = false; let found = false;
    while (pos > 0 && !found) {
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
        if (nl < 0) { carry = buf; continue; }
        carry = buf.subarray(0, nl); body = buf.subarray(nl + 1);
      }
      const ls = body.toString('utf8').split('\n');
      for (let i = ls.length - 1; i >= 0; i--) {
        const l = ls[i];
        if (l.includes(RESULT_MARK) && isResult(l)) { found = true; break; }
        if (l.includes(ASSISTANT_MARK)) lines.push(l);
      }
    }
    const est = CE.estimateLines(lines.reverse(), prices);
    const out = truncated && !found ? { ...(est || { messages: 0, usd: null, tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0 }, unpriced_models: [] }), truncated: true } : est && { ...est, truncated: false };
    if (prices === PRICES && cap === TAIL_CAP) {
      if (memo.size >= 64) memo.delete(memo.keys().next().value);
      memo.set(streamPath, { size: st.size, mtimeMs: st.mtimeMs, est: out });
    }
    return out;
  } catch { return null; } finally { try { fs.closeSync(fd); } catch { /* closed */ } }
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LIVE = new Set(['starting', 'running']);

// The in-flight estimate of one worker row, or null: only a live Claude Code worker has a turn in flight.
function workerInFlight(dataDir, w) {
  if (!w || w.substrate !== 'claude-code' || !LIVE.has(w.state) || typeof w.id !== 'string' || !SAFE_ID.test(w.id)) return null;
  return tailEstimate(require('node:path').join(dataDir, 'workers', w.id, 'stream.jsonl'));
}

// The fields a reader shows beside a worker's reported cost: the estimate, labelled; nulls when nothing is in flight.
function workerFigures(dataDir, w) {
  const e = workerInFlight(dataDir, w);
  return { cost_in_flight_usd: e && typeof e.usd === 'number' ? e.usd : null, cost_in_flight_messages: e ? e.messages : null, cost_in_flight_source: e ? 'in flight (estimate)' : null };
}

module.exports = { createAccumulator, tailEstimate, workerInFlight, workerFigures, TAIL_CAP };
