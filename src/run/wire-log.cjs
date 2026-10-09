'use strict';
// wire-log.cjs — build step 6d: `wireLogPath` and `wireLogHasToolsList` moved verbatim out of
// launch.cjs to keep it under its own line budget (design item 4). Where Codex's adapter writes its wire log, and the ADR 0001 §8 predicate over it.

const fs = require('node:fs');
const path = require('node:path');

const fwd = (p) => String(p).replace(/\\/g, '/');
const WIRE_LOG_NAME = 'adapter.log';
const TOOLS_LIST = 'tools/list';

function wireLogPath(dir) {
  return fwd(path.join(dir, WIRE_LOG_NAME));
}

// Build 12 A1, review B1/S1: every worker adapter writes this file, and it is shared across the worker's
// launches. A launch that finds it at or over the threshold moves it to adapter.log.1 (replacing any
// older one) and starts fresh, before the launch records its start offset, so the new adapter's start
// line and tools/list always have room and the ready check reads from a small offset.
const ROTATE_AT = 2 * 1024 * 1024;
function rotateWireLog(logPath, threshold = ROTATE_AT) {
  try {
    if (fs.statSync(logPath).size < threshold) return false;
    fs.renameSync(logPath, logPath + '.1'); // rename replaces an existing .1 on both Windows and POSIX in Node
    return true;
  } catch { return false; } // absent file, or a rename refused: the launch goes on with the file as is
}

function wireLogHasToolsList(logPath, sinceBytes = 0, maxBytes = Infinity) {
  try {
    const stat = fs.statSync(logPath);
    const len = Math.min(maxBytes, Math.max(0, stat.size - sinceBytes));
    if (len === 0) return { seen: false, new_bytes: 0, reason: 'the wire log has grown by nothing since the launch' };
    const fd = fs.openSync(logPath, 'r');
    const bufr = Buffer.alloc(len);
    fs.readSync(fd, bufr, 0, len, sinceBytes);
    fs.closeSync(fd);
    // Any line naming the method counts (ADR 0001 §8: "the adapter's wire log shows tools/list").
    // The adapter writes JSON-RPC frames and RUST_LOG writes prose about them; both are evidence.
    const hits = bufr.toString('utf8').split('\n').filter((l) => l.includes(TOOLS_LIST));
    return { seen: hits.length > 0, count: hits.length, new_bytes: len };
  } catch (e) {
    return { seen: false, new_bytes: 0, reason: 'the wire log could not be read: ' + (e && e.code) };
  }
}

module.exports = { wireLogPath, wireLogHasToolsList, rotateWireLog, ROTATE_AT, WIRE_LOG_NAME, TOOLS_LIST };
