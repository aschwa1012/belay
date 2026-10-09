'use strict';
// unresponsive.cjs — owners this process has seen miss one dial or answer deadline, as a backoff.
//
// Invariant 7: a connect to a wedged owner succeeds at the OS level, and libuv's Windows pipe server has
// only a handful (4) of pending instances. Once they are used up a further dial sits in a 30 s
// WaitNamedPipeW on a threadpool thread that cannot be cancelled. So after a read times out against an
// owner (keyed by pipe path and owner pid, so a re-elected owner is a new key) this process does not
// dial it for UNRESPONSIVE_BACKOFF_MS: reads go to copy-then-read. After the backoff the next read dials
// once; an answer clears the mark, a timeout re-arms it. Writes ignore the mark entirely.

const UNRESPONSIVE_BACKOFF_MS = 10000;

const marks = new Map();
let clock = () => Date.now();
const keyOf = (pipe, pid) => `${pipe}|${pid}`;

function mark(pipe, pid, info) {
  const at = clock();
  const m = { pipe, owner_pid: pid, at, until: at + UNRESPONSIVE_BACKOFF_MS, ...info };
  marks.set(keyOf(pipe, pid), m);
  return m;
}
// The live mark, or null once its backoff has passed (the entry stays until an answer clears it).
function get(pipe, pid) {
  if (!marks.size) return null;
  const m = marks.get(keyOf(pipe, pid));
  return m && clock() < m.until ? m : null;
}
function clearPipe(pipe) {
  if (!marks.size) return;
  for (const [k, m] of marks) if (m.pipe === pipe) marks.delete(k);
}
function describe(m) {
  return `owner unresponsive (${m.what || 'dial'} timed out at ${m.timeout_ms} ms; pid ${m.owner_pid}, ${m.pipe}); read from copy until ${new Date(m.until).toISOString()}`;
}
function describeStatus(m) {
  return `marked unresponsive at ${new Date(m.at).toISOString()} (${m.what || 'dial'} timed out), no ping sent until ${new Date(m.until).toISOString()}`;
}
function setClock(fn) { clock = fn || (() => Date.now()); } // tests only
function reset() { marks.clear(); clock = () => Date.now(); } // tests only

module.exports = { UNRESPONSIVE_BACKOFF_MS, mark, get, clearPipe, describe, describeStatus, setClock, reset };
