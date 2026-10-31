'use strict';
// inflight-cost.cjs — what a turn that has not ended has cost so far, from its own stream (ADR 0066 amendment, proposed).
// Claude Code reports cost only on a turn's `result` line, so a long turn's spend reaches the ledger in one jump when it ends. Between
// two `result` lines the stream already carries each assistant message's usage; this prices those messages with the same table and
// arithmetic as ADR 0068's estimate (usage-price.cjs). The figure is an ESTIMATE at API rates, kept apart from the reported cost and
// replaced by it at the turn's end: a `result` line empties it, and so does a `system/init` line (a new turn or life begins, and the
// messages before it that no result reported are ADR 0068's, not in flight).
//
// Only the run process reads streams. The accumulator keeps a running sum as lines arrive (one message once, at its last count; no
// message is priced twice). The tracker follows each live worker's stream file from a remembered offset, a bounded number of bytes per
// call, so a long turn is read once, never again. The run process publishes the figures on the run row's budget record; every read
// path (status, agents, receipts) reads that record and parses no stream.

const fs = require('node:fs');
const path = require('node:path');
const { PRICES, messageUsd } = require('./usage-price.cjs');
const CE = require('./cost-estimate.cjs');

const RESULT_MARK = '"type":"result"';
const ASSISTANT_MARK = '"type":"assistant"';
const INIT_MARK = '"subtype":"init"';
const CHUNK = 1024 * 1024; // bytes read from one stream in one step
const STEPS = 4; // steps per stream per call: a 9 MB turn is caught up in a few calls, and the run process never blocks long
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LIVE = new Set(['starting', 'running']);

const typeOf = (line, type) => { try { const j = JSON.parse(line); return !!j && j.type === type ? j : null; } catch { return null; } };

// A running total. feed(line) takes one stream line; snapshot() is the in-flight estimate, or null when no assistant message has
// arrived since the last `result` or `init`.
function createAccumulator(prices = PRICES) {
  let byId = new Map(); // message id -> its usd (null when the model has no price)
  let anon = 0;
  let usd = 0; let unpriced = new Set();
  const reset = () => { byId = new Map(); anon = 0; usd = 0; unpriced = new Set(); };
  return {
    feed(line) {
      if (typeof line !== 'string') return;
      if (line.includes(ASSISTANT_MARK)) {
        const m = CE.lineUsage(line);
        if (!m) return;
        const d = messageUsd(prices, m.model, m.u);
        if (m.id) {
          const prev = byId.get(m.id);
          if (prev) usd -= prev.d || 0; // the same API message streamed again: counted once, at its last count
          byId.set(m.id, { d });
        } else anon += 1;
        usd += d || 0;
        if (d === null) unpriced.add(m.model);
        return;
      }
      if (line.includes(RESULT_MARK)) { if (typeOf(line, 'result')) reset(); return; }
      if (line.includes(INIT_MARK)) { const j = typeOf(line, 'system'); if (j && j.subtype === 'init') reset(); }
    },
    snapshot() {
      const messages = byId.size + anon;
      if (!messages) return null;
      return { messages, usd: unpriced.size ? null : usd, unpriced_models: [...unpriced] };
    },
  };
}

// Follows live workers' stream files. update(rows) reads the next bytes of each live worker's stream (from where the last call
// stopped) into its accumulator; figures() is the sum over the workers followed.
function createTracker({ dataDir, prices = PRICES, chunk = CHUNK, steps = STEPS }) {
  const follow = new Map(); // worker id -> { path, offset, carry, acc, caughtUp }
  function advance(id) {
    if (!SAFE_ID.test(id)) return;
    let f = follow.get(id);
    if (!f) { f = { path: path.join(dataDir, 'workers', id, 'stream.jsonl'), offset: 0, carry: Buffer.alloc(0), acc: createAccumulator(prices), caughtUp: false }; follow.set(id, f); }
    let fd;
    try { fd = fs.openSync(f.path, 'r'); } catch { f.caughtUp = true; return; } // no stream yet: nothing in flight
    try {
      const size = fs.fstatSync(fd).size;
      if (size < f.offset) { f.offset = 0; f.carry = Buffer.alloc(0); f.acc = createAccumulator(prices); } // a different file now: start over
      for (let i = 0; i < steps && f.offset < size; i++) {
        const buf = Buffer.allocUnsafe(Math.min(chunk, size - f.offset));
        let got = 0;
        while (got < buf.length) { const r = fs.readSync(fd, buf, got, buf.length - got, f.offset + got); if (r <= 0) break; got += r; }
        if (!got) break;
        f.offset += got;
        const all = f.carry.length ? Buffer.concat([f.carry, buf.subarray(0, got)]) : buf.subarray(0, got);
        const nl = all.lastIndexOf(10);
        if (nl < 0) { f.carry = Buffer.from(all); continue; } // one line longer than a chunk: keep reading
        f.carry = Buffer.from(all.subarray(nl + 1));
        for (const l of all.subarray(0, nl).toString('utf8').split('\n')) f.acc.feed(l);
      }
      f.caughtUp = f.offset >= size;
    } catch { /* an unreadable stream adds nothing this time */ } finally { try { fs.closeSync(fd); } catch { /* closed */ } }
  }
  return {
    // rows: worker rows (id, substrate, state). Follows the live Claude Code ones and forgets the rest: a worker that is no longer live
    // has no turn in flight (its reported cost, or ADR 0068's estimate at death, carries it).
    update(rows) {
      const live = new Set();
      for (const w of rows || []) if (w && w.substrate === 'claude-code' && LIVE.has(w.state) && typeof w.id === 'string') { live.add(w.id); advance(w.id); }
      for (const id of [...follow.keys()]) if (!live.has(id)) follow.delete(id);
    },
    // Reads the next bytes of one followed worker now (its turn just ended and its reported cost reached the ledger).
    refresh(id) { if (follow.has(id)) advance(id); },
    figures() {
      const by_worker = {}; const partial = []; const unpriced = [];
      let usd = 0;
      for (const [id, f] of follow) {
        const s = f.acc.snapshot();
        if (!s) continue;
        if (typeof s.usd === 'number') { by_worker[id] = s.usd; usd += s.usd; } else unpriced.push(id);
        if (!f.caughtUp) partial.push(id);
      }
      return { usd, by_worker, partial, unpriced };
    },
  };
}

// The fields a reader shows beside a worker's reported cost, from the figures the run process published (run-budget.cjs).
function workerFigures(pub, w) {
  const usd = pub && pub.by_worker && w && typeof pub.by_worker[w.id] === 'number' ? pub.by_worker[w.id] : null;
  const part = !!(pub && w && Array.isArray(pub.partial) && pub.partial.includes(w.id));
  return { cost_in_flight_usd: usd, cost_in_flight_source: usd == null ? null : 'in flight (estimate)', cost_in_flight_partial: usd == null ? null : part };
}

module.exports = { createAccumulator, createTracker, workerFigures, LIVE };
