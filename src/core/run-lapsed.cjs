'use strict';
// run-lapsed.cjs — has a run lapsed? (ADR 0065 amendment 3 decision 2). The run process (`belay run`) is the process that
// closes a run: the orchestrator's run.end sets `ended_at` first, and the run process then waits for the worker adapters, kills
// survivors and sweeps, for minutes. So a run has lapsed only when its run process is proven gone, and then either its row is ended
// or every other process its present life recorded is proven gone too (the orchestrator's adapter exits long before the close).
// The run process is the one an operator-role attach of the present life introduced; a life with no such attach is not lapsed.
// "Proven gone" is by pid and creation time against one process snapshot (ADR 0039); a pid that answers with no creation time to
// compare, or a snapshot that cannot be read, proves nothing and keeps the run. Derived on every call, never written (invariant 4).

const rows = require('./rows.cjs');
const { pidAlive } = require('./lock.cjs');
const ID = require('./proc-identity.cjs');

const same = (a, b) => a.pid === b.pid && a.created === b.created;

// The rows of the present life: after the last ended row that a live row follows (a run.end pair is one close, not two lives).
function presentLife(hist) {
  let start = 0;
  for (let i = 0; i + 1 < hist.length; i++) if (hist[i].ended_at != null && hist[i + 1].ended_at == null) start = i + 1;
  return hist.slice(start);
}

// { runners, others }: each distinct { pid, created } the present life recorded, the run process's apart. A pid enters when a row
// introduces it; a row that merely restates the previous adapter (a pause, a budget raise, the close) introduces nothing.
function lifeProcesses(hist) {
  const seen = [], runners = [], others = [];
  for (const r of presentLife(hist)) {
    if (r.adapter_pid == null) continue;
    const p = { pid: r.adapter_pid, created: r.adapter_pid_created == null ? null : r.adapter_pid_created };
    if (seen.some((s) => same(s, p))) continue;
    seen.push(p);
    if (r.written_by === 'operator' && r.ended_at == null) runners.push(p); else others.push(p);
  }
  return { runners, others };
}

// -> { gone, reason }: every pid in `list` proven not to be the process belay recorded.
async function provenGone(list, getSnap) {
  let snap;
  for (const p of list) {
    if (!pidAlive(p.pid)) continue;
    if (snap === undefined) snap = await getSnap();
    const c = ID.checkIdentity(Number(p.pid), { created: p.created == null ? null : Number(p.created) }, snap);
    if (c.ok) return { gone: false, reason: 'process_alive' };
    if (c.kind === 'mismatch' || c.kind === 'absent') continue;
    return { gone: false, reason: 'process_unproven' };
  }
  return { gone: true };
}

// -> { lapsed, reason, seq } for one run id. `getSnap` is a lazy snapshot getter shared by a scan.
async function lapsedOf(E, runId, getSnap) {
  const run = rows.current(E.store, 'run', runId);
  if (!run) return { lapsed: false, reason: 'no_run_row', seq: null };
  const { runners, others } = lifeProcesses(rows.history(E.store, 'run', runId));
  if (!runners.length) return { lapsed: false, reason: 'runner_unrecorded', seq: run.seq };
  const r = await provenGone(runners, getSnap);
  if (!r.gone) return { lapsed: false, reason: r.reason, seq: run.seq };
  if (run.ended_at == null) {
    const o = await provenGone(others, getSnap);
    if (!o.gone) return { lapsed: false, reason: o.reason, seq: run.seq };
  }
  const now = rows.current(E.store, 'run', runId);
  if (!now || now.seq !== run.seq) return { lapsed: false, reason: 'run_changed', seq: now ? now.seq : null }; // an attach during the snapshot
  return { lapsed: true, reason: run.ended_at != null ? 'run_ended' : 'run_dead', seq: run.seq };
}

// One snapshot for the whole scan, taken only if a recorded pid answers.
async function lapsedRuns(E, runIds, { snapshot = null } = {}) {
  let snapP = null;
  const getSnap = () => { snapP = snapP || ID.snapshotRetry({ attempts: 2, snapshot }); return snapP; };
  const out = new Map();
  for (const id of runIds) out.set(id, await lapsedOf(E, id, getSnap));
  return out;
}

// The synchronous recheck taken before each tree's removal: no snapshot, so it fails towards keeping. The run is still lapsed when its
// row is unchanged since the judgment, or when none of its recorded processes answers a pid check now (the run process's alone if ended).
function stillLapsed(E, runId, judgedSeq) {
  const run = rows.current(E.store, 'run', runId);
  if (!run) return false;
  if (run.seq === judgedSeq) return true;
  const { runners, others } = lifeProcesses(rows.history(E.store, 'run', runId));
  if (!runners.length || runners.some((p) => pidAlive(p.pid))) return false;
  return run.ended_at != null || others.every((p) => !pidAlive(p.pid));
}

module.exports = { lapsedOf, lapsedRuns, stillLapsed, lifeProcesses };
