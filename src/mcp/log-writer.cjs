'use strict';
// log-writer.cjs — build 12 step A1: the adapter's `--log` writer, split out of belay-mcp.cjs (500-line
// budget). Two properties the old inline appendFileSync did not have, both needed now that every worker
// adapter logs (ADR 0026 §3: each lease-keepalive tick's line is the proof the keepalive worked).
//
// Not blocking: lines are queued in memory and written by one asynchronous append at a time, so a slow
// disk never stalls the JSON-RPC loop. The graceful shutdown awaits drain(). On any other exit the exit
// hook writes, in order and synchronously, the batch still in flight (kept until its callback runs) and
// whatever is queued behind it. What can still go wrong then: a batch the OS had already written when
// the process ended is written a second time (identical lines, same timestamp and pid), and a process
// killed outright, which runs no exit hook, loses the in-flight batch and the queue.
//
// Bounded per launch: caps count this process's own bytes. Wire frames (`>>` and `<<`) stop at FRAME_CAP;
// the adapter's own lines (`##`, `!!`: starts, ticks, exits) continue to FILE_CAP, then one `log capped`
// line says so. The file is shared across a worker's launches, so the run manager rotates it at launch
// (rotateWireLog in src/run/wire-log.cjs) and the file never holds more than one launch past the
// rotation threshold, plus a rotated adapter.log.1. The queue is bounded by the same budget.

const fs = require('node:fs');

const FRAME_CAP = 2 * 1024 * 1024;
const FILE_CAP = 4 * 1024 * 1024;
const FRAME_DIRS = new Set(['>>', '<<']);

function createLogWriter(file, { frameCap = FRAME_CAP, fileCap = FILE_CAP, now = () => new Date().toISOString() } = {}) {
  if (!file) return Object.assign(() => {}, { flushSync() {}, drain: () => Promise.resolve(), bytes: () => 0 });
  let size = 0; // bytes this process has handed to the file, never the file's earlier content
  let inflight = null; // the chunk handed to the async append whose callback has not run
  let queued = [];
  let queuedBytes = 0;
  let writing = false;
  let capped = false;
  const drained = [];

  const pump = () => {
    if (writing || !queued.length) return;
    const chunk = queued.join('');
    size += queuedBytes; queued = []; queuedBytes = 0;
    writing = true; inflight = chunk;
    fs.appendFile(file, chunk, () => { writing = false; inflight = null; if (queued.length) pump(); else drained.splice(0).forEach((r) => r()); }); // an error drops the chunk: a log must not take the adapter down
  };

  // One tick later, so lines logged in the same turn go out as one append.
  let scheduled = false;
  const schedule = () => { if (scheduled) return; scheduled = true; setImmediate(() => { scheduled = false; pump(); }); };

  const log = (dir, line) => {
    if (capped) return;
    const text = `${now()} ${process.pid} ${dir} ${String(line).slice(0, 2000)}\n`;
    const limit = FRAME_DIRS.has(dir) ? frameCap : fileCap;
    const len = Buffer.byteLength(text);
    if (size + queuedBytes + len > limit) {
      if (FRAME_DIRS.has(dir)) return; // frames are dropped quietly; own lines still have room
      capped = true;
      queued.push(`${now()} ${process.pid} ## log capped at ${fileCap} bytes; later lines are not written\n`);
      schedule();
      return;
    }
    queued.push(text); queuedBytes += len;
    schedule();
  };
  // The exit path: in-flight batch first, then the queue, so lines never land out of order.
  log.flushSync = () => {
    const out = (inflight || '') + queued.join('');
    if (!out) return;
    try { fs.appendFileSync(file, out); } catch { /* as above */ }
    inflight = null; size += queuedBytes; queued = []; queuedBytes = 0;
  };
  // Resolves when nothing is queued or in flight, or after ms: the shutdown path waits on it so the
  // append in flight is not cut off by process.exit, and a stuck disk cannot hold the exit.
  log.drain = (ms = 500) => (!writing && !queued.length && !scheduled ? Promise.resolve() : new Promise((resolve) => {
    const timer = setTimeout(() => { const i = drained.indexOf(r); if (i >= 0) drained.splice(i, 1); resolve(); }, ms).unref();
    const r = () => { clearTimeout(timer); resolve(); }; // answered by the write: the timer goes with it
    drained.push(r);
  }));
  log.bytes = () => size + queuedBytes;
  return log;
}

module.exports = { createLogWriter, FRAME_CAP, FILE_CAP };
