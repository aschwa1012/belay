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
const MAX_SCAN = 64 * 1024 * 1024; // the most a newly followed stream is scanned backwards for its last turn boundary
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

// A newly followed stream starts at its last `result` or `init` line, so turns that already ended (their cost is in the ledger) are
// never counted as in flight, whatever the catch-up bound. The boundary is found by scanning back from the end of the file, a chunk
// at a time inside the same per-call byte budget as the forward read; the worker counts for nothing (and is listed partial) until
// it is found. Only the unfinished line at the front of the scanned part is kept, so the scan is linear. A stream with no boundary
// in MAX_SCAN bytes starts at the first whole line of what was scanned, and stays partial until a result or init line is read.
function newFollow(dataDir, id, prices) {
  return { path: path.join(dataDir, 'workers', id, 'stream.jsonl'), offset: 0, carry: Buffer.alloc(0), acc: createAccumulator(prices), caughtUp: false, scan: null, truncated: false };
}
function resetFollow(f, prices) { f.offset = 0; f.carry = Buffer.alloc(0); f.acc = createAccumulator(prices); f.caughtUp = false; f.scan = null; f.truncated = false; f.fresh = true; }
const isBoundary = (line) => (line.includes(RESULT_MARK) || line.includes(INIT_MARK)) && !!(typeOf(line, 'result') || (typeOf(line, 'system') || {}).subtype === 'init');

// One backward step: reads up to `budget.n` chunks. Sets f.offset and clears f.scan when the start is found; returns nothing.
function scanBack(fd, f, size, chunk, budget) {
  if (!f.scan) f.scan = { pos: size, frag: Buffer.alloc(0), scanned: 0 }; // frag: the unfinished line at the front of what was read
  const sc = f.scan;
  while (budget.n > 0) {
    if (sc.pos <= 0) { f.offset = 0; f.scan = null; return; }
    if (sc.scanned >= MAX_SCAN) { f.offset = sc.pos + sc.frag.length + 1 <= size ? sc.pos + sc.frag.length + 1 : size; f.truncated = true; f.scan = null; return; }
    budget.n -= 1;
    const n = Math.min(chunk, sc.pos); sc.pos -= n; sc.scanned += n;
    const blk = Buffer.allocUnsafe(n);
    let got = 0;
    while (got < n) { const r = fs.readSync(fd, blk, got, n - got, sc.pos + got); if (r <= 0) break; got += r; }
    const buf = Buffer.concat([blk.subarray(0, got), sc.frag]);
    let end = buf.length;
    for (;;) {
      const nl = end > 0 ? buf.lastIndexOf(10, end - 1) : -1;
      if (nl < 0) { // the front line: whole only when the file starts here
        if (sc.pos === 0 && end > 0 && isBoundary(buf.subarray(0, end).toString('latin1'))) { f.offset = 0; f.scan = null; return; }
        sc.frag = Buffer.from(buf.subarray(0, end));
        break;
      }
      if (isBoundary(buf.subarray(nl + 1, end).toString('latin1'))) { f.offset = sc.pos + nl + 1; f.scan = null; return; }
      end = nl;
    }
  }
}

// Follows live workers' stream files. update(rows) reads the next bytes of each live worker's stream (from where the last call
// stopped) into its accumulator; figures() is the sum over the workers followed.
function createTracker({ dataDir, prices = PRICES, chunk = CHUNK, steps = STEPS }) {
  const follow = new Map(); // worker id -> { path, offset, carry, acc, caughtUp, scan, truncated }
  function advance(id) {
    if (!SAFE_ID.test(id)) return;
    let f = follow.get(id);
    if (!f) { f = newFollow(dataDir, id, prices); f.fresh = true; follow.set(id, f); }
    let fd;
    try { fd = fs.openSync(f.path, 'r'); } catch { f.caughtUp = true; return; } // no stream yet: nothing in flight
    try {
      const size = fs.fstatSync(fd).size;
      if (!f.fresh && size < f.offset) resetFollow(f, prices); // a different file now: find its last turn afresh
      const budget = { n: steps }; // chunks read in this call, scanning and reading together
      if (f.fresh) { scanBack(fd, f, size, chunk, budget); if (f.scan) { f.caughtUp = false; return; } f.fresh = false; }
      while (budget.n > 0 && f.offset < size) {
        budget.n -= 1;
        const buf = Buffer.allocUnsafe(Math.min(chunk, size - f.offset));
        let got = 0;
        while (got < buf.length) { const r = fs.readSync(fd, buf, got, buf.length - got, f.offset + got); if (r <= 0) break; got += r; }
        if (!got) break;
        f.offset += got;
        const all = f.carry.length ? Buffer.concat([f.carry, buf.subarray(0, got)]) : buf.subarray(0, got);
        const nl = all.lastIndexOf(10);
        if (nl < 0) { f.carry = Buffer.from(all); continue; } // one line longer than a chunk: keep reading
        f.carry = Buffer.from(all.subarray(nl + 1));
        for (const l of all.subarray(0, nl).toString('utf8').split('\n')) { if (f.truncated && (l.includes(RESULT_MARK) || l.includes(INIT_MARK))) f.truncated = false; f.acc.feed(l); }
      }
      f.caughtUp = f.offset >= size && !f.scan;
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
    // A usage row for the worker means its turn ended and the reported cost is in the ledger: if the bounded read did not reach the
    // turn's result line, what the accumulator holds is that turn, so it is dropped and the follow starts again at the last boundary.
    refresh(id) {
      if (!follow.has(id)) return;
      advance(id);
      const f = follow.get(id);
      if (f && !f.caughtUp) resetFollow(f, prices);
    },
    figures() {
      const by_worker = {}; const partial = []; const unpriced = [];
      let usd = 0;
      for (const [id, f] of follow) {
        if (f.scan) { partial.push(id); continue; } // still looking for its turn: counts for nothing yet
        const s = f.acc.snapshot();
        if (!s) continue;
        if (typeof s.usd === 'number') { by_worker[id] = s.usd; usd += s.usd; } else unpriced.push(id);
        if (!f.caughtUp || f.truncated) partial.push(id);
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
