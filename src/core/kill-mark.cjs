'use strict';
// kill-mark.cjs — a human's `belay worker kill` leaves a mark before it signals, so a plan that sees the worker die does not take the death for
// a crash and restart it (policy-relaunch.cjs). One small file per worker in <data>/operator-kill/, naming the pid that was killed: a later
// life of the same worker id has another pid and is not covered. A failed write is reported to the caller and never changes the kill.

const fs = require('node:fs');
const path = require('node:path');

const file = (dataDir, workerId) => path.join(dataDir, 'operator-kill', `${String(workerId).replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);

function mark(dataDir, workerId, pid) {
  try {
    fs.mkdirSync(path.dirname(file(dataDir, workerId)), { recursive: true });
    fs.writeFileSync(file(dataDir, workerId), `${JSON.stringify({ worker_id: workerId, pid, at: Date.now() })}\n`);
    return true;
  } catch { return false; }
}

// true when the worker's row pid was killed by an operator's command. An unreadable mark counts as none (the kill is still a death belay reports).
function isKilled(dataDir, workerId, pid) {
  if (!dataDir) return false;
  try { const m = JSON.parse(fs.readFileSync(file(dataDir, workerId), 'utf8')); return !!m && m.pid === pid; } catch { return false; }
}

module.exports = { mark, isKilled };
