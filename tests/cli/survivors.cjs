'use strict';
// survivors.cjs — which of a run's processes are still alive, by identity (ADR 0039), not by bare pid.
// process.kill(pid, 0) says a pid is held, not that it is the process the run started: on a busy host a
// finished process's pid is reused. A pid is a survivor when it is held now AND, if its own store row
// recorded a creation time, the process holding it was created at that time. A pid with no recorded time
// keeps the bare check (stricter, never looser). The snapshot is taken only when some pid reads alive.

const ID = require('../../src/core/proc-identity.cjs');
const P = require('../../src/run/process.cjs');

const ATTEMPTS = 3;
function snapshotSync() {
  for (let i = 0; i < ATTEMPTS; i++) {
    if (i) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200 * 2 ** (i - 1));
    const s = ID.processSnapshotSync();
    if (s) return s;
  }
  return null;
}

// `alive` and `snapshot` are test seams. Returns { survivors, reused }: each { pid, want, created, image }.
function survivors(pids, created, { alive = P.pidAlive, snapshot = snapshotSync } = {}) {
  const held = [...pids].filter((p) => alive(p));
  if (!held.length) return { survivors: [], reused: [] };
  const snap = snapshot();
  const out = { survivors: [], reused: [] };
  for (const pid of held) {
    const want = created.has(pid) ? created.get(pid) : null;
    if (!snap) { out.survivors.push({ pid, want, created: null, image: null, note: 'snapshot unreadable' }); continue; }
    const e = snap.get(pid);
    if (!e) continue; // gone between the signal and the snapshot
    const rec = { pid, want, created: e.created, image: e.image };
    if (want != null && e.created !== want) out.reused.push(rec); else out.survivors.push(rec);
  }
  return out;
}

const describe = (list) => list.map((s) => `pid ${s.pid} image ${s.image} created ${s.created} (row recorded ${s.want})${s.note ? ` [${s.note}]` : ''}`).join('; ');

module.exports = { survivors, describe };
