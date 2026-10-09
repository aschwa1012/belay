'use strict';
// stream-tail.cjs — a bounded, backwards read of a JSONL file for `belay transcript --tail` (ADR 0036
// decision 8). fs only. A window of complete lines is read from the end of the file; `isDone` is asked
// whether it holds enough, and if not the window grows fourfold (never past maxBytes) until it does or
// it reaches byte 0. The file is never read whole to be sliced: bytes_read is what was actually read,
// over every step (each growth reads only the new bytes before the window), including one lookbehind
// byte to tell a cut line from a whole one.
// Like the whole-file read, only complete lines count: bytes after the last newline are left out. A
// window that does not start at byte 0 loses its first line unless the byte before it is a newline.

const fs = require('node:fs');

const START_BYTES = 64 * 1024;
const MAX_BYTES = 8 * 1024 * 1024;

function readRange(fd, start, length) {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const n = fs.readSync(fd, buf, got, length - got, start + got);
    if (n <= 0) break;
    got += n;
  }
  return got === length ? buf : buf.subarray(0, got);
}

// Returns { lines, bytes_read, file_bytes, reached_start, truncated_during_read }. If a growth read
// returns fewer bytes than the file's size promised (the file shrank under the read) the growth stops
// at once, the previous window's lines are returned and truncated_during_read is true; bytes that are
// not contiguous with the window are never joined to it. A missing file is file_bytes null, no lines,
// reached_start true. `isDone(lines, reachedStart)` is called per window; the last window is returned.
function growTail(file, isDone, { startBytes = START_BYTES, maxBytes = MAX_BYTES } = {}) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (e) {
    if (e.code === 'ENOENT') return { lines: [], bytes_read: 0, file_bytes: null, reached_start: true, truncated_during_read: false };
    throw e;
  }
  try {
    const size = fs.fstatSync(fd).size;
    let want = startBytes, buf = Buffer.alloc(0), lo = size, prev = null; // buf holds bytes [lo, size)
    for (;;) {
      const n = Math.min(size, want, maxBytes);
      const start = size - n;
      const newLo = start > 0 ? start - 1 : 0;
      if (newLo < lo) {
        const more = readRange(fd, newLo, lo - newLo);
        if (more.length < lo - newLo) {
          return prev
            ? { ...prev, truncated_during_read: true }
            : { lines: [], bytes_read: buf.length + more.length, file_bytes: size, reached_start: false, truncated_during_read: true };
        }
        buf = Buffer.concat([more, buf]); lo = newLo;
      }
      const bytesRead = buf.length;
      let from = 0, body = buf;
      if (start > 0) { // buf[0] is the lookbehind byte
        body = buf.subarray(1);
        if (buf[0] !== 0x0a) { const nl = body.indexOf(0x0a); from = nl < 0 ? body.length : nl + 1; }
      }
      const lastNl = body.lastIndexOf(0x0a);
      const lines = lastNl >= from ? body.subarray(from, lastNl).toString('utf8').split('\n') : [];
      const reachedStart = start === 0;
      if (reachedStart || n >= maxBytes || isDone(lines, reachedStart)) {
        return { lines, bytes_read: bytesRead, file_bytes: size, reached_start: reachedStart, truncated_during_read: false };
      }
      prev = { lines, bytes_read: bytesRead, file_bytes: size, reached_start: reachedStart };
      want = n * 4;
    }
  } finally { fs.closeSync(fd); }
}

module.exports = { growTail, START_BYTES, MAX_BYTES };
