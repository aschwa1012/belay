'use strict';
// kill-mark.cjs — a human's `belay worker kill` leaves a mark before it signals, so a plan that sees the worker die does not take the death for
// a crash and restart it (policy-relaunch.cjs). One small file per worker in <data>/operator-kill/, naming the process that was killed by the
// identity ADR 0039 uses, the pid and its creation time: a later life of the same worker id, even on a reused pid, is not covered. A failed write
// returns false and the kill command says so in its receipt. `belay worker rm` clears the mark with the row.

const fs = require('node:fs');
const path = require('node:path');

const file = (dataDir, workerId) => path.join(dataDir, 'operator-kill', `${String(workerId).replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);
const norm = (c) => (c == null ? null : String(c));

function mark(dataDir, workerId, pid, created = null) {
  try {
    fs.mkdirSync(path.dirname(file(dataDir, workerId)), { recursive: true });
    fs.writeFileSync(file(dataDir, workerId), `${JSON.stringify({ worker_id: workerId, pid, pid_created: norm(created), at: Date.now() })}\n`);
    return true;
  } catch { return false; }
}

// true when the process the row names (pid and creation time) was killed by an operator's command. An unreadable mark counts as none (the kill is
// still a death belay reports).
function isKilled(dataDir, workerId, pid, created = null) {
  if (!dataDir) return false;
  try { const m = JSON.parse(fs.readFileSync(file(dataDir, workerId), 'utf8')); return !!m && m.pid === pid && norm(m.pid_created) === norm(created); } catch { return false; }
}

// Like isKilled, but a creation time unknown on either side (the row and the mark are written at different moments) does not hide a kill of the same pid.
function isKilledLoose(dataDir, workerId, pid, created = null) {
  if (!dataDir) return false;
  try { const m = JSON.parse(fs.readFileSync(file(dataDir, workerId), 'utf8')); return !!m && m.pid === pid && (norm(m.pid_created) === norm(created) || m.pid_created == null || created == null); } catch { return false; }
}

function clear(dataDir, workerId) {
  try { fs.unlinkSync(file(dataDir, workerId)); return true; } catch { return false; }
}

module.exports = { mark, isKilled, isKilledLoose, clear };
