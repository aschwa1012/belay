// tools.cjs — the tools of ADR 0010 §2 as amended by ADR 0015 and ADR 0040 §4, their schemas, and the
// route each one takes into the Core API or the RunManager. `toolsFor(role)` returns exactly what `tools/list` sends for that role:
// the ten both-role tools plus that role's own. ROUTES is kept separate from the schemas so that no
// routing field is ever serialised into the listing, which is measured against the ADR 0010 §5 budget
// (16,384 bytes orchestrator since ADR 0010 amendment 9, 7,168 bytes worker since amendment 6). Descriptions say what the tool returns as proof and
// when it refuses; nothing else, because every byte is a per-turn tax on the orchestrator's context.
//
// Two places where ADR 0010 disagrees with itself or with src/core/api.md, resolved in favour of the
// §2 table and the contract, and reported to the lead:
//   - §5 prose says the worker role lists ten tools; the §2 table gives it twelve (nine both-role plus
//     lease_renew, lease_release, checkpoint_write). Twelve are listed.
//   - §2 routes worker_stop to `run.stopWorker` or `run.kill` by mode; api.md §5 gives one RunManager
//     method, `stop({ worker_id, mode, timeout_ms })`. The contract wins; `mode` is required.
'use strict';

const { isJobId } = require('../run/job-prefixes.cjs'); // pure
const { isPathId, pathIdMessage } = require('../core/path-id.cjs'); // pure
const NOTES = require('./tools-notes.cjs'); // ADR 0047: the listing of a worker whose run has the notes lever on
const { WORKER_TYPES } = require('../run/agent-defaults.cjs'); // pure; the agent_type enum
const S = (properties, required) => {
  const s = { type: 'object', properties };
  if (required) s.required = required;
  return s;
};
const str = (description) => (description ? { type: 'string', description } : { type: 'string' });
const int = (description) => (description ? { type: 'integer', description } : { type: 'integer' });
const num = () => ({ type: 'number' });
const bool = () => ({ type: 'boolean' });
const strs = (description) => {
  const a = { type: 'array', items: { type: 'string' } };
  if (description) a.description = description;
  return a;
};

// name -> { role, via, method }. `via` is 'core' (a dotted Core method), 'run' (a RunManager method)
// or 'briefing' (the one tool that composes two Core calls into { line, doc }).
const ROUTES = {
  memory_store: { role: 'both', via: 'core', method: 'memory.store' },
  memory_retrieve: { role: 'both', via: 'core', method: 'memory.get' },
  memory_search: { role: 'both', via: 'core', method: 'memory.search' },
  // ADR 0040 §4: the timeline around one row, and the orchestrator's status-with-receipt hand.
  memory_timeline: { role: 'both', via: 'core', method: 'memory.timeline' },
  memory_verify: { role: 'orchestrator', via: 'core', method: 'memory.setStatus' },
  memory_list: { role: 'both', via: 'core', method: 'memory.list' },
  memory_delete: { role: 'both', via: 'core', method: 'memory.delete' },
  memory_stats: { role: 'both', via: 'core', method: 'memory.stats' },
  status: { role: 'both', via: 'core', method: 'status.get' },
  task_list: { role: 'both', via: 'core', method: 'task.list' },
  briefing: { role: 'both', via: 'briefing', method: 'continuity.resumeLine+resumeDoc' },
  worker_spawn: { role: 'orchestrator', via: 'run', method: 'spawn' },
  worker_message: { role: 'orchestrator', via: 'run', method: 'message' },
  worker_stop: { role: 'orchestrator', via: 'run', method: 'stop' },
  worker_restart: { role: 'orchestrator', via: 'run', method: 'restart' },
  task_create: { role: 'orchestrator', via: 'core', method: 'task.create' },
  task_assign: { role: 'orchestrator', via: 'core', method: 'task.assign' },
  // ADR 0010 amendment 3: the only way an orchestrator over MCP can write `done` and clear a dependency.
  task_evaluate: { role: 'orchestrator', via: 'core', method: 'task.evaluate' },
  // ADR 0015: admitted to the surface, which is nineteen tools from that record. It is the only way
  // to wait in the deployment ADR 0009 §1 names first — an operator's own session, which belay
  // attaches to and therefore cannot wake, because it does not own that session's stdin.
  worker_wait: { role: 'orchestrator', via: 'run', method: 'wait' },
  lease_renew: { role: 'worker', via: 'core', method: 'lease.renew' },
  lease_release: { role: 'worker', via: 'core', method: 'lease.release' },
  checkpoint_write: { role: 'worker', via: 'core', method: 'continuity.checkpoint' },
  // ADR 0047 decision 4: listed only for a worker whose run has the notes lever on (tools-notes.cjs); the core refuses E_LEVER_OFF otherwise.
  memory_note_resolve: { role: 'worker', via: 'core', method: 'memory.noteResolve' },
  // ADR 0047 decision 1: listed for the orchestrator of a notes run only; callable by either role, the core refuses E_LEVER_OFF otherwise.
  memory_summaries: { role: 'both', via: 'core', method: 'memory.summaries' },
  // Wave 4: the refuted-note wake carries ids; the reasons are read here. Orchestrator only.
  memory_note_refutation: { role: 'orchestrator', via: 'core', method: 'memory.noteRefutation' },
  // The operator asks the orchestrator to mark a note incorrect: the same hold a worker's report makes. Listed with the notes lever.
  memory_report: { role: 'orchestrator', via: 'core', method: 'memory.noteReport' },
  // build step 6d, ADR 0020 decisions 1 and 5: the worker adapter's own prompt tool (listed only for
  // an adapter launched with --permit, never through toolsFor, and hidden from the model — measured in
  // ADR 0020's evidence table) and the orchestrator's window and hand on the same channel.
  permit: { role: 'worker', via: 'permit', method: 'permission.request+wait' },
  permission_list: { role: 'orchestrator', via: 'core', method: 'permission.list' },
  permission_decide: { role: 'orchestrator', via: 'core', method: 'permission.decide' },
  // ADR 0043 decision 1: listed only when the run's knowledge_agent lever is on (toolsFor's knowledge option);
  // with the lever off the manager refuses it E_LEVER_OFF, and the listing never mentions it.
  knowledge_ask: { role: 'orchestrator', via: 'run', method: 'ask' },
  // ADR 0054 decision 2: the orchestrator has no shell; belay runs these git reads for it with its own argv (git-read.cjs).
  git_read: { role: 'orchestrator', via: 'git', method: 'gitRead' },
};

const BOTH = [
  {
    name: 'memory_store',
    description: 'Store one entry. Returns the row written: id, action, namespace, worker id. Refuses text past the embedder\'s window.',
    inputSchema: S({
      text: str('One self-contained statement'),
      namespace: str('Defaults to this run; moved to the project when your task ends'),
      type: { type: 'string', enum: ['fact', 'episode', 'procedure'] },
      tags: strs(),
      provenance: str('Source, e.g. a path'),
      supersedes: str('id this replaces'),
      title: str('One line, at most 160 bytes'),
      ttl_seconds: num(),
    }, ['text']),
  },
  {
    name: 'memory_retrieve',
    description: 'Fetch entries by id, or by ids (max 50). Returns rows without vectors, or found false; ids keeps the order asked and names the missing.',
    inputSchema: S({ id: str(), ids: strs() }),
  },
  {
    name: 'memory_search',
    description: 'Search memory. Query with one short task line for what you will do, naming files or symbols; several short queries beat one long one. view index: ids and titles only. Result names modes_run, modes_failed, absence_established (true only if both ran and found nothing).',
    inputSchema: S({
      query: str(),
      namespace: str(),
      k: int('default 10'),
      min_score: num(),
      include_superseded: bool(),
      mode: { type: 'string', enum: ['semantic', 'keyword', 'hybrid'] },
      view: { type: 'string', enum: ['full', 'index'] },
      filter: { type: 'object' },
      order: { type: 'string', enum: ['score', 'newest', 'oldest'] },
      offset: int(),
    }, ['query']),
  },
  {
    name: 'memory_timeline',
    description: 'Entries around one entry, oldest first: anchor, before, after, scope. Refuses an unknown anchor.',
    inputSchema: S({
      anchor_id: str(),
      before: int('default 5'),
      after: int('default 5'),
      scope: { type: 'string', enum: ['task', 'worker', 'run', 'namespace'] },
    }, ['anchor_id']),
  },
  {
    name: 'memory_list',
    description: 'List recent entries in a namespace.',
    inputSchema: S({ namespace: str(), limit: int(), offset: int() }),
  },
  {
    name: 'memory_delete',
    description: 'Delete one entry by id. Returns id and whether a row was deleted.',
    inputSchema: S({ id: str() }, ['id']),
  },
  {
    name: 'memory_stats',
    description: 'Row counts plus the owner pid, pipe and whether it answered.',
    inputSchema: S({}),
  },
  {
    name: 'status',
    description: 'The liveness ladder: each rung, whether it held and what established it, the run, and per worker pid_alive, last-event age, turns, tokens and cost. Never refuses.',
    inputSchema: S({ deep: bool('Also query the substrate registry; slower') }),
  },
  {
    name: 'task_list',
    description: 'Tasks with their current lease holder and expiry, whether that holder\'s pid is alive, and the last checkpoint id and time.',
    inputSchema: S({ states: strs('open, assigned, released or done') }),
  },
  {
    name: 'briefing',
    description: 'Resume material rebuilt from the store: line (max 400 bytes) and doc (max 4096), anything a worker said labelled unverified. Give worker_id or task_id.',
    inputSchema: S({ worker_id: str(), task_id: str() }),
  },
];

const ORCHESTRATOR = [
  {
    name: 'worker_spawn',
    description: 'Launch a real Claude Code or Codex process and wait for its ready event. Returns the worker row: id, substrate, pid, session id, argv hash, started_at, ready_ms. If no ready event arrives it fails with the exit code and stderr tail and writes the row dead, never running. Takes seconds.',
    inputSchema: S({
      substrate: { type: 'string', enum: ['claude-code', 'codex'] },
      worktree: str('Absolute path; the worker\'s cwd'),
      prompt: str('First message'),
      task_id: str('Assign this task once ready and prepend its resume line'),
      model: str(),
      agent_type: { type: 'string', enum: WORKER_TYPES, description: 'Configured model and effort default' },
      effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
      memory_queries: strs('Up to 4 task lines naming the situations the worker will be in, each max 160 bytes'),
      allowed_tools: strs(),
      permission_mode: str(),
      startup_timeout_ms: int('default 60000'),
      worker_id: str('Otherwise generated'),
    }, ['substrate', 'worktree', 'prompt']),
  },
  {
    // ADR 0015. `worker_spawn` above returns at the ready event and the worker keeps running; this is
    // the call that waits for what happens next. A timeout is a result rather than an error because
    // the caller's own tool timeout has to be the outer bound, and a refusal would lose the fact that
    // nothing had finished yet.
    name: 'worker_wait',
    description: 'Block until one of the named workers, or any worker this session launched, finishes a turn or dies, or the timeout passes. Returns which worker, what happened, what established it, its turn and checkpoint id, and how long the call held. timed_out is a result. already: turn ended earlier.',
    inputSchema: S({
      worker_ids: strs('Otherwise every worker this session launched'),
      timeout_ms: int('default 110000'),
    }),
  },
  {
    name: 'worker_message',
    description: 'Send text to a live worker. Returns the channel used, bytes written, pid and turn. Refuses, naming the substrate, when that substrate cannot take a message in its current state.',
    inputSchema: S({ worker_id: str(), text: str() }, ['worker_id', 'text']),
  },
  {
    name: 'worker_stop',
    description: 'Stop a worker by its recorded pid. Returns exit code, signal, ms to exit, whether it was graceful or killed, and the session id to resume from later.',
    inputSchema: S({
      worker_id: str(),
      mode: { type: 'string', enum: ['graceful', 'kill'] },
      timeout_ms: int('default 10000'),
    }, ['worker_id', 'mode']),
  },
  {
    name: 'worker_restart',
    description: 'Restart a worker from its last checkpoint. Returns which branch was taken, resume or replace, and why, the old and new pid, session id, checkpoint id and the first turn\'s usage. Past about 100 s it returns status "not ready yet" with first_turn_awaited false; the relaunch carries on.',
    inputSchema: S({ worker_id: str(), first_turn_timeout_ms: int('default 180000') }, ['worker_id']),
  },
  {
    name: 'task_create',
    description: 'Create a task with the checks that decide it is done, the files it owns and the tasks it must wait for. Returns the task row in state open. Refuses, naming the other task and the paths, when a file is already owned by a task that is not done, and refuses a dependency that has no row.',
    inputSchema: S({
      spec: str('What is to be done'),
      acceptance: S({
        commands: {
          type: 'array',
          items: S({ argv: strs(), cwd: str(), timeout_ms: int() }, ['argv']),
        },
        files_within_owned: bool(),
        verdict: { const: true },
      }),
      files_owned: strs('Paths relative to the worktree'),
      depends_on: strs('Task ids that must be done before this one can be assigned'),
      repairs: str('A fix task: the id of the work task it repairs; capped by max_fix_rounds'),
      id: str(),
    }, ['spec']),
  },
  {
    name: 'task_assign',
    description: 'Assign a task to a live worker and take a lease for it. Returns the old and new lease rows and the task row. Refuses when the operator holds the lease, when a dependency of the task is not done, naming it and its holder, or when the worker is not starting, running or idle.',
    inputSchema: S({ task_id: str(), worker_id: str(), ttl_ms: int('default 600000') }, ['task_id', 'worker_id']),
  },
  {
    // ADR 0020 decision 5: the orchestrator's window onto the permission channel, so a headless run
    // with a prompting worker does not stall until a human types.
    name: 'permission_list',
    description: 'List permission requests waiting on a verdict. Returns each with its tool, input, age and whether the requesting adapter is still alive. Defaults to pending only.',
    inputSchema: S({ run_id: str(), states: strs('pending, allowed, denied or expired; default pending') }),
  },
  {
    name: 'permission_decide',
    description: 'Allow or deny one pending permission request. Returns the request and verdict rows, and whether the requesting adapter is alive to act on it.',
    inputSchema: S({ id: str(), verdict: { type: 'string', enum: ['allow', 'deny'] }, reason: str() }, ['id', 'verdict']),
  },
  {
    name: 'task_evaluate',
    description: 'Run a task\'s checks in worktree. Returns row and results; done (unblocks dependents) only if all pass.',
    inputSchema: S({
      task_id: str(),
      worktree: str(),
      base: str('Diff base; default merge-base main'),
    }, ['task_id', 'worktree']),
  },
  {
    // ADR 0040 §4. A worker cannot verify a claim, so this is not on the worker listing.
    name: 'memory_verify',
    description: 'Set an entry\'s status with its evidence. Returns id, status, previous status, receipt. Refuses a receipt that fails its grammar.',
    inputSchema: S({
      id: str(),
      status: { type: 'string', enum: ['unverified', 'verified', 'refuted'] },
      receipt: str('checkpoint:id, task:id, memory:id, commit:sha or test:text; none for unverified'),
    }, ['id', 'status']),
  },
  {
    // ADR 0054 decision 2. One tool with an op, not four: the listing pays for one schema.
    name: 'git_read',
    description: 'Read-only git, run by belay with fixed argv, in worktree, task_id\'s worktree or the run\'s. Returns argv, exit_code, out (16 KB max, truncated marked). Refuses a rev or path that could be an option.',
    inputSchema: S({
      op: { type: 'string', enum: ['status', 'log', 'diff', 'show'] },
      worktree: str(),
      task_id: str(),
      rev: str('a..b for log/diff; one commit for show'),
      path: str(),
      stat: bool(),
      n: int('log, default 20'),
    }, ['op']),
  },
];

const WORKER = [
  {
    name: 'lease_renew',
    description: 'Extend your lease. Returns the lease row with its new expiry. Refuses if you are not the holder or it expired.',
    inputSchema: S({ lease_id: str() }, ['lease_id']),
  },
  {
    name: 'lease_release',
    description: 'Release your lease. Returns the released task row; refuses if not the holder. result (max 4KB) hands back branch, head, tests, findings; a review sets verdict holds|refuted and summary. The orchestrator reads it as handoff.',
    inputSchema: S({ lease_id: str(), reason: str(), result: { type: 'object' } }, ['lease_id']),
  },
  {
    name: 'checkpoint_write',
    description: 'Record what you did and what is next, as your claim. Returns the checkpoint row. Refuses unless you hold the task\'s current lease.',
    inputSchema: S({
      task_id: str(),
      turn: int(),
      files_touched: strs(),
      summary: str(),
      next_step: str(),
      open_questions: strs(),
    }, ['task_id']),
  },
];

const ROLES = ['orchestrator', 'worker'];

// ADR 0043 decision 1. Not in ORCHESTRATOR: the listing carries it only for a run whose knowledge_agent lever is
// on, so a run without the lever pays no byte for it. Workers never get it; a worker asks through its result.
const KNOWLEDGE_TOOL = {
  name: 'knowledge_ask',
  description: 'Ask the run\'s knowledge agent about stored memory. Returns answer, cited ids with found and status, uncited_claims. Answers from memory only; unverified rows are marked. Refuses E_LEVER_OFF when the lever is off.',
  inputSchema: S({ question: str() }, ['question']),
};

// build step 6d, ADR 0020 decision 1: the worker adapter's own prompt tool, listed only for an
// adapter launched with --permit (belay-mcp.cjs appends it to toolsFor's own listing, never through
// this function), and measured on this build: the model cannot see it (ADR 0020, the
// measured receipt), so its bytes are never a per-turn tax on the worker's own context and are
// capped separately from ADR 0010 §5's 4,096 byte worker budget.
const PERMIT_TOOL = {
  name: 'permit',
  description: 'Answers a permission prompt from the operator or orchestrator. Called by the substrate itself, never by the model.',
  inputSchema: S({ tool_name: str(), input: { type: 'object' }, tool_use_id: str() }),
};

// ADR 0043 decision 1: the knowledge agent reads memory it did not write, the corpus among it, so its adapter (a
// worker adapter whose argv worker id carries the reserved prefix, which only the harness can give) lists and allows
// the memory read tools and nothing else: no store, no delete, no lease or checkpoint.
const KNOWLEDGE_READ_TOOLS = ['memory_retrieve', 'memory_search', 'memory_timeline', 'memory_list', 'memory_stats'];
const isKnowledgeAgent = (role, workerId) => role === 'worker' && typeof workerId === 'string' && workerId.startsWith('knowledge-');
const isReviewJob = (role, workerId) => role === 'worker' && typeof workerId === 'string' && isJobId(workerId); // belay's read-only jobs (the note review job, the run-close scrubber and archive reviewer): it reads files and lists no belay tool

// `knowledge` (orchestrator only) adds knowledge_ask; omitted or false, the listing is byte-for-byte what it was.
// `workerId` (the adapter's argv) narrows the knowledge agent's listing to its read tools.
// `queries` (orchestrator): whether worker_spawn lists `memory_queries`. They feed the first-message index only, so a run with that lever
// off (the default) is not shown the field; a call that carries it is still accepted (the schema of validateArgs is the full one).
const withoutQueries = (list) => list.map((t) => {
  if (t.name !== 'worker_spawn') return t;
  const { memory_queries, ...properties } = t.inputSchema.properties;
  return { ...t, inputSchema: { ...t.inputSchema, properties } };
});

function toolsFor(role, { knowledge = false, workerId = null, notes = false, queries = false } = {}) {
  if (role === 'orchestrator') {
    const all = knowledge ? BOTH.concat(ORCHESTRATOR, [KNOWLEDGE_TOOL]) : BOTH.concat(ORCHESTRATOR);
    const base = queries ? all : withoutQueries(all);
    // A notes run: a project memory_store is a note, and memory_verify is gone (notes are disputed by memory_report, never by a status).
    return notes ? base.filter((t) => t.name !== 'memory_verify').map((t) => (t.name === 'memory_store' ? NOTES.memoryStoreNotes(t, 'orchestrator') : t)).concat([NOTES.SUMMARIES, NOTES.NOTE_REFUTATION, NOTES.MEMORY_REPORT]) : base;
  }
  if (isReviewJob(role, workerId)) return [];
  if (isKnowledgeAgent(role, workerId)) return BOTH.filter((t) => KNOWLEDGE_READ_TOOLS.includes(t.name));
  if (role === 'worker') return notes ? NOTES.notesWorkerListing(BOTH.concat(WORKER).map((t) => (t.name === 'memory_store' ? NOTES.memoryStoreNotes(t, 'worker') : t))) : BOTH.concat(WORKER);
  throw Object.assign(new Error(`unknown role ${role}`), { code: 'E_ROLE' });
}

const permitBytes = () => Buffer.byteLength(JSON.stringify(PERMIT_TOOL), 'utf8');

// Which role may call a tool, without building a listing. Returns 'both', 'orchestrator', 'worker', or
// undefined when the name is not a tool at all.
const roleOf = (name) => (ROUTES[name] ? ROUTES[name].role : undefined);
const routeOf = (name) => ROUTES[name];
// `notes` (the run has the notes lever on): the orchestrator is not given memory_verify, since a note is disputed by memory_report and never set by a status.
const allows = (role, name, workerId = null, { notes = false } = {}) => {
  if (isReviewJob(role, workerId)) return false;
  if (notes && role === 'orchestrator' && name === 'memory_verify') return false;
  if (isKnowledgeAgent(role, workerId)) return KNOWLEDGE_READ_TOOLS.includes(name);
  const r = roleOf(name);
  return r === 'both' || r === role;
};

const BUDGET = { orchestrator: 16384, worker: 7168, permit: 320 }; // ADR 0010 amendment 9: orchestrator 16 KB, worker 7 KB
const listingBytes = (role, opts) => Buffer.byteLength(JSON.stringify(toolsFor(role, opts)), 'utf8');

const BY_NAME = new Map();
for (const t of BOTH.concat(ORCHESTRATOR, WORKER, [KNOWLEDGE_TOOL, NOTES.NOTE_RESOLVE, NOTES.SUMMARIES, NOTES.NOTE_REFUTATION, NOTES.MEMORY_REPORT])) BY_NAME.set(t.name, t);
// `notes` (a notes run's worker adapter): lease_release is the schema that requires `notes`.
// and memory_store is the schema that states a note's fields (the orchestrator's namespace text differs from a worker's).
const schemaOf = (name, notes = false, role = 'worker') => {
  if (notes && name === 'lease_release') return NOTES.LEASE_RELEASE.inputSchema;
  if (notes && name === 'memory_store') return NOTES.memoryStoreNotes(BY_NAME.get(name), role).inputSchema;
  return (BY_NAME.get(name) || {}).inputSchema;
};

// Optional arguments where an explicit null is refused, not read as absent: the core refuses it too
// (ADR 0010 amendment 3), and the boundary must say the same thing before the call reaches it.
const NO_NULL = { task_evaluate: ['base'] };

// ADR 0040 §4: harness fields on memory_store. They are provenance the run manager passes straight to
// the core, never something a model says (invariant 3), so the boundary refuses them in either role,
// by name, before the core sees them. The schema does not list them, which is why the listing does
// not pay for them either.
const HARNESS_ONLY = { memory_store: ['task_id', 'turn', 'source', 'embed', 'body', 'worker_id'], worker_spawn: ['native_memory', 'tools', 'sandbox', 'max_budget_usd'] }; // worker_spawn: native_memory is the eval driver's lever (ADR 0024 amendment 3); tools is the built-in list, which only allowed_tools may narrow (amendment 4); sandbox is a Codex worker's sandbox mode and max_budget_usd a job worker's spend cap, both the harness's. permission_prompt and permit_wait_ms stay open: ADR 0020 decision 1 makes the permission channel optional per spawn, and decision 5 has the orchestrator answer its requests
// Tools that take exactly the properties their schema names: memory_store's row is written from its arguments, so an
// unnamed one (an id, a created_at, a vector and its model) would reach the core as if the harness had chosen it.
const CLOSED = new Set(['memory_store']);
// ADR 0043 decision 1: the knowledge agent's id, knowledge-<run>, is the harness's. A worker the orchestrator named
// with that prefix would be taken for the agent (or block it), so a caller-chosen id with it is refused.
const RESERVED_WORKER_PREFIX = 'knowledge-';
const MAX_IDS = 50;

// The model is a boundary, so the required fields and the declared type of each named top-level
// property are checked here rather than left for the core to discover. Properties the schema does not
// name are passed through untouched: the core owns what it accepts, and this is not a JSON Schema
// implementation. Throws E_ARGS naming the field.
function validateArgs(name, args, { notes = false, role = 'worker' } = {}) {
  const schema = schemaOf(name, notes, role);
  if (!schema) return args;
  const a = args || {};
  const bad = (message, detail) => { throw Object.assign(new Error(message), { code: 'E_ARGS', detail }); };
  if (typeof a !== 'object' || Array.isArray(a)) bad(`${name} takes an object of arguments`, { tool: name });
  for (const k of HARNESS_ONLY[name] || []) {
    if (Object.prototype.hasOwnProperty.call(a, k)) bad(`${name}: ${k} is a harness field and cannot be set from a tool call`, { tool: name, field: k, reason: 'harness_only' });
  }
  if (CLOSED.has(name)) {
    const extra = Object.keys(a).find((k) => !Object.prototype.hasOwnProperty.call(schema.properties || {}, k));
    if (extra !== undefined) bad(`${name}: ${extra} is not one of its arguments`, { tool: name, field: extra, reason: 'unknown_field' });
  }
  // A worker id becomes a directory under the data dir: every tool that names one refuses a bad id before anything is read or written.
  for (const k of ['worker_id']) {
    if (a[k] !== undefined && a[k] !== null && (schema.properties || {})[k] && !isPathId(a[k])) bad(`${name}: ${pathIdMessage(k, a[k])}`, { tool: name, field: k, reason: 'bad_id' });
  }
  if (Array.isArray(a.worker_ids) && a.worker_ids.some((x) => !isPathId(x))) bad(`${name}: worker_ids has an id that is not valid: use ${require('../core/path-id.cjs').PATH_ID_GRAMMAR}`, { tool: name, field: 'worker_ids', reason: 'bad_id' });
  if (name === 'worker_spawn' && typeof a.worker_id === 'string' && (a.worker_id.startsWith(RESERVED_WORKER_PREFIX) || isJobId(a.worker_id))) {
    bad(`worker_spawn: worker ids starting ${RESERVED_WORKER_PREFIX}, notereview-, scrub- or archreview- are reserved for belay's own workers`, { tool: name, field: 'worker_id', reason: 'reserved', prefix: RESERVED_WORKER_PREFIX });
  }
  for (const k of schema.required || []) {
    if (a[k] === undefined || a[k] === null) bad(`${name} needs ${k}`, { tool: name, missing: k });
  }
  if (name === 'memory_retrieve') {
    const hasId = a.id !== undefined && a.id !== null;
    const hasIds = a.ids !== undefined && a.ids !== null;
    if (!hasId && !hasIds) bad('memory_retrieve needs id or ids', { tool: name, missing: 'id' });
    if (hasId && hasIds) bad('memory_retrieve takes id or ids, not both', { tool: name, field: 'ids' });
  }
  for (const [k, spec] of Object.entries(schema.properties || {})) {
    const v = a[k];
    if (v === null && (NO_NULL[name] || []).includes(k)) bad(`${name}: ${k} must be ${spec.type}, not null`, { tool: name, field: k, expected: spec.type });
    if (v === undefined || v === null) continue;
    const t = spec.type;
    const ok = t === 'string' ? typeof v === 'string'
      : t === 'integer' ? Number.isInteger(v)
        : t === 'number' ? typeof v === 'number'
          : t === 'boolean' ? typeof v === 'boolean'
            : t === 'array' ? Array.isArray(v)
              : t === 'object' ? (typeof v === 'object' && !Array.isArray(v))
                : true;
    if (!ok) bad(`${name}: ${k} must be ${t}`, { tool: name, field: k, expected: t });
    if (spec.enum && !spec.enum.includes(v)) bad(`${name}: ${k} must be one of ${spec.enum.join(', ')}`, { tool: name, field: k, expected: spec.enum });
  }
  if (name === 'memory_retrieve' && Array.isArray(a.ids)) {
    if (a.ids.length < 1 || a.ids.length > MAX_IDS) bad(`memory_retrieve: ids must hold 1 to ${MAX_IDS} ids, got ${a.ids.length}`, { tool: name, field: 'ids', max: MAX_IDS });
    const i = a.ids.findIndex((x) => typeof x !== 'string' || x === '');
    if (i >= 0) bad(`memory_retrieve: ids[${i}] must be a non-empty string`, { tool: name, field: 'ids', index: i });
  }
  return a;
}

module.exports = { toolsFor, roleOf, routeOf, allows, schemaOf, validateArgs, ROUTES, ROLES, BUDGET, listingBytes, PERMIT_TOOL, permitBytes, HARNESS_ONLY, KNOWLEDGE_TOOL, KNOWLEDGE_READ_TOOLS, RESERVED_WORKER_PREFIX };
