'use strict';
// fake-timers.cjs — an injected { now, setTimeout, clearTimeout } for the parent side of a child client (the `timers`
// option of GpuClient, CpuRerankClient, cpuRerankProvider, the rerank stage and closeAll). Time moves only when a test
// advances it, so a product bound is asserted exactly: advance to bound-1 and the request is still pending, advance 1
// and it is rejected. The same shape as `clock` in memory-index-rank and `opts.now` in copy-sweep. Not node:test
// mock.timers, which is global and cannot reach a child process.

function fakeTimers(start = 1000000) {
  let t = start, seq = 0;
  const q = new Map();
  const timers = {
    now: () => t,
    setTimeout: (fn, ms) => { const id = ++seq; q.set(id, { at: t + Math.max(0, ms || 0), fn, id }); return { id, unref() { return this; }, ref() { return this; } }; },
    clearTimeout: (h) => { if (h && h.id) q.delete(h.id); },
  };
  const settle = () => new Promise(r => setImmediate(r));
  // Moves the clock forward by `ms`, firing every timer that falls due in order, then lets the promises that follow run.
  async function advance(ms) {
    const end = t + ms;
    for (;;) {
      let next = null;
      for (const x of q.values()) if (x.at <= end && (!next || x.at < next.at || (x.at === next.at && x.id < next.id))) next = x;
      if (!next) break;
      q.delete(next.id);
      t = Math.max(t, next.at);
      next.fn();
      await settle();
    }
    t = end;
    await settle();
  }
  return { timers, advance, settle, pending: () => q.size };
}

module.exports = { fakeTimers };

// Tracks a promise without awaiting it: { settled, value, error, done } where `done` resolves once it has settled
// (never rejects). A test advances an injected clock and then reads `settled`, so "still pending at bound - 1" is an assertion.
function outcome(p) {
  const o = { settled: false, value: undefined, error: undefined };
  o.done = p.then((v) => { o.settled = true; o.value = v; }, (e) => { o.settled = true; o.error = e; });
  return o;
}

module.exports.outcome = outcome;
