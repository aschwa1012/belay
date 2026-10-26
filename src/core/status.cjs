'use strict';
// status.cjs — the truth ladder (api.md §4, ADR 0005 §6). Status is not a word: six rungs, each naming
// what established it, and a dead system is a valid answer.
//
// Budget: under 100 ms in-process with no owner alive, creating no file in the data dir, and nothing
// reachable from here may require the embedder module. The pipe is only dialled when the lock names a
// pid that is actually alive, so the common dead case costs two stats and a pid check.

const fs = require('node:fs');
const path = require('node:path');
const rows = require('./rows.cjs');
const { pidAlive, readOwnerLock, pipeName } = require('./lock.cjs');
const { ping } = require('./ping.cjs');
const unresponsive = require('./unresponsive.cjs');
const { metaGet } = require('./schema-stamp.cjs');
const { count: unembeddedCount } = require('./notes-unembedded.cjs');
const { count: heldCount } = require('./notes-held.cjs');

const RESPONSIVE_WINDOW_MS = 30000;
const OWNER_PING_TIMEOUT_MS = 300;
const WATCHED = new Set(['starting', 'running']);

async function get(E, caller, args = {}) {
  const t0 = Date.now();
  const dataDir = E.dataDir;
  // build step 4a: a read may name any run (identity binds writes, not reads); with no run_id the
  // caller asks about the run it was opened with, exactly as before this step.
  const runId = args.run_id != null ? String(args.run_id) : caller.run_id;
  const rungs = [];
  const rung = (name, established, by, detail, since) => {
    rungs.push({ rung: name, established, by, ms: Date.now() - since, detail });
    return established;
  };

  // 1. configured
  let s1 = Date.now(), isDir = false, dirDetail;
  try { const st = fs.statSync(dataDir); isDir = st.isDirectory(); dirDetail = { path: dataDir, is_directory: isDir }; }
  catch (e) { dirDetail = { path: dataDir, error: e.code || e.message }; }
  const configured = rung('configured', isDir, `stat ${dataDir}`, dirDetail, s1);

  // 2. store-present
  let s2 = Date.now(), storePresent = false, storeDetail;
  const dbPath = path.join(dataDir, 'memory.db');
  try { const st = fs.statSync(dbPath); storePresent = true; storeDetail = { path: dbPath, bytes: st.size, mtime: st.mtimeMs }; }
  catch (e) { storeDetail = { path: dbPath, error: e.code || e.message }; }
  const storeRung = rung('store-present', storePresent, `stat ${dbPath}`, storeDetail, s2);

  // 3. owner-alive: the lock's pid must be alive AND a bounded request must be answered. Both facts
  //    are reported, because a live pid whose pipe never answers is exactly the wedged case.
  let s3 = Date.now(), ownerAlive = false, ownerDetail, ownerBy;
  if (E.owner) {
    ownerAlive = true;
    // build step 4a, amendment A3: this engine belongs to the owner process, and serves both this
    // process's own in-process calls and every request that reaches it over the pipe (src/core/owner.cjs
    // dispatches both into the same Engine). caller.pid is not validated by engine.cjs, so it is trusted
    // only when it is a finite number; when it differs from this process's own pid, the request truly
    // crossed the pipe and the rung must say so to the caller that made it, not relay the owner's own
    // trivial self-view. caller.pid absent, or equal to process.pid, is the in-process case unchanged.
    const callerPid = typeof caller.pid === 'number' && Number.isFinite(caller.pid) ? caller.pid : null;
    if (callerPid !== null && callerPid !== process.pid) {
      ownerBy = `owner pid ${process.pid} answered this request over ${E.owner.pipe} for caller pid ${callerPid} (the caller's bounded round trip is the ping)`;
      ownerDetail = {
        pid: process.pid, pid_alive: true, pipe: E.owner.pipe, listening: E.owner.listening !== false,
        answered: true, established_by: 'answered over the pipe', caller_pid: callerPid, ping_ms: null,
      };
    } else {
      ownerBy = 'this process is the owner (in-process call, no pipe round trip)';
      ownerDetail = { pid: process.pid, pid_alive: true, pipe: E.owner.pipe, listening: E.owner.listening !== false, answered: true, established_by: 'in-process' };
    }
  } else {
    const lock = readOwnerLock(dataDir);
    const alive = !!(lock && pidAlive(lock.pid));
    // A lock that says `listening: false` names an owner between winning the lock and reaching listen.
    // Its pid is alive and its pipe does not exist yet; pinging it would only spend the budget proving
    // what the lock already said, and a starting owner is not an owner that answers.
    const starting = !!(lock && lock.listening === false);
    let answered = null, pingMs = null, reason = null;
    const mark = alive && !starting ? unresponsive.get(lock.pipe || pipeName(dataDir), lock.pid) : null;
    if (alive && starting) { answered = false; reason = 'the owner holds the lock but has not started listening yet'; }
    else if (mark) { answered = false; reason = unresponsive.describeStatus(mark); }
    else if (alive) { const r = await ping(dataDir, OWNER_PING_TIMEOUT_MS); answered = r.ok; pingMs = r.ms; reason = r.ok ? null : r.reason; }
    ownerAlive = alive && answered === true;
    ownerBy = alive
      ? (starting
        ? 'owner.lock pid check plus the lock\'s own listening marker, which says the pipe is not up yet'
        : mark ? `owner.lock pid check; ${unresponsive.describeStatus(mark)}`
        : `owner.lock pid check plus a bounded ping over ${pipeName(dataDir)} (${OWNER_PING_TIMEOUT_MS} ms)`)
      : (lock ? 'owner.lock read plus a pid check' : 'no owner.lock in the data dir');
    ownerDetail = { pid: lock ? lock.pid : null, pid_alive: alive, pipe: lock ? lock.pipe : pipeName(dataDir), listening: lock ? lock.listening !== false : null, answered, ping_ms: pingMs, reason };
  }
  rung('owner-alive', ownerAlive, ownerBy, ownerDetail, s3);

  // 4. run-alive
  let s4 = Date.now();
  const runRow = rows.current(E.store, 'run', runId);
  const runAdapterAlive = !!(runRow && runRow.ended_at == null && pidAlive(runRow.adapter_pid));
  rung('run-alive', runAdapterAlive, runRow ? 'current run row plus a pid check on its adapter_pid' : `no run row for ${runId}`, runRow
    ? { run_id: runRow.id, epoch: runRow.epoch, adapter_pid: runRow.adapter_pid, adapter_pid_alive: pidAlive(runRow.adapter_pid), ended_at: runRow.ended_at, exit_reason: runRow.exit_reason }
    : { run_id: runId, present: false }, s4);

  // 5. worker-alive
  let s5 = Date.now();
  const allWorkers = rows.currentAll(E.store, 'worker');
  const watched = allWorkers.filter(w => WATCHED.has(w.state));
  const workerFacts = watched.map(w => ({ id: w.id, state: w.state, pid: w.pid, pid_alive: pidAlive(w.pid) }));
  const workersAlive = workerFacts.every(w => w.pid_alive);
  rung('worker-alive', workersAlive, 'per-worker pid check on every current row in starting or running',
    { checked: workerFacts.length, workers: workerFacts }, s5);

  // 6. worker-responsive
  let s6 = Date.now();
  const respFacts = watched.map(w => {
    const p = path.join(dataDir, 'workers', w.id, 'stream.jsonl');
    let age = null, present = false;
    try { age = Date.now() - fs.statSync(p).mtimeMs; present = true; } catch { /* no stream yet */ }
    return { id: w.id, stream_present: present, last_event_age_ms: age === null ? null : Math.round(age), responsive: present && age <= RESPONSIVE_WINDOW_MS };
  });
  const responsive = respFacts.every(w => w.responsive);
  rung('worker-responsive', responsive, `workers/<id>/stream.jsonl mtime age within ${RESPONSIVE_WINDOW_MS} ms` + (args.deep ? ' (deep substrate probe is out of scope this session)' : ''),
    { checked: respFacts.length, window_ms: RESPONSIVE_WINDOW_MS, workers: respFacts }, s6);

  const firstFour = configured && storeRung && ownerAlive && runAdapterAlive;
  const verdict = !firstFour ? 'stopped' : (workersAlive && responsive ? 'alive' : 'degraded');

  // G3 follow-up: the stamp of the store this engine already holds open (the owner's, or a read's
  // throwaway copy). Two primary-key selects on an open handle; nothing is opened, written or imported.
  // No store file: `store` is null (a read's copy self-heals a throwaway store, which says nothing about
  // the data dir). A store with no stamp predates G3: `{ schema_version: null, written_by: null }`.
  let store = null;
  if (storePresent) {
    try {
      const v = metaGet(E.store.db, 'schema_version');
      store = { schema_version: v === null ? null : Number(v), written_by: metaGet(E.store.db, 'written_by') };
    } catch { /* a handle that cannot answer reports null, never a guess */ }
  }

  // Notes stored without a vector (on_embedder_failure keyword). Nothing embeds them but `belay memory embed`; a plain read
  // of the rows already open, none when the store is absent.
  const notesUnembedded = storePresent ? unembeddedCount(E.store) : { total: 0, by_project: {}, newest_at: null };

  // Notes held for the on-demand Opus archive reviewer (a hold of any kind): a plain read, none when the store is absent.
  const notesHeld = storePresent ? heldCount(E.store) : { total: 0, by_project: {}, oldest_age_runs: 0 };

  const workerTasks = storePresent ? rows.workerTasks(E.store) : new Map(); // the row's task_id is spawn-only; the lease holds the current one
  return {
    verdict,
    data_dir: dataDir,
    store,
    notes_unembedded: notesUnembedded,
    notes_held: notesHeld,
    established_by: E.owner ? 'owner' : E.establishedBy,
    ms: Date.now() - t0,
    rungs,
    // Fix round: reuse runAdapterAlive (the run-alive rung's own fact) so this can't drift from it.
    run: runRow
      ? { id: runRow.id, epoch: runRow.epoch, adapter_pid: runRow.adapter_pid, alive: runAdapterAlive, ended_at: runRow.ended_at, exit_reason: runRow.exit_reason, paused_at: runRow.paused_at == null ? null : runRow.paused_at, paused_by: runRow.paused_by == null ? null : runRow.paused_by, ...embedBoundsOf(E, runRow.id) }
      : null,
    // build step 6b: a forgotten row is hidden here too, the same rule worker.list's default carries.
    workers: allWorkers.filter(w => w.state !== 'forgotten').map(w => ({
      id: w.id, substrate: w.substrate, state: w.state, pid: w.pid, pid_alive: pidAlive(w.pid),
      session_id: w.session_id, task_id: workerTasks.has(w.id) ? workerTasks.get(w.id) : w.task_id,
      last_event_age_ms: w.last_event_at == null ? null : Date.now() - Number(w.last_event_at),
      turns: w.turns, input_tokens: w.input_tokens, output_tokens: w.output_tokens, cost_usd: w.cost_usd,
      // build step 4a: status.get's own projection lacked these two, though worker.list carried both.
      mid_turn: w.mid_turn, death_established_by: w.death_established_by,
    })),
  };
}

// The index-query embeds of this run that hit their bound (memory.embedQuery writes an `embed_bound` event for each call in which
// one did), so a slow embedder shows at run level. Present only when there are any; a store with no such table says nothing.
function embedBoundsOf(E, runId) {
  try {
    const count = (kind) => E.store.p("SELECT COUNT(*) AS n FROM memory_event WHERE run_id = ? AND kind = ?").get(runId, kind).n;
    const n = count('embed_bound'), i = count('index_bound');
    return { ...(n > 0 ? { embed_bounds: n } : {}), ...(i > 0 ? { index_bounds: i } : {}) };
  } catch { return {}; }
}

module.exports = { get, RESPONSIVE_WINDOW_MS, OWNER_PING_TIMEOUT_MS };
