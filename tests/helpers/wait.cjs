'use strict';
// wait.cjs — how a test waits on a child process without guessing a time. A wait names the real event it needs and
// a deadline that only says "something is wrong": the deadline is generous (a slow runner, a Defender scan on each
// process start, a 15.6 ms timer tick) and is never a product bound. A product bound is asserted by advancing an
// injected clock (fake-timers.cjs), or, for an upper bound on real time, with upTo().

const { CLOSE_GRACE_MS, KILL_WAIT_MS } = require('../../src/core/gpu.cjs');

const UP_DEADLINE = 30000; // a child is up: a cold node start with a virus scan, on a loaded machine
const GRACE = 3000; // slack on a product's own upper bound, for a slow runner
const upTo = (boundMs) => boundMs + GRACE;
const GONE_DEADLINE = CLOSE_GRACE_MS + KILL_WAIT_MS + GRACE + 2000; // a close's worst case (grace, then the kill wait) plus slack

const tick = (ms) => new Promise(r => setTimeout(r, ms));

// waitFor(pred, { deadlineMs, label }) polls a predicate until it returns something truthy and resolves with it.
// waitFor({ emitter, event, match }, { deadlineMs }) resolves with the arguments of the first matching event as an array.
async function waitFor(what, { deadlineMs = UP_DEADLINE, label = 'the condition', pollMs = 10 } = {}) {
  if (typeof what === 'function') {
    const t0 = Date.now();
    for (;;) {
      const v = await what();
      if (v) return v;
      if (Date.now() - t0 >= deadlineMs) throw new Error(`timed out after ${deadlineMs} ms waiting for ${label}`);
      await tick(pollMs);
    }
  }
  const { emitter, event, match } = what;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { emitter.removeListener(event, on); reject(new Error(`timed out after ${deadlineMs} ms waiting for ${event}`)); }, deadlineMs);
    const on = (...args) => { if (match && !match(...args)) return; clearTimeout(timer); emitter.removeListener(event, on); resolve(args); };
    emitter.on(event, on);
  });
}

// The child's announcement { event, ...} (a message with no id), optionally one that satisfies `match`.
const waitEvent = (child, event, { deadlineMs = UP_DEADLINE, match } = {}) => waitFor({ emitter: child, event: 'message', match: (m) => m && m.event === event && (!match || match(m)) }, { deadlineMs }).then(([m]) => m);

// Counts the child's progress messages; resolves when `n` have arrived (for a rank, one per chunk).
function countProgress(child) {
  let n = 0;
  const waiters = [];
  child.on('message', (m) => { if (m && m.progress) { n += 1; for (const w of waiters.filter(x => n >= x.n)) { waiters.splice(waiters.indexOf(w), 1); w.res(n); } } });
  return { get count() { return n; }, reach: (k, deadlineMs = UP_DEADLINE) => (n >= k ? Promise.resolve(n) : new Promise((res, rej) => { const w = { n: k, res }; waiters.push(w); setTimeout(() => rej(new Error(`timed out waiting for ${k} progress messages (saw ${n})`)), deadlineMs).unref(); })) };
}

// Resolves with the first JSON line a child prints on `stream` that has `key` (a fixture's one-line report), or rejects at the deadline.
function waitLine(stream, key, { deadlineMs = UP_DEADLINE } = {}) {
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`no ${key} line within ${deadlineMs} ms; output so far: ${out}`)), deadlineMs);
    stream.on('data', (d) => { out += d; for (const l of out.split(/\r?\n/)) if (l.includes(key)) { try { const j = JSON.parse(l); clearTimeout(timer); return resolve(j); } catch { /* a partial line */ } } });
  });
}

// Resolves true once the process is gone, false at the deadline (which defaults to a close's worst case plus slack). `target` is a
// ChildProcess handle the test holds, or an identity from proc-gone.identify() taken while the process was alive. A bare pid is refused:
// once the process exits, Windows may hand its number to an unrelated one, which a pid check reads as "still alive" (ADR 0039).
async function waitGone(target, { deadlineMs = GONE_DEADLINE } = {}) {
  const G = require('./proc-gone.cjs');
  if (target && typeof target.once === 'function') return G.childExited(target, { deadlineMs });
  if (!target || typeof target !== 'object' || !Number.isInteger(target.pid)) throw new TypeError('waitGone needs a child handle or an identity from proc-gone.identify(), not a bare pid');
  return G.waitGone(target, { deadlineMs, intervalMs: 20 });
}

module.exports = { waitLine, waitFor, waitEvent, waitGone, countProgress, upTo, tick, UP_DEADLINE, GRACE, GONE_DEADLINE };
