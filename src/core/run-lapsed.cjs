'use strict';
// run-lapsed.cjs — has a run lapsed? (ADR 0065 amendment 3 decision 2). A run has when its row is ended, or when every process its
// present life recorded is proven gone: the run process (`belay run`, which attaches first) and the orchestrator's adapter (which
// attaches over it and exits 300 to 400 ms after Claude Code closes its stdin, long before the close is done). The adapter alone is
// never enough, so a life with one recorded process counts as lapsed only when its row is ended. "Proven gone" is by pid and
// creation time against one process snapshot (ADR 0039); a pid that answers with no creation time to compare, or a snapshot that
// cannot be read, proves nothing and keeps the run. Derived on every call, never written (invariant 4).

const rows = require('./rows.cjs');
const { pidAlive } = require('./lock.cjs');
const ID = require('./proc-identity.cjs');

// -> { lapsed, reason, seq } for one run id. `snap` is a lazy snapshot getter shared by a scan.
async function lapsedOf(E, runId, getSnap) {
  const run = rows.current(E.store, 'run', runId);
  if (!run) return { lapsed: false, reason: 'no_run_row', seq: null };
  if (run.ended_at != null) return { lapsed: true, reason: 'run_ended', seq: run.seq };
  const life = require('./methods-run.cjs').lifePids(rows.history(E.store, 'run', runId));
  if (life.length < 2) return { lapsed: false, reason: 'runner_unrecorded', seq: run.seq };
  let snap;
  for (const p of life) {
    if (!pidAlive(p.pid)) continue;
    if (snap === undefined) snap = await getSnap();
    const c = ID.checkIdentity(Number(p.pid), { created: p.created == null ? null : Number(p.created) }, snap);
    if (c.ok) return { lapsed: false, reason: 'process_alive', seq: run.seq };
    if (c.kind === 'mismatch' || c.kind === 'absent') continue;
    return { lapsed: false, reason: 'process_unproven', seq: run.seq };
  }
  const now = rows.current(E.store, 'run', runId);
  if (!now || now.seq !== run.seq) return { lapsed: false, reason: 'run_changed', seq: now ? now.seq : null }; // an attach during the snapshot
  return { lapsed: true, reason: 'run_dead', seq: run.seq };
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
// row is unchanged since the judgment, or is ended, or none of its recorded processes answers a pid check now.
function stillLapsed(E, runId, judgedSeq) {
  const run = rows.current(E.store, 'run', runId);
  if (!run) return false;
  if (run.ended_at != null || run.seq === judgedSeq) return true;
  return require('./methods-run.cjs').lifePids(rows.history(E.store, 'run', runId)).every((p) => !pidAlive(p.pid));
}

module.exports = { lapsedOf, lapsedRuns, stillLapsed };
