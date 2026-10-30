'use strict';
// seen-stamp.cjs — the last moment a spawned process was seen alive, kept on its spawn-register record (spawn-register.cjs touch).
// A record is read after its harness has died, and the lifetime it keeps closes at this stamp; a record never stamped closes at its
// spawn, and a process it left behind is then taken for the operator's. The stamp is written by the harness only, from a timer, and
// only for a process the harness knows is alive without a bare pid check:
//   * stampWhile: a process whose exit this process observes (a child handle, or the run's orchestrator hook).
//   * stampAdopted: a worker an adapter adopted from the store holds no handle, so its pid is stamped only when one process snapshot
//     shows that pid with the creation time the row recorded; a pid held by another process is retired, never stamped. A snapshot
//     that cannot be read stamps nothing and retires nothing. One timer and one snapshot serve every adopted worker.

const SR = require('../core/spawn-register.cjs');
const ID = require('../core/proc-identity.cjs');

const SEEN_STAMP_MS = 30000;
const LIFE = new Set(['starting', 'running', 'stopping']);

function stampWhile(alive, pid, { every = SEEN_STAMP_MS, touch = (p) => SR.touch(p), setTimer = setInterval, clearTimer = clearInterval } = {}) {
  const timer = setTimer(() => { if (alive()) { try { touch(pid); } catch { /* a stamp is a refinement */ } } }, every);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return { timer, stop: () => clearTimer(timer) };
}

const adopted = new Map(); // pid -> { w, pid, created }
let adoptedTimer = null;

// One pass over the adopted workers; exported for a test to drive. `snapshot` and `touch` are seams.
async function tickAdopted({ snapshot = (o) => ID.processSnapshot(o), touch = (p, now) => SR.touch(p, now), retire = (p, now) => SR.retire(p, now, null, { checked: true }), now = Date.now() } = {}) {
  for (const [pid, a] of [...adopted]) if (a.w.pid !== pid || a.w.pidCreated !== a.created || !LIFE.has(a.w.state)) adopted.delete(pid); // relaunched, or no life to hold
  if (adopted.size === 0) { stopAdopted(); return; }
  const snap = await snapshot({ kind: 'seen-stamp' });
  if (!snap) return;
  for (const [pid, a] of [...adopted]) {
    const v = ID.checkIdentity(pid, { created: a.created }, snap);
    if (v.ok) touch(pid, now);
    else if (v.kind === 'mismatch' || v.kind === 'absent') { adopted.delete(pid); retire(pid, now); }
  }
}

function stopAdopted() { if (adoptedTimer) { clearInterval(adoptedTimer); adoptedTimer = null; } }

// `w` is the adapter's record of the adopted worker (its pid, pidCreated and state are read at each pass).
function stampAdopted(w, { every = SEEN_STAMP_MS, ...seams } = {}) {
  if (!Number.isInteger(w.pid) || !Number.isFinite(w.pidCreated) || !LIFE.has(w.state)) return false;
  adopted.set(w.pid, { w, pid: w.pid, created: w.pidCreated });
  if (!adoptedTimer) {
    adoptedTimer = setInterval(() => { tickAdopted(seams).catch(() => {}); }, every);
    if (adoptedTimer.unref) adoptedTimer.unref();
  }
  return true;
}

module.exports = { stampWhile, stampAdopted, tickAdopted, stopAdopted, SEEN_STAMP_MS, adoptedSize: () => adopted.size };
