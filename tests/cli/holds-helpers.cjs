'use strict';
// holds-helpers.cjs: the polling helpers tests/cli/run-wake.test.cjs shares, split out so that file stays under 500 lines.
// Each is exactly what that file had inline, unchanged.

const fs = require('node:fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A3: the read `fn` wraps (a store read, a file read) is raced against this bound. A read that has
// not settled after READ_BOUND_MS is a hung read, not a slow one, and ends the wait with `null` at
// once instead of being retried — a caller whose own assertion depended on a real value then fails on
// that assertion, rather than the whole suite hanging on a read that will never come back.
const READ_BOUND_MS = 5000;

function boundedRead(fn) {
  return () => new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ hung: true });
    }, READ_BOUND_MS);
    Promise.resolve().then(fn).then(
      (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ hung: false, value: v }); } },
      () => { if (!settled) { settled = true; clearTimeout(timer); resolve({ hung: false, value: null }); } }
    );
  });
}

async function waitUntil(fn, timeoutMs, stepMs = 100) {
  const t0 = Date.now();
  const read = boundedRead(fn);
  for (;;) {
    const r = await read();
    if (r.hung) return null; // a hung read fails the wait at once; it is never retried
    if (r.value) return r.value;
    if (Date.now() - t0 >= timeoutMs) return null;
    await sleep(stepMs);
  }
}

function waitForFileLine(filePath, needle, timeoutMs) {
  return waitUntil(() => {
    let text = '';
    try { text = fs.readFileSync(filePath, 'utf8'); } catch { return null; }
    return text.includes(needle) ? true : null;
  }, timeoutMs, 100);
}

// Puts the run's own clock (at_ms counts from the orchestrator's t0) on the test's clock: samples the holds file
// every 20 ms and remembers when each hold moment was first seen. A moment's at_ms against the time it was seen
// gives the offset between the two clocks, good to the sampling interval.
function sampleHolds(holdsFile) {
  const seen = []; // { hold, seenAt }
  const timer = setInterval(() => {
    let lines = [];
    try { lines = fs.readFileSync(holdsFile, 'utf8').split(/\r?\n/).filter(Boolean); } catch { return; }
    while (seen.length < lines.length) {
      let hold = null; try { hold = JSON.parse(lines[seen.length]); } catch { return; }
      seen.push({ hold, seenAt: Date.now() });
    }
  }, 20);
  timer.unref();
  return { seen, stop: () => clearInterval(timer) };
}

module.exports = { READ_BOUND_MS, boundedRead, waitUntil, waitForFileLine, sampleHolds };
