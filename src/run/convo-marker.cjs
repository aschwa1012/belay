'use strict';
// convo-marker.cjs: a file in the worker's own directory that says "this worker's current conversation has no boundary receipt in the
// store". It is written before a conversation-beginning index receipt is tried and removed when that receipt is stored, so a receipt
// write that failed (or a process that died between the two) leaves it behind. Any process that adopts the worker reads it from disk,
// where a flag on the worker object would be gone, and shows every row again instead of withholding rows that conversation never got.

const fs = require('node:fs');
const path = require('node:path');

const fileOf = (dir) => path.join(dir, 'convo-boundary-pending');

function set(dir) {
  try { fs.writeFileSync(fileOf(dir), 'a conversation began without a stored boundary receipt\n'); return true; } catch { return false; }
}
function clear(dir) {
  try { fs.rmSync(fileOf(dir), { force: true }); return true; } catch { return false; }
}
// A marker that cannot be read is no evidence either way; existsSync does not throw.
const present = (dir) => !!dir && fs.existsSync(fileOf(dir));

module.exports = { set, clear, present };
