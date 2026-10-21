'use strict';
// wait.cjs — how a test waits on a child process without guessing a time. A wait names the real event it needs and
// a deadline that only says "something is wrong": the deadline is generous (a slow runner, a Defender scan on each
// process start, a 15.6 ms timer tick) and is never a product bound. A product bound is asserted by advancing an
// injected clock (fake-timers.cjs), or, for an upper bound on real time, with upTo().

const { CLOSE_GRACE_MS, KILL_WAIT_MS } = require('../../src/core/gpu.cjs');
const { pidAlive } = require('../../src/core/lock.cjs');

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

// Resolves true once the pid is not alive, false at the deadline (which defaults to a close's worst case plus slack).
async function waitGone(pid, { deadlineMs = GONE_DEADLINE } = {}) {
  const t0 = Date.now();
  while (pidAlive(pid) && Date.now() - t0 < deadlineMs) await tick(20);
  return !pidAlive(pid);
}

module.exports = { waitFor, waitEvent, waitGone, countProgress, upTo, tick, UP_DEADLINE, GRACE, GONE_DEADLINE };
