'use strict';
// methods-run.cjs — run and worker rows (api.md §3). Both tables are append-only: a "change" is a new
// row that supersedes its predecessor, and the current row of an id is its highest seq.
//
// A field absent from a worker.write is inherited from the worker's current row; an explicit null
// clears it. That keeps a caller from having to restate eighteen columns to move a state forward, and
// still leaves every historical row intact.

const path = require('node:path');
const fs = require('node:fs');
const { err } = require('./errors.cjs');
const rows = require('./rows.cjs');
const { pidAlive } = require('./lock.cjs');
const { WORKER_STATES, SUBSTRATES } = require('./schema.cjs');
const { resolveParks, parseRunRow, clearedPause, pauseFields } = require('./pause-parks.cjs');
const { runCommand } = require('./evaluate.cjs');

const { EFFORT_LEVELS } = require('./effort-levels.cjs');
const { parseMemoryBlock } = require('./memory-levers.cjs'); // pure: no requires, so the read path stays light

const PROJECT_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const fwd = (p) => String(p).replace(/\\/g, '/');

// The states that claim a live worker, and so must be re-checked against a pid when a new epoch attaches.
// build step 6e-4, ADR 0023 amendment 2 decision 5: 'paused' is no longer live — a parked worker's row
// carries no pid claim to re-check.
// ADR 0029 decision 2: 'stopping' joins them (a shutdown cut off after its stopping write leaves it), and
// run.end applies the same set to its own epoch (decision 1), so one constant serves both.
const LIFE_CLAIMING_STATES = new Set(['starting', 'running', 'idle', 'stopping']);
const ATTACH_SUSPECT = LIFE_CLAIMING_STATES;

// Fix round for 6f (diff-scope): `rows.cjs` (unowned) lacks paused_at/paused_by in COLUMNS.run, so
// rows.append would drop both. This local insert (its own shape, via exported bind/parseRow) adds them.
function appendRun(E, values, writtenBy, at = Date.now()) {
  const cols = [...rows.COLUMNS.run, 'paused_at', 'paused_by', 'pause_parks', 'memory_levers', 'project', 'project_dir', 'embedder_mode']; // item 1: 6th local column; ADR 0041 decision 1: the memory levers and the project
  const all = [...cols, 'written_at', 'written_by'];
  const sql = `INSERT INTO run(${all.join(', ')}) VALUES (${all.map(() => '?').join(', ')})`;
  const params = cols.map(c => rows.bind(values[c]));
  params.push(at, String(writtenBy));
  const info = E.store.p(sql).run(...params);
  const seq = Number(info.lastInsertRowid);
  return parseRunRow(rows.parseRow('run', E.store.p('SELECT * FROM run WHERE seq = ?').get(seq)));
}

async function attach(E, caller, args) {
  const adapterPid = Number(args.adapter_pid);
  if (!Number.isFinite(adapterPid) || adapterPid <= 0) throw err('E_ARGS', 'run.attach needs the adapter_pid of the process making the call');
  // ADR 0028 decision 5 (S6b fix round, SF1): the launching attach states the level or null; the core is
  // the boundary, so anything else is refused before a row is written.
  const effortGiven = args.orch_effort_requested !== undefined;
  if (effortGiven && args.orch_effort_requested !== null && !EFFORT_LEVELS.includes(args.orch_effort_requested)) {
    throw err('E_ARGS', `run.attach orch_effort_requested must be null or one of ${EFFORT_LEVELS.join(', ')}`, { orch_effort_requested: args.orch_effort_requested });
  }
  const fixCapGiven = args.max_fix_rounds !== undefined;
  if (fixCapGiven && args.max_fix_rounds !== null && !(Number.isSafeInteger(args.max_fix_rounds) && args.max_fix_rounds >= 0)) {
    throw err('E_ARGS', 'run.attach max_fix_rounds must be null or a non-negative integer', { max_fix_rounds: args.max_fix_rounds });
  }
  // ADR 0041 decision 1: the memory levers (the parsed block as JSON text) and the project name, written once by
  // the launching attach and carried forward like max_fix_rounds. The core is the boundary: bad values are refused.
  const leversGiven = args.memory_levers !== undefined;
  if (leversGiven && args.memory_levers !== null) {
    let parsed = null;
    try { parsed = typeof args.memory_levers === 'string' ? JSON.parse(args.memory_levers) : null; } catch { /* refused below */ }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw err('E_ARGS', 'run.attach memory_levers must be null or the JSON text of an object', { memory_levers: args.memory_levers });
    }
    const checked = parseMemoryBlock(parsed);
    if (checked.error) throw err('E_ARGS', `run.attach memory_levers is not a valid memory block: ${checked.error}`, { memory_levers: args.memory_levers });
  }
  const modeGiven = args.embedder_mode !== undefined;
  if (modeGiven && args.embedder_mode !== null && !require('./embedder-mode.cjs').normalize(args.embedder_mode)) throw err('E_ARGS', 'run.attach embedder_mode must be null, required, keyword or off', { embedder_mode: args.embedder_mode });
  const dirGiven = args.project_dir !== undefined;
  if (dirGiven && args.project_dir !== null && !(typeof args.project_dir === 'string' && args.project_dir.length > 0 && args.project_dir.length <= 1024)) {
    throw err('E_ARGS', 'run.attach project_dir must be null or a directory path', { project_dir: args.project_dir });
  }
  const projectGiven = args.project !== undefined;
  if (projectGiven && args.project !== null && !(typeof args.project === 'string' && PROJECT_RE.test(args.project))) {
    throw err('E_ARGS', 'run.attach project must be null or match ^[a-z0-9][a-z0-9._-]{0,63}$', { project: args.project });
  }
  const runId = caller.run_id;
  const t = Date.now();
  const prev = rows.current(E.store, 'run', runId);
  // ADR 0029 amendment 4 (proposed): an ended run stays ended. Only the run process (role operator, the launching attach of
  // a re-run) opens a new epoch over an ended one; the orchestrator's adapter, whose first core call can land after the
  // run closed, is refused. A refusal writes nothing, so the late caller reopens nothing and the run reads as ended.
  if (prev && prev.ended_at != null && caller.role === 'orchestrator') {
    throw err('E_ARGS', `run ${runId} has already ended; an orchestrator adapter cannot reopen it`, { run_id: runId, ended_at: prev.ended_at, epoch: prev.epoch });
  }
  const epoch = prev ? Number(prev.epoch || 0) + 1 : 1;
  const by = E.writtenBy(caller);

  // A reattach means the previous adapter is gone. Any worker the old epoch left claiming a life, whose
  // pid is no longer alive, is dead — and saying so is derived from a pid check, never self-reported.
  //
  // `idle` claims a life too. It is Codex between turns, whose process exits by design while the thread
  // lives (api.md §2), so its pid is legitimately gone and it was skipped here. Across a session end
  // that made it the one state a worker could survive in for ever: a stale pid, no adapter, and never
  // named in workers_marked_dead. The thread may still be resumable, but the worker is not running, and
  // the next epoch has no process to attach to.
  const marked = [];
  if (prev) {
    for (const w of rows.currentAll(E.store, 'worker')) {
      if (w.run_id !== runId) continue;
      if (!ATTACH_SUSPECT.has(w.state)) continue;
      if (pidAlive(w.pid)) continue;
      // 6e-2, should-fix methods-run.cjs:45: a row the core itself appends over a paused row must not
      // inherit its paused_at/paused_by — this row is not itself paused, and api.md §2 promises both
      // null on every row that is not (writeWorker's own rule, unreachable here since this bypasses it).
      rows.append(E.store, 'worker', { ...w, state: 'dead', exited_at: w.exited_at == null ? t : w.exited_at, paused_at: null, paused_by: null }, by, t);
      marked.push(w.id);
    }
  }

  // 6f-2 design item 4 (should-fix, methods-run.cjs:77, first review 1b): forward a pause only from a
  // previous epoch that has not itself ended — an ended epoch's own `paused_at`/`paused_by` are always
  // null already (run.end below), but a belated write reaching this rule any other way must not resurrect
  // a pause nothing holds on a new epoch of the same run id (probe `stale`).
  const carryPause = prev && prev.ended_at == null;
  const run = appendRun(E, {
    id: runId,
    epoch,
    orchestrator_pid: args.orchestrator_pid == null ? (prev ? prev.orchestrator_pid : null) : args.orchestrator_pid,
    adapter_pid: adapterPid,
    // ADR 0039 decision 1: creation times from a spawn-time snapshot; null when not given or the read failed.
    adapter_pid_created: args.adapter_pid_created == null ? null : args.adapter_pid_created,
    started_at: prev ? prev.started_at : t,
    ended_at: null,
    exit_reason: null,
    // build step 6f, ADR 0023 amendment 3 decision 4.1: a pause recorded on the run row survives a
    // reattach (the run process itself never reattaches mid-life, but nothing else guarantees that).
    paused_at: carryPause ? prev.paused_at : null,
    paused_by: carryPause ? prev.paused_by : null,
    pause_parks: carryPause ? prev.pause_parks : null, // item 1 (amendment 4 decision 1): carried the same rule
    // ADR 0028 decision 5: what `belay run --effort` asked for. A key present is written as given, null
    // included (MF1); an absent key (the orchestrator's own adapter) inherits, but only from an unended
    // epoch, the carryPause rule: an ended epoch's level is never this epoch's.
    orch_effort_requested: effortGiven ? args.orch_effort_requested : (carryPause ? prev.orch_effort_requested : null),
    // ADR 0031 decision 6: the fix-round cap `belay run` launched with, same carry rule as the effort.
    max_fix_rounds: fixCapGiven ? args.max_fix_rounds : (carryPause ? prev.max_fix_rounds : null),
    memory_levers: leversGiven ? args.memory_levers : (carryPause ? prev.memory_levers : null), // same carry rule
    project: projectGiven ? args.project : (carryPause ? prev.project : null),
    project_dir: dirGiven ? args.project_dir : (carryPause ? prev.project_dir : null),
    embedder_mode: modeGiven ? (args.embedder_mode === null ? null : require('./embedder-mode.cjs').normalize(args.embedder_mode)) : (carryPause ? prev.embedder_mode : null),
  }, by, t);
  E.noteWrite();
  return { run, epoch, reattached: !!prev, previous: parseRunRow(prev), workers_marked_dead: marked }; // item c
}

// build step 6f, ADR 0023 amendment 3 decision 4.1, extended by build step 6i-2 design item 1 (amendment
// 4 decisions 1, 3): writes a run's own pause, open to orchestrator and operator. `args.at`/`args.by`/
// `args.parks` are stamped as given -- the run process's own core is bound to its own identity, never
// the pause's real caller -- and `pause_parks` is cleared to null whenever `paused` is false.
async function setPaused(E, caller, args) {
  if (typeof args.paused !== 'boolean') throw err('E_ARGS', 'run.setPaused needs paused as a boolean');
  const prev = rows.current(E.store, 'run', caller.run_id);
  if (!prev) throw err('E_NOT_FOUND', `no run row exists for ${caller.run_id}`, { run_id: caller.run_id });
  if (prev.ended_at != null) throw err('E_ARGS', `run ${caller.run_id} has already ended`, { run_id: caller.run_id, ended_at: prev.ended_at });
  const parks = resolveParks(args); // item 1 (amendment 4 decisions 1, 3) + fix-up (b): pause-parks.cjs refuses parks without paused: true
  const t = Date.now();
  const pausedAt = Number.isInteger(args.at) ? args.at : t;
  const pausedBy = typeof args.by === 'string' && args.by ? args.by : E.writtenBy(caller);
  const row = appendRun(E, { ...prev, ...pauseFields(args.paused, pausedAt, pausedBy, parks) }, E.writtenBy(caller), t); // item e
  E.noteWrite();
  return row;
}

// The run's current on_embedder_failure mode, written to its row when a resume switches it (belay resume --embedder keyword|off), so a reader
// with no owner guard (a copy fallback) sees the live mode. The guard in the run process stays the authority; this is its record.
async function setEmbedderMode(E, caller, args) {
  const mode = require('./embedder-mode.cjs').normalize(args.mode);
  if (mode === null) throw err('E_ARGS', 'run.setEmbedderMode needs mode: required, keyword or off', { mode: args.mode });
  const prev = rows.current(E.store, 'run', caller.run_id);
  if (!prev) throw err('E_NOT_FOUND', `no run row exists for ${caller.run_id}`, { run_id: caller.run_id });
  if (prev.ended_at != null) throw err('E_ARGS', `run ${caller.run_id} has already ended`, { run_id: caller.run_id, ended_at: prev.ended_at });
  const row = appendRun(E, { ...prev, embedder_mode: mode }, E.writtenBy(caller));
  E.noteWrite();
  return row;
}

// Build step W2-3 (S4b): the orchestrator's usage, as typed. `orch_model` is a string, the rest numbers;
// a null or absent field is left to the row (null on a crashed run). A usage problem never stops a run ending (amendment 1, SF2): an invalid field is dropped and named in `invalid_usage` on the result.
const USAGE_FIELDS = { orch_model: 'string', orch_input_tokens: 'number', orch_output_tokens: 'number',
  orch_cache_read_tokens: 'number', orch_cache_creation_tokens: 'number', orch_cost_usd: 'number', orch_turns: 'number' };
function usageColumns(usage) {
  const out = {};
  const invalid = [];
  if (usage == null) return { out, invalid };
  if (typeof usage !== 'object' || Array.isArray(usage)) return { out, invalid: [{ field: 'usage', reason: 'must be an object of orch_* fields' }] };
  for (const [k, v] of Object.entries(usage)) {
    if (!(k in USAGE_FIELDS)) { invalid.push({ field: k, reason: 'unknown field' }); continue; }
    if (v == null) continue;
    if (typeof v !== USAGE_FIELDS[k] || (typeof v === 'number' && !Number.isFinite(v))) {
      invalid.push({ field: k, reason: `must be a ${USAGE_FIELDS[k]}, and this call carried ${JSON.stringify(v)}` });
      continue;
    }
    out[k] = v;
  }
  return { out, invalid };
}

// ADR 0029 decision 1: HEAD of a worker's worktree, bounded, argv with no shell. Never throws.
const HEAD_BOUND_MS = 5000;
async function headOf(worktree) {
  if (!worktree) return { sha: null, error: 'the worker row names no worktree' };
  if (!fs.existsSync(String(worktree))) return { sha: null, error: `worktree ${worktree} does not exist` };
  const r = await runCommand(['git', 'rev-parse', 'HEAD'], String(worktree), HEAD_BOUND_MS);
  if (!r.executable) return { sha: null, error: `git could not be run: ${r.spawn_error}` };
  if (r.timed_out) return { sha: null, error: `git rev-parse HEAD timed out after ${HEAD_BOUND_MS} ms` };
  const sha = String(r.stdout || '').trim();
  if (r.exit_code !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) {
    return { sha: null, error: `git rev-parse HEAD in ${worktree} exited ${r.exit_code}: ${String(r.stderr || '').trim().slice(0, 200)}` };
  }
  return { sha, error: null };
}

// ADR 0029 decision 1 and amendment 1 item 1: the ending epoch's own workers, closed by the rule run.attach
// applies to the previous one. A claim is dead only by a pid check (invariant 4), except a Codex `idle`
// row: its process exits between turns by design (api.md §2), so its pid proves nothing and the row is
// closed with the run whatever the pid says. The row is re-read after the git call and nothing is written
// over one that moved on, or (for a pid-checked row) whose pid came back, in the meantime.
const CODEX_IDLE_BY = 'run.end: a Codex worker between turns has no process by design; its run ended (ADR 0029)';
const isCodexIdle = (w) => w.substrate === 'codex' && w.state === 'idle';
async function closeEpochWorkers(E, runId, by) {
  const marked = [];
  const t = Date.now();
  for (const w of rows.currentAll(E.store, 'worker')) {
    if (w.run_id !== runId || !LIFE_CLAIMING_STATES.has(w.state)) continue;
    const codexIdle = isCodexIdle(w);
    if (!codexIdle && pidAlive(w.pid)) continue;
    const head = await headOf(w.worktree);
    const cur = rows.current(E.store, 'worker', w.id);
    if (!cur || cur.seq !== w.seq || (!codexIdle && pidAlive(cur.pid))) continue;
    // The head the row carries: git's answer, else the head the row already had (never overwritten with null).
    const headSha = head.sha == null ? (cur.head_sha == null ? null : cur.head_sha) : head.sha;
    rows.append(E.store, 'worker', {
      ...cur, state: 'dead', exited_at: cur.exited_at == null ? t : cur.exited_at,
      death_established_by: codexIdle ? CODEX_IDLE_BY
        : `run.end: pid ${cur.pid} not alive when the run ended; no adapter wrote its exit (ADR 0029)`,
      head_sha: headSha, head_error: headSha != null ? null : (cur.head_error == null ? null : cur.head_error), paused_at: null, paused_by: null,
    }, by, t);
    marked.push(head.error ? { worker_id: w.id, from_state: w.state, head_sha: headSha, head_error: head.error }
      : { worker_id: w.id, from_state: w.state, head_sha: headSha });
  }
  return marked;
}

// ADR 0029 amendment 2: a terminal (stopped or dead) row of the run that has a worktree and no head gets one
// appended row restating it with the worktree's head. Nothing but head_sha changes. Same seq re-read guard as
// closeEpochWorkers; git failing appends nothing and the entry names why. Rows closeEpochWorkers just wrote
// already carry a head (or a git error it reported) and are skipped, so nothing is double-written.
async function fillMissingHeads(E, runId, by, skip) {
  const filled = [];
  const t = Date.now();
  for (const w of rows.currentAll(E.store, 'worker')) {
    if (w.run_id !== runId || (w.state !== 'stopped' && w.state !== 'dead')) continue;
    if (w.head_sha != null || !w.worktree || skip.has(w.id)) continue;
    const head = await headOf(w.worktree);
    if (head.sha == null) { filled.push({ worker_id: w.id, state: w.state, head_sha: null, head_error: head.error }); continue; }
    const cur = rows.current(E.store, 'worker', w.id);
    if (!cur || cur.seq !== w.seq) continue;
    rows.append(E.store, 'worker', { ...cur, head_sha: head.sha, head_error: null }, by, t);
    filled.push({ worker_id: w.id, state: w.state, head_sha: head.sha });
  }
  return filled;
}

async function end(E, caller, args) {
  if (!args.exit_reason) throw err('E_ARGS', 'run.end needs an exit_reason naming why the run ended');
  const { out: usage, invalid } = usageColumns(args.usage);
  const prev = rows.current(E.store, 'run', caller.run_id);
  if (!prev) throw err('E_NOT_FOUND', `no run row exists for ${caller.run_id}, so there is nothing to end`, { run_id: caller.run_id });
  const t = Date.now();
  // 6f-2 design item 4 (should-fix, methods-run.cjs:77, first review 1b): a pause ends with its run — the
  // ended row never claims one, so a re-run under the same run id starts its next epoch unpaused too
  // (run.attach's own `carryPause` above), and `belay pause` never answers `already: true` over nothing.
  const row = appendRun(E, { ...prev, ended_at: t, exit_reason: String(args.exit_reason), ...usage, ...clearedPause() }, E.writtenBy(caller), t); // item e
  E.noteWrite();
  const workersMarkedDead = await closeEpochWorkers(E, caller.run_id, E.writtenBy(caller));
  const headsFilled = await fillMissingHeads(E, caller.run_id, E.writtenBy(caller), new Set(workersMarkedDead.map(m => m.worker_id)));
  if (workersMarkedDead.length || headsFilled.some(h => h.head_sha != null)) E.noteWrite();
  const out = { ...row, workers_marked_dead: workersMarkedDead, heads_filled: headsFilled };
  return invalid.length ? { ...out, invalid_usage: invalid } : out;
}

async function getRun(E, caller) {
  return {
    run: parseRunRow(rows.current(E.store, 'run', caller.run_id)),
    epochs: rows.history(E.store, 'run', caller.run_id),
  };
}

// build step 4a: a read with no counterpart before it — there was no way for a caller with no run id
// argument to find the current run, because status.get and run.get both read the run named by
// caller.run_id, fixed at openCore. `alive` is derived the same way status.get's run-alive rung
// derives it: the row has not ended and its adapter_pid answers a pid check right now.
async function listRuns(E) {
  const runs = rows.currentAll(E.store, 'run')
    .map(r => parseRunRow({ ...r, alive: !!(r.ended_at == null && pidAlive(r.adapter_pid)) }))
    .sort((a, b) => b.seq - a.seq);
  return { runs };
}

// build step 6b: only worker.forget writes 'forgotten' — a caller that names it here is refused before
// the merge ever sees it, so worker.write cannot be used to fake the one fact worker.forget derives.
function refuseForgottenArg(id) {
  throw err('E_ARGS', "worker.write refuses state: 'forgotten'; only worker.forget writes it", { worker_id: id });
}

async function writeWorker(E, caller, args) {
  if (!args.id || typeof args.id !== 'string') throw err('E_ARGS', 'worker.write needs the worker id as a string');
  if (args.state === 'forgotten') refuseForgottenArg(args.id);
  // Only the call's own started_at is checked, never an inherited one, so a row already bad can still be written.
  if (args.started_at != null && !Number.isSafeInteger(args.started_at)) {
    throw err('E_ARGS', `worker.write needs started_at for worker ${args.id} as a safe integer of epoch milliseconds, and this write carried ${typeof args.started_at === 'object' ? 'an object' : String(args.started_at).slice(0, 80)}`, { worker_id: args.id });
  }
  // ADR 0029 amendment 4 (proposed): an ended run takes no worker write from its orchestrator adapter. Whatever the adapter was
  // doing when the run closed (a worker_spawn in flight) writes nothing into it; run.end and the operator are not affected.
  if (caller.role === 'orchestrator') {
    const run = rows.current(E.store, 'run', caller.run_id);
    if (run && run.ended_at != null) throw err('E_ARGS', `run ${caller.run_id} has already ended; worker ${args.id} was not written`, { run_id: caller.run_id, ended_at: run.ended_at, worker_id: args.id });
  }
  const prev = rows.current(E.store, 'worker', args.id);
  // W2-3 amendment 2 (B2): a restating write names the row it restates. This method has no await between this read
  // and the append below, so the check and the append are one step; a mismatch appends nothing and is not an error.
  if (args.expect_seq != null && (!prev || prev.seq !== args.expect_seq)) {
    return { skipped: true, reason: 'superseded', current_seq: prev ? prev.seq : null };
  }
  const merged = { ...(prev || {}), ...args };
  merged.run_id = merged.run_id || caller.run_id;
  if (!merged.state || !WORKER_STATES.includes(merged.state)) {
    throw err('E_ARGS', `worker.state must be one of ${WORKER_STATES.join(', ')}, and this write carried ${JSON.stringify(merged.state)}`, { worker_id: args.id });
  }
  if (merged.substrate && !SUBSTRATES.includes(merged.substrate)) {
    throw err('E_ARGS', `worker.substrate must be one of ${SUBSTRATES.join(', ')}, and this write carried ${JSON.stringify(merged.substrate)}`, { worker_id: args.id });
  }
  // A row cannot say both that it is alive and that it exited. The merge inherits every field the
  // caller left out, so without this a worker restarted into `running` still carries the previous
  // life's exited_at, exit_code and exit_signal: the self-contradiction the ladder exists to prevent.
  if (merged.state === 'starting' || merged.state === 'running') {
    merged.exited_at = null; merged.exit_code = null; merged.exit_signal = null;
  }
  // A row not itself paused must not inherit a stale pause from the row it merges over; a row written
  // paused needs both fields as real values (build step 6e; unchanged by 6e-4).
  if (merged.state !== 'paused') { merged.paused_at = null; merged.paused_by = null; }
  else if (typeof merged.paused_by !== 'string' || !merged.paused_by || !Number.isInteger(merged.paused_at)) {
    throw err('E_ARGS', `worker.write needs paused_by as a non-empty string and paused_at as an integer to write worker ${args.id} paused`, { worker_id: args.id });
  }
  // api.md §2: `running` is a claim about a process, refused unless the pid is alive right now. build
  // step 6e-4, ADR 0023 amendment 2 decision 5: `paused` is no longer such a claim — a park's own row is
  // written from the exit handler, after the pid has already gone.
  if (merged.state === 'running' && !pidAlive(merged.pid)) {
    throw err('E_WORKER_NOT_LIVE', `worker ${args.id} cannot be written as ${merged.state} because pid ${merged.pid} is not alive`, { worker_id: args.id, pid: merged.pid == null ? null : merged.pid });
  }
  const t = Date.now();
  const row = rows.append(E.store, 'worker', merged, E.writtenBy(caller), t);
  E.noteWrite();
  return row;
}

function decorate(w) {
  const t = Date.now();
  return {
    ...w,
    pid_alive: pidAlive(w.pid),
    last_event_age_ms: w.last_event_at == null ? null : t - Number(w.last_event_at),
  };
}

// build step 4c: the stream file is a fact of the data dir layout (api.md §1), not of the store, and
// this is the one place that states it — src/run/launch.cjs's workerDir derives the same path for the
// orchestrator adapter's own writer, and the CLI (which must not import src/run) reads it from here.
function streamPathOf(dataDir, workerId) {
  return fwd(path.join(dataDir, 'workers', workerId, 'stream.jsonl'));
}

async function getWorker(E, caller, args) {
  if (!args.worker_id) throw err('E_ARGS', 'worker.get needs a worker_id');
  const w = rows.current(E.store, 'worker', args.worker_id);
  if (!w) throw err('E_NOT_FOUND', `no worker row exists for ${args.worker_id}`, { worker_id: args.worker_id });
  const streamPath = streamPathOf(E.dataDir, args.worker_id);
  let streamBytes = null;
  try { streamBytes = fs.statSync(streamPath).size; } catch { streamBytes = null; }
  return { ...decorate(w), stream_path: streamPath, stream_bytes: streamBytes };
}

async function listWorkers(E, caller, args) {
  const states = Array.isArray(args.states) && args.states.length ? new Set(args.states) : null;
  // build step 6b: a forgotten row is hidden from the default listing (it superseded a worker the
  // operator asked to forget), and shown only when the caller names 'forgotten' explicitly.
  const all = rows.currentAll(E.store, 'worker').filter(w => (states ? states.has(w.state) : w.state !== 'forgotten'));
  return { workers: all.map(decorate) };
}

// build step 6b, design item 2: supersedes a dead worker's rows as 'forgotten', never a DELETE (api.md
// §1: rows supersede, never mutate). Operator only (engine.cjs). Inside one transaction: the read that
// authorises the write and the write itself, so a worker that goes live between the check and the
// append cannot be forgotten out from under it.
// build step 6e-4: 'paused' dropped — a parked worker is never live, so worker.forget accepts one outright.
const FORGET_LIVE_STATES = new Set(['starting', 'running', 'idle', 'stopping']);

async function forgetWorker(E, caller, args) {
  if (!args.worker_id) throw err('E_ARGS', 'worker.forget needs a worker_id');
  const { prev, alive, row, workerRows } = E.store.tx(() => {
    const p = rows.current(E.store, 'worker', args.worker_id);
    if (!p) throw err('E_NOT_FOUND', `no worker row exists for ${args.worker_id}`, { worker_id: args.worker_id });
    if (p.state === 'forgotten') {
      throw err('E_ARGS', `worker ${args.worker_id}'s current row (seq ${p.seq}) is already forgotten`, { worker_id: args.worker_id, seq: p.seq });
    }
    const isAlive = pidAlive(p.pid);
    if (FORGET_LIVE_STATES.has(p.state) && isAlive) {
      throw err('E_WORKER_LIVE', `worker ${args.worker_id} is ${p.state} with pid ${p.pid} alive; kill it before forgetting it`,
        { worker_id: args.worker_id, state: p.state, pid: p.pid, pid_alive: true });
    }
    const t = Date.now();
    const workerRowsBefore = rows.history(E.store, 'worker', args.worker_id).length;
    // 6e-2, should-fix methods-run.cjs:45 (the same rule as run.attach's dead row above): a forgotten
    // row is not itself paused, so it must not inherit a paused row's paused_at/paused_by.
    const r = rows.append(E.store, 'worker', { ...p, state: 'forgotten', paused_at: null, paused_by: null }, E.writtenBy(caller), t);
    return { prev: p, alive: isAlive, row: r, workerRows: workerRowsBefore };
  });
  E.noteWrite();
  // Descriptive facts, not part of what authorised the write: what this worker leaves behind.
  const leases = rows.currentAll(E.store, 'lease')
    .filter(l => l.holder === args.worker_id && l.released_at == null)
    .map(l => l.id);
  const checkpoints = E.store.p('SELECT COUNT(*) AS n FROM checkpoint WHERE worker_id = ?').get(args.worker_id).n;
  const memoryRows = E.store.p('SELECT COUNT(*) AS n FROM memory_entries WHERE worker_id = ?').get(args.worker_id).n;
  return {
    worker_id: args.worker_id, run_id: prev.run_id,
    row_before: { seq: prev.seq, state: prev.state, pid: prev.pid, pid_alive: alive },
    row_after: row,
    superseded: { worker_rows: workerRows },
    left: { leases_unreleased: leases, checkpoints, memory_rows: memoryRows, on_disk: null },
  };
}

module.exports = { LIFE_CLAIMING_STATES, attach, end, getRun, listRuns, writeWorker, getWorker, listWorkers, forgetWorker, decorate, setPaused, setEmbedderMode };
