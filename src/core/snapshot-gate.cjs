'use strict';
// snapshot-gate.cjs — ADR 0048 decision 2. Every process snapshot a Node process takes goes through one gate.
// The gate holds at most one snapshot in flight and one waiting that has not started, and a caller is never
// given the snapshot in flight: it joins the waiting one, which starts after the one in flight ends. One
// integer `seq`, which only goes up, stamps signals, requests and snapshot starts, so two events never tie.
// A caller about to act on a snapshot asks `fresh(startSeq)`: false when a signal was sent in this process
// after the snapshot started (ADR 0039's ordering rule). The gate is pure: `take` is injected.

// `take({ timeoutMs, batch })` -> Promise<Map|null>. The gate enforces `timeoutMs` itself, so a take that never
// settles still ends. `batch` is { startSeq, callers, kinds } and is read by the take's own log at its end.
function createGate({ take, timeoutMs = 15000, now = Date.now } = {}) {
  let seq = 0;
  let lastSignalSeq = 0;
  let inflight = null;
  let waiting = null;
  const harvesters = new Set();
  const idleWaiters = [];

  const signal = () => { lastSignalSeq = ++seq; return lastSignalSeq; };
  const fresh = (startSeq) => Number.isInteger(startSeq) && startSeq > lastSignalSeq;

  function newBatch() {
    const b = { startSeq: null, callers: 0, kinds: new Set(), startedAt: null };
    b.promise = new Promise((res) => { b.resolve = res; });
    return b;
  }
  function start(b) {
    inflight = b;
    b.startSeq = ++seq; // before the spawn: the query runs after every signal stamped so far
    b.startedAt = now();
    let settled = false;
    let timer = null;
    const done = (snap, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const endedAt = now();
      const r = { snap: snap || null, error: snap ? null : (error || 'unreadable'), startSeq: b.startSeq, startedAt: b.startedAt, endedAt, ms: endedAt - b.startedAt, callers: b.callers, kinds: [...b.kinds] };
      b.resolve(r);
      // The callers served by this snapshot act in microtasks right after the resolve, and a signal they send must
      // be stamped before the next snapshot starts, or that snapshot would be stale for them by construction. So the
      // gate stays "in flight" until the next macrotask: requests that arrive meanwhile join the waiting batch, and
      // the waiting batch and the harvesters go after the current users have acted.
      setImmediate(() => {
        inflight = null;
        if (waiting) { const next = waiting; waiting = null; start(next); }
        else for (const w of idleWaiters.splice(0)) w();
        // After the next snapshot started, so a harvester that requests one sees `inflight` accurate.
        for (const h of [...harvesters]) { try { h(r); } catch { /* a harvester never changes a snapshot */ } }
      });
    };
    timer = setTimeout(() => done(null, 'timeout'), timeoutMs);
    if (timer.unref) timer.unref();
    try { Promise.resolve(take({ timeoutMs, batch: b })).then((m) => done(m, m ? null : 'unreadable'), (e) => done(null, `error: ${(e && e.message) || e}`)); }
    catch (e) { done(null, `error: ${(e && e.message) || e}`); }
  }

  // -> Promise<{ snap, error, startSeq, reqSeq, ms, waitedMs, callers, kinds }>. Never rejects. `deadlineMs`
  // ends this caller's wait only (error 'deadline'); the shared snapshot goes on for the others.
  function request({ kind = 'kill', deadlineMs = null } = {}) {
    const reqSeq = ++seq;
    const reqAt = now();
    let b;
    if (!inflight) { b = newBatch(); b.callers++; b.kinds.add(kind); start(b); }
    else { if (!waiting) waiting = newBatch(); b = waiting; b.callers++; b.kinds.add(kind); }
    const served = b.promise.then((r) => ({ ...r, reqSeq, waitedMs: now() - reqAt }));
    if (deadlineMs == null) return served;
    let timer = null;
    const cut = new Promise((res) => { timer = setTimeout(() => res({ snap: null, error: 'deadline', startSeq: null, reqSeq, ms: now() - reqAt, waitedMs: now() - reqAt, callers: 0, kinds: [kind] }), Math.max(0, deadlineMs)); if (timer.unref) timer.unref(); });
    return Promise.race([served, cut]).finally(() => clearTimeout(timer));
  }

  // Called with each finished snapshot (ok or not), for a caller that wants any snapshot taken after a point.
  function onSnapshot(fn) { harvesters.add(fn); return () => harvesters.delete(fn); }
  // Resolves once no snapshot is in flight or waiting: a test that counts its own child processes waits for this first,
  // because a snapshot's PowerShell is one of them.
  const whenIdle = () => (!inflight && !waiting ? Promise.resolve() : new Promise((r) => idleWaiters.push(r)));
  const peek = () => ({ seq, lastSignalSeq, inflight: inflight ? inflight.startSeq : null, waiting: waiting ? waiting.callers : 0 });
  const stamp = () => ++seq; // a request-order stamp for a caller that needs "after now" (the spawn read)
  return { request, signal, fresh, onSnapshot, peek, stamp, whenIdle };
}

module.exports = { createGate };
