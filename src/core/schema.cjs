'use strict';
// schema.cjs — every table in one place. The four memory tables are lifted unchanged from
// prototypes/memstore/store-core.cjs (ADR 0002 §4, ADR 0003). The five orchestration tables are new
// and append-only per api.md §1: `seq INTEGER PRIMARY KEY AUTOINCREMENT`, `written_at`, `written_by`,
// and no UPDATE is ever issued against them. The current row of an id is its highest seq.

const MEMORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT PRIMARY KEY, namespace TEXT NOT NULL, worker_id TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'fact',
  text TEXT NOT NULL, text_hash TEXT NOT NULL, embedding BLOB, embedding_model TEXT, embedding_revision TEXT, dim INTEGER,
  tags TEXT, provenance TEXT, supersedes TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  ttl_at INTEGER, accessed_at INTEGER, UNIQUE(namespace, text_hash));
CREATE INDEX IF NOT EXISTS ix_entries_ns ON memory_entries(namespace);
CREATE INDEX IF NOT EXISTS ix_entries_supersedes ON memory_entries(supersedes);
CREATE INDEX IF NOT EXISTS ix_entries_ttl ON memory_entries(ttl_at) WHERE ttl_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS namespace_models (namespace TEXT PRIMARY KEY, embedding_model TEXT NOT NULL, dim INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS owner_heartbeat (id INTEGER PRIMARY KEY CHECK (id = 1), pid INTEGER, pipe TEXT, started_at INTEGER, beat_at INTEGER);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

const ORCHESTRATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS run (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, epoch INTEGER NOT NULL,
  orchestrator_pid INTEGER, adapter_pid INTEGER, started_at INTEGER, ended_at INTEGER,
  exit_reason TEXT, written_at INTEGER NOT NULL, written_by TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_run_id ON run(id, seq);

CREATE TABLE IF NOT EXISTS worker (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, run_id TEXT, substrate TEXT,
  pid INTEGER, session_id TEXT, adapter_pid INTEGER, argv_hash TEXT, state TEXT,
  worktree TEXT, task_id TEXT, started_at INTEGER, exited_at INTEGER, exit_code INTEGER,
  exit_signal TEXT, turns INTEGER, input_tokens INTEGER, output_tokens INTEGER,
  cost_usd REAL, last_event_at INTEGER, written_at INTEGER NOT NULL, written_by TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_worker_id ON worker(id, seq);

CREATE TABLE IF NOT EXISTS task (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, run_id TEXT, spec TEXT,
  acceptance TEXT, files_owned TEXT, state TEXT NOT NULL, results TEXT, depends_on TEXT,
  written_at INTEGER NOT NULL, written_by TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_task_id ON task(id, seq);

CREATE TABLE IF NOT EXISTS lease (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, task_id TEXT NOT NULL, run_id TEXT,
  holder TEXT, holder_role TEXT, granted_at INTEGER, expires_at INTEGER, released_at INTEGER,
  supersedes TEXT, written_at INTEGER NOT NULL, written_by TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_lease_task ON lease(task_id, seq);
CREATE INDEX IF NOT EXISTS ix_lease_id ON lease(id, seq);

CREATE TABLE IF NOT EXISTS checkpoint (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, task_id TEXT, worker_id TEXT,
  run_id TEXT, turn INTEGER, files_touched TEXT, tool_digest TEXT, stated TEXT,
  source TEXT NOT NULL, written_at INTEGER NOT NULL, written_by TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_ckpt_task ON checkpoint(task_id, seq);
CREATE INDEX IF NOT EXISTS ix_ckpt_worker ON checkpoint(worker_id, seq);

CREATE TABLE IF NOT EXISTS permission (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, run_id TEXT, worker_id TEXT,
  adapter_pid INTEGER, tool TEXT, input TEXT, input_truncated INTEGER, input_sha256 TEXT,
  state TEXT NOT NULL, verdict_by TEXT, reason TEXT, requested_at INTEGER, decided_at INTEGER,
  written_at INTEGER NOT NULL, written_by TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_permission_id ON permission(id, seq);

-- ADR 0041 decision 3: a receipt for every harness memory action. Append-only like the tables above.
CREATE TABLE IF NOT EXISTS memory_event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, run_id TEXT, worker_id TEXT, task_id TEXT,
  kind TEXT NOT NULL, key TEXT, row_ids TEXT, newest_row_id TEXT, bytes INTEGER, sha256 TEXT,
  ok INTEGER NOT NULL, code TEXT, message TEXT, dropped INTEGER, over_budget INTEGER,
  written_at INTEGER NOT NULL, written_by TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_memory_event_id ON memory_event(id, seq);
CREATE INDEX IF NOT EXISTS ix_memory_event_run ON memory_event(run_id, seq);
-- ADR 0043 decision 2: the store, not a check that could race, guarantees one successful wrap-up per (run, key);
-- a failed one (ok 0) is a receipt, not a claim, so a retry may still succeed. migrateOwner upgrades an older index.
CREATE UNIQUE INDEX IF NOT EXISTS ux_memory_event_wrapup ON memory_event(run_id, key) WHERE kind = 'wrapup' AND ok = 1;

-- ADR 0041 decision 6: the usage ledger, one row per turn.
CREATE TABLE IF NOT EXISTS usage (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, run_id TEXT, worker_id TEXT, task_id TEXT,
  turn INTEGER, substrate TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER,
  cache_read_tokens INTEGER, cache_creation_tokens INTEGER, cost_usd REAL, cost_basis TEXT, at INTEGER,
  written_at INTEGER NOT NULL, written_by TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_usage_id ON usage(id, seq);
CREATE INDEX IF NOT EXISTS ix_usage_run ON usage(run_id, seq);
`;

// Additive columns so an existing data dir upgrades in place. First (session-3 hardening MS-5): on a
// duplicate text upsert the original worker_id survives and the writer that caused the update is
// recorded apart. Second (ADR 0013 §1): the dependency edges a task was created with. Both are caught
// as duplicates on a store that already has the column, including every freshly created one.
// Third (build step 5b, ADR 0015's open consequence): a worker row carries whether it is mid-turn
// (the harness's own claim, from a stdin write or a Codex launch with a prompt, cleared by that
// worker's next `result`) and, once dead or stopped, what established the death. Both additive and
// caught as duplicates the same way, including on a store that predates the column.
// Fourth (ADR 0021 decisions 3 and 4): the permission mode a Claude Code launch asked for, the one its
// system/init says it got, and the Claude Code version, all three the harness's reading of the init.
// Fifth (build step 6e, ADR 0023 decision 1): who paused a worker and when, cleared to null on every
// row that is not itself paused (methods-run.cjs writeWorker).
// Sixth (build step 6f, ADR 0023 amendment 3 decision 4.1): who paused a RUN and when, written only by
// `run.setPaused` and carried forward by `run.attach` from the previous epoch (methods-run.cjs).
// Seventh (build step 6i, design item 1, closing C2): the worker's own `turns` at a park's acceptance
// (`pause.cjs`'s step 1b `stopping` write), nullable, carried forward by every later row of the same
// park and reset to null by the next `starting`/`running` row (worker.cjs `rowOf`). Null on a plain
// stop's `stopping` row (not a park), so wake.cjs's masking there is unchanged.
// Eighth (build step 6i-2, design item 1, ADR 0023 amendment 4 decision 1): the run row's own record of
// what a `run.pause` parked — `{ parked, already_parked, unconfirmed }` as JSON text, nullable — so
// `run.resume` can match by equality with it instead of comparing two processes' clocks.
const MIGRATIONS = [
  'ALTER TABLE memory_entries ADD COLUMN last_writer_id TEXT',
  // ADR 0044 decision 6: who wrote the row (`worker:<id>`, `orchestrator`, `harness` or `operator`), set by the core on
  // insert and never changed. Null on a row written before the column, and read as unknown; nothing guesses it.
  'ALTER TABLE memory_entries ADD COLUMN written_by TEXT',
  // ADR 0044 decision 3: the first-message index looks up promoted rows by their `promote:<id>` key.
  "CREATE INDEX IF NOT EXISTS ix_memory_event_promote ON memory_event(key) WHERE kind = 'project_write' AND ok = 1",
  'ALTER TABLE task ADD COLUMN depends_on TEXT',
  'ALTER TABLE worker ADD COLUMN mid_turn INTEGER',
  'ALTER TABLE worker ADD COLUMN death_established_by TEXT',
  'ALTER TABLE worker ADD COLUMN permission_mode_requested TEXT',
  'ALTER TABLE worker ADD COLUMN permission_mode_effective TEXT',
  'ALTER TABLE worker ADD COLUMN claude_code_version TEXT',
  'ALTER TABLE worker ADD COLUMN paused_at INTEGER',
  'ALTER TABLE worker ADD COLUMN paused_by TEXT',
  'ALTER TABLE run ADD COLUMN paused_at INTEGER',
  'ALTER TABLE run ADD COLUMN paused_by TEXT',
  'ALTER TABLE worker ADD COLUMN park_turns INTEGER',
  'ALTER TABLE run ADD COLUMN pause_parks TEXT',
  // Ninth (build step W2-1, ADR 0025 decision 1): the structured result a worker handed back on release,
  // `{ result, by, lease_id, at }` as JSON text, nullable, carried forward by every later task row.
  'ALTER TABLE task ADD COLUMN handoff TEXT',
  // Tenth (ADR 0025 amendment 1): a lease row's own length in ms, written at grant, take-control and renew.
  'ALTER TABLE lease ADD COLUMN ttl_ms INTEGER',
  // Build step W2-3 (S4a, S4b): per-agent receipts. Worker: the init's model, cache tokens, an uncapped
  // tool_use count, and the worktree's HEAD at spawn and at settle. Run: the orchestrator's usage, set at run.end.
  'ALTER TABLE worker ADD COLUMN model TEXT',
  'ALTER TABLE worker ADD COLUMN cache_read_tokens INTEGER',
  'ALTER TABLE worker ADD COLUMN cache_creation_tokens INTEGER',
  'ALTER TABLE worker ADD COLUMN tool_calls INTEGER',
  'ALTER TABLE worker ADD COLUMN base_sha TEXT',
  'ALTER TABLE worker ADD COLUMN head_sha TEXT',
  'ALTER TABLE run ADD COLUMN orch_model TEXT',
  'ALTER TABLE run ADD COLUMN orch_input_tokens INTEGER',
  'ALTER TABLE run ADD COLUMN orch_output_tokens INTEGER',
  'ALTER TABLE run ADD COLUMN orch_cache_read_tokens INTEGER',
  'ALTER TABLE run ADD COLUMN orch_cache_creation_tokens INTEGER',
  'ALTER TABLE run ADD COLUMN orch_cost_usd REAL',
  'ALTER TABLE run ADD COLUMN orch_turns INTEGER',
  // ADR 0028 decision 3 and 5 (S6b): the effort level asked for at launch, null when not asked. The
  // effective level is not in system/init, so these name the request and claim nothing more.
  'ALTER TABLE worker ADD COLUMN effort_requested TEXT',
  // Build 12b: why a worker row has no head_sha when the adapter's bounded retry never got one (null otherwise).
  'ALTER TABLE worker ADD COLUMN head_error TEXT',
  'ALTER TABLE run ADD COLUMN orch_effort_requested TEXT',
  // ADR 0031 decision 6 (build 12 wave 2): the run's `max_fix_rounds` lever, written by `run.attach`, and the
  // task a fix task repairs, written by `task.create`, so core can refuse a fix task past the cap.
  'ALTER TABLE run ADD COLUMN max_fix_rounds INTEGER',
  'ALTER TABLE task ADD COLUMN repairs TEXT',
  // Why a worker row has no base_sha when every base lookup attempt failed (null otherwise); mirrors head_error.
  'ALTER TABLE worker ADD COLUMN base_error TEXT',
  // ADR 0039 decision 1: the creation time (ms since epoch) of the process a row's pid names, read once at spawn from a CIM snapshot; null on an older row or when the read failed (then `pid_created_error` says why). A kill needs it to prove the pid is still the process belay spawned.
  'ALTER TABLE worker ADD COLUMN pid_created INTEGER',
  'ALTER TABLE worker ADD COLUMN pid_created_error TEXT',
  // The executable image name the spawner launched (path.basename of the child's spawnfile), the only thing a null pid_created can be checked against.
  'ALTER TABLE worker ADD COLUMN pid_image TEXT',
  'ALTER TABLE run ADD COLUMN adapter_pid_created INTEGER',
  // ADR 0040 decision 1: structure for a memory row. Every column nullable; a row written before them reads as
  // untitled, unverified and of unknown source. Run, task and turn name who wrote the row (derived, never self-reported).
  'ALTER TABLE memory_entries ADD COLUMN title TEXT',
  'ALTER TABLE memory_entries ADD COLUMN status TEXT',
  'ALTER TABLE memory_entries ADD COLUMN status_receipt TEXT',
  'ALTER TABLE memory_entries ADD COLUMN status_by TEXT',
  'ALTER TABLE memory_entries ADD COLUMN status_at INTEGER',
  'ALTER TABLE memory_entries ADD COLUMN run_id TEXT',
  'ALTER TABLE memory_entries ADD COLUMN task_id TEXT',
  'ALTER TABLE memory_entries ADD COLUMN turn INTEGER',
  'ALTER TABLE memory_entries ADD COLUMN source TEXT',
  'ALTER TABLE memory_entries ADD COLUMN redactions TEXT',
  'ALTER TABLE memory_entries ADD COLUMN body TEXT',
  // ADR 0041 decision 1: the run's memory levers as JSON text, and its project name; written by run.attach, carried forward.
  'ALTER TABLE run ADD COLUMN memory_levers TEXT',
  'ALTER TABLE run ADD COLUMN project TEXT',
  // ADR 0034 amendment 1: the directory the run's belay.config.json lives in (or is created in), so a resume writes the operator's
  // choice of embedder mode into the run's own project and never into whatever folder the CLI was run from.
  'ALTER TABLE run ADD COLUMN project_dir TEXT',
  // The template version of the text a row's vector was made from: v1 is the text as stored, v2 a note's title and When: line
  // (memory-notes.cjs embedText). Null on a row embedded before the column, and read as v1. Set on every embedded row.
  'ALTER TABLE memory_entries ADD COLUMN text_template TEXT',
  // The orchestrator's memory_queries for a worker (JSON text, nullable), kept on its row so a relaunch or a resume in another
  // process embeds the same index queries the spawn did.
  'ALTER TABLE worker ADD COLUMN memory_queries TEXT',
  // The run's CURRENT on_embedder_failure mode (required, keyword or off): written by run.attach at launch and by run.setEmbedderMode when a
  // resume switches it, so a reader without the owner's guard (a copy fallback) sees the live mode. Null reads as the default, required.
  'ALTER TABLE run ADD COLUMN embedder_mode TEXT',
  // The harness's record of the eval-only native_memory lever (ADR 0024 amendment 3): the resolved folder, or null. A relaunch reads the lever
  // from here and never from the worker's settings.json, which the worker can edit.
  'ALTER TABLE worker ADD COLUMN native_memory TEXT',
  // ADR 0046 decision 1: the epoch of the attach that revived a run whose previous adapter was dead with no run.end, carried by every later
  // row of that life; null for a run that never lapsed. It lets "the run that is live now keeps the paths" order two lapsed runs without a clock.
  'ALTER TABLE run ADD COLUMN revived_epoch INTEGER',
];

// Indexes over the columns above. They run after MIGRATIONS because a store that predates a column cannot
// index it until the column exists. IF NOT EXISTS makes them safe on every open, including a read copy.
const MEMORY_INDEXES = [
  'CREATE INDEX IF NOT EXISTS ix_entries_run ON memory_entries(run_id)',
  'CREATE INDEX IF NOT EXISTS ix_entries_task ON memory_entries(task_id)',
  'CREATE INDEX IF NOT EXISTS ix_entries_status ON memory_entries(status)',
  'CREATE INDEX IF NOT EXISTS ix_entries_ns_created ON memory_entries(namespace, created_at)',
];

// build step 6b: 'forgotten' is the state worker.forget appends over a dead worker's rows, always last
// so every existing ordinal comparison (there are none today) would see it as the terminal-most state.
// build step 6e: 'paused' is inserted after 'idle' (ADR 0023 decision 1); the list still ends 'forgotten'.
const WORKER_STATES = ['starting', 'running', 'idle', 'paused', 'stopping', 'stopped', 'dead', 'forgotten'];
const TASK_STATES = ['open', 'assigned', 'released', 'done'];
const SUBSTRATES = ['claude-code', 'codex'];
const ROLES = ['orchestrator', 'worker', 'operator'];
// build step 6d, ADR 0020 decision 2: the four states a permission row's `state` column takes.
const PERMISSION_STATES = ['pending', 'allowed', 'denied', 'expired'];
const DEFAULT_LEASE_TTL_MS = 600000;
// ADR 0003 §2: exact cosine is 108 ms p95 at 100k rows, so the owner refuses above this without opt-in.
const NAMESPACE_SCAN_CEILING = 50000;
// ADR 0027 decision 7: the same scan cost at any width, so the row ceiling falls as dims rise (18,750 at 1024).
let ceilingOverride = null; // tests only: a lower row ceiling, so E_NAMESPACE_TOO_LARGE needs no 18,750 rows
const scanCeiling = dim => (ceilingOverride !== null ? ceilingOverride : Math.floor(NAMESPACE_SCAN_CEILING * 384 / Math.max(1, dim)));
const setScanCeilingForTest = n => { ceilingOverride = n; };

function ensureSchema(db) {
  db.exec(MEMORY_SCHEMA);
  db.exec(ORCHESTRATION_SCHEMA);
  for (const stmt of MIGRATIONS) {
    try { db.exec(stmt); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  }
  for (const stmt of MEMORY_INDEXES) db.exec(stmt);
}

module.exports = {
  ensureSchema, MEMORY_SCHEMA, ORCHESTRATION_SCHEMA, MIGRATIONS, MEMORY_INDEXES,
  WORKER_STATES, TASK_STATES, SUBSTRATES, ROLES, PERMISSION_STATES, DEFAULT_LEASE_TTL_MS, NAMESPACE_SCAN_CEILING, scanCeiling, setScanCeilingForTest,
};
