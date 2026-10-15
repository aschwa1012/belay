'use strict';
// methods-memory.cjs — the memory write, delete, stats and warm methods (api.md §3, ADR 0002 §4, ADR 0003); the
// read methods live in memory-search.cjs. Identity on a written row comes from `caller` and nothing
// else: a worker writes under its worker id, anyone else under its role. `namespace` defaults to
// `run/<run_id>`, and the alias `project` resolves through the run row (below).

const { err } = require('./errors.cjs');
const rows = require('./rows.cjs');
const { SOURCES, TYPE_RE, validId } = require('./memory-rows.cjs');
const { redact, redactDeep } = require('./redact.cjs');

// ADR 0041 §5 and ADR 0040 §2: the project alias and a caller's reach live in memory-reach.cjs, a read module.
const { projectOf, resolveNamespace, reachOf, checkReach } = require('./memory-reach.cjs');

const nsFor = (E, caller, args) => resolveNamespace(E, caller, args.namespace) || `run/${caller.run_id}`;

// ADR 0034 decision 2: an error out of the embedder phase goes to the owner's onEmbedderFailure hook (set by
// `belay run`, which decides by detail.embedder === true whether it is an embedder failure), then is rethrown.
function notifyEmbedderFailure(E, caller, call, error, workerId) {
  const h = E.owner && E.owner.opts && E.owner.opts.onEmbedderFailure;
  if (typeof h !== 'function') return;
  try { Promise.resolve(h({ caller, by: E.writtenBy(caller), call, error, ...(workerId ? { worker_id: workerId } : {}) })).catch(() => {}); } catch { /* the hook is the run's, never the caller's */ }
}

// `call` names the Core call for the hook (default: memory.store or memory.search by the field); `workerId` is the worker the
// call is for when the caller is the run manager, which holds no worker identity of its own.
async function withEmbedding(E, args, field, textField, caller, call, workerId) {
  if (args[field]) return args;
  try {
    // Loads on first use, and raises E_NO_EMBEDDER, E_MODEL_ABSENT or E_MODEL_CHANGED as the case may be.
    // Only a call that needs a vector can fail this way; nothing else in the Core touches the model.
    const embedder = await E.getEmbedder();
    const e = await embedder.embed(args[textField], { as: field === 'embedding' ? 'document' : 'query' });
    return field === 'embedding'
      ? { ...args, embedding: e.embedding, embedding_model: e.embedding_model, embedding_revision: e.embedding_revision, dim: e.dim }
      : { ...args, query_embedding: e.embedding, embedding_model: e.embedding_model };
  } catch (e) {
    notifyEmbedderFailure(E, caller, call || (field === 'embedding' ? 'memory.store' : 'memory.search'), e, workerId);
    // Under `required` in a run (an owner with a guard) this failure pauses the run: the caller is told what to do next.
    if (e && e.detail && e.detail.embedder === true && E.owner && E.owner.opts && typeof E.owner.opts.embedderMode === 'function' && E.embedderMode() === 'required' && !String(e.message).includes('belay resume')) {
      e.message = `${e.message} ${require('./embedder-mode.cjs').pauseAdvice(caller && caller.run_id)}`;
    }
    throw e;
  }
}

const TITLE_MAX = 160;
const BODY_MAX = 8192;
// Fields only the core sets (ADR 0040 §2): the run comes from argv, status from memory.setStatus.
const CORE_SET = ['run_id', 'status', 'status_receipt', 'status_by', 'status_at', 'redactions', 'text_hash', 'last_writer_id', 'written_by'];
// Harness provenance: the orchestrator and the operator may pass these; from a worker they are refused (invariant 3).
// `worker_id` names the worker a harness-written row is about (its observation, summary or turn row): the run
// manager writes those rows as the orchestrator, and without it every one of them read as the orchestrator's.
// A model never reaches it: the MCP boundary refuses it on memory_store in either role (tools.cjs HARNESS_ONLY).
const HARNESS_FIELDS = ['task_id', 'turn', 'source', 'worker_id'];
// What a caller may pass at all; anything else is refused by name rather than spread into the row. A row id, a
// creation time and a vector are the harness's to choose: from a worker they would let a model pick a line of the
// index, sit at the top of recency forever, or bind a fresh namespace to a model and dimension no real write matches.
const CALLER_FIELDS = ['text', 'namespace', 'type', 'tags', 'provenance', 'supersedes', 'title', 'ttl_seconds', 'body', 'embed'];
const HARNESS_STORE_FIELDS = ['id', 'created_at', 'embedding', 'embedding_model', 'embedding_revision', 'dim'];
const NOTE_BODY_KEYS = ['model', 'state', 'seen_in', 'seen_total', 'matches', 'reported_wrong', 'resolved', 'superseded_by'];
const TAGS_MAX = 32, TAG_MAX = 200, PROVENANCE_MAX = 512;
// A worker's own rows in one run namespace: a model in a loop cannot fill the store.
const WORKER_ROWS_MAX = 2000;

// The run's `memory.redact` lever, read from the run row of the caller's run (run.attach recorded it). Redaction
// is on unless that row says `redact: false`; no row, no lever and an unreadable lever all mean on, because a
// write is never allowed to skip the scrub for want of knowing (ADR 0040 §3).
function leversOf(E, caller) {
  let raw = null;
  try { const run = rows.current(E.store, 'run', caller && caller.run_id); raw = run ? run.memory_levers : null; } catch { return undefined; }
  if (raw == null) return null;
  try { const o = typeof raw === 'string' ? JSON.parse(raw) : raw; return o && typeof o === 'object' ? o : null; } catch { return undefined; }
}
function redactOn(E, caller) {
  const o = leversOf(E, caller);
  return !(o && o.redact === false);
}

// The run's `memory.alpha` lever for a search that gave no alpha (ADR 0040 §4); null when the run has none or the
// value is not a valid weight, so the caller falls back to the built-in default. A read: nothing is written.
function runAlpha(E, caller) {
  const o = leversOf(E, caller);
  return o && typeof o.alpha === 'number' && o.alpha >= 0 && o.alpha <= 1 ? o.alpha : null;
}

// A worker's task is the one lease it holds right now, else none. Derived from the store, never from the call.
function derivedTask(E, caller) {
  const held = rows.leasesHeldBy(E.store, caller.worker_id);
  return held.length === 1 ? held[0].task_id : null;
}

const bad = (message, field, more) => err('E_ARGS', `memory.store: ${message}`, { field, ...more });

function checkWrite(caller, args) {
  for (const k of CORE_SET) if (args[k] !== undefined) throw bad(`${k} is set by the core and cannot be passed`, k);
  if (caller.role === 'worker') {
    for (const k of HARNESS_FIELDS.concat(HARNESS_STORE_FIELDS)) if (args[k] !== undefined) throw bad(`${k} is a harness field and a worker cannot set it`, k, { role: caller.role });
  }
  for (const k of Object.keys(args)) {
    if (!CALLER_FIELDS.includes(k) && !HARNESS_FIELDS.includes(k) && !HARNESS_STORE_FIELDS.includes(k)) throw bad(`${k} is not a memory.store field`, k);
  }
  if (args.namespace != null && (typeof args.namespace !== 'string' || !args.namespace)) throw bad('namespace must be a non-empty string', 'namespace');
  if (args.id != null && !validId(args.id)) throw bad('id must be 1 to 128 letters, digits, dot, colon, dash or underscore, starting with a letter or digit', 'id');
  if (args.type != null && (typeof args.type !== 'string' || !TYPE_RE.test(args.type))) throw bad('type must be 1 to 32 lower-case letters, digits, dash or underscore, starting with a letter', 'type');
  // ADR 0047: a note is written by the hand-back only. Its type and the fields belay keeps on it are never a caller's.
  if (args.type === 'note') throw bad('type note is reserved for the notes path (the notes of lease_release), so memory.store cannot write one', 'type');
  if (args.body != null && typeof args.body === 'object' && !Array.isArray(args.body)) {
    for (const k of NOTE_BODY_KEYS) if (Object.prototype.hasOwnProperty.call(args.body, k)) throw bad(`body.${k} is a field belay keeps on a note and no caller may set it`, 'body');
  }
  if (args.supersedes != null && !validId(args.supersedes)) throw bad('supersedes must be a row id', 'supersedes');
  if (args.created_at != null && !(Number.isSafeInteger(args.created_at) && args.created_at >= 0 && args.created_at <= Date.now() + 60000)) throw bad('created_at must be epoch milliseconds, not in the future', 'created_at');
  if (args.tags != null && (!Array.isArray(args.tags) || args.tags.length > TAGS_MAX || args.tags.some(t => typeof t !== 'string' || Buffer.byteLength(t) > TAG_MAX))) {
    throw bad(`tags must be an array of at most ${TAGS_MAX} strings of at most ${TAG_MAX} bytes each`, 'tags', { max: TAGS_MAX, each_max: TAG_MAX });
  }
  if (args.provenance != null && (typeof args.provenance !== 'string' || Buffer.byteLength(args.provenance) > PROVENANCE_MAX)) throw bad(`provenance must be a string of at most ${PROVENANCE_MAX} bytes`, 'provenance', { max: PROVENANCE_MAX });
  if (args.task_id != null && (typeof args.task_id !== 'string' || !args.task_id)) throw bad('task_id must be a non-empty string', 'task_id');
  if (args.worker_id != null && (typeof args.worker_id !== 'string' || !args.worker_id)) throw bad('worker_id must be a non-empty string', 'worker_id');
  if (args.turn != null && !(Number.isSafeInteger(args.turn) && args.turn >= 0)) throw bad('turn must be a non-negative integer', 'turn');
  if (args.source !== undefined && !SOURCES.includes(args.source)) throw bad(`source must be one of ${SOURCES.join(', ')}`, 'source');
  if (args.title != null && typeof args.title !== 'string') throw bad('title must be a string', 'title');
  if (args.body != null && (typeof args.body !== 'object' || Array.isArray(args.body))) throw bad('body must be an object', 'body');
  if (args.embed !== undefined && typeof args.embed !== 'boolean') throw bad('embed must be true or false', 'embed');
  if (args.embed === false && (args.embedding || args.embedding_b64)) throw bad('embed: false and an embedding contradict each other', 'embed');
}

// text, title and body are scrubbed before they are hashed or embedded, so the same fact written with and without
// its secret is one row, and a re-run after a lost owner (ADR 0033) hashes the same bytes. With the lever off
// nothing is touched and the row says so.
function scrub(on, args) {
  if (!on) return { text: args.text, title: args.title ?? null, body: args.body ?? null, tags: args.tags, provenance: args.provenance, redactions: { disabled: 1 } };
  const counts = {};
  const add = r => { for (const [k, n] of Object.entries(r)) counts[k] = (counts[k] || 0) + n; };
  const t = redact(args.text); add(t.redactions);
  let title = null, body = null;
  if (args.title != null) { const r = redact(args.title); add(r.redactions); title = r.text; }
  if (args.body != null) { const r = redactDeep(args.body); add(r.redactions); body = r.value; }
  let tags = args.tags, provenance = args.provenance;
  if (Array.isArray(tags)) { const r = redactDeep(tags); add(r.redactions); tags = r.value; }
  if (typeof provenance === 'string') { const r = redact(provenance); add(r.redactions); provenance = r.text; }
  if (!t.text.trim()) throw bad('the text is empty after redaction', 'text', { reason: 'empty after redaction', redactions: counts });
  return { text: t.text, title, body, tags, provenance, redactions: Object.keys(counts).length ? counts : null };
}

// A worker may supersede (hide) only a row it could also delete: its own unverified row in its own run namespace.
// A project row or a verified one is the orchestrator's or the operator's to replace (ADR 0040 §2, worker scope).
function checkOwnRow(E, caller, id, verb) {
  if (caller.role !== 'worker') return;
  const r = E.store.p('SELECT id, namespace, worker_id, status, source FROM memory_entries WHERE id = ?').get(id);
  if (!r) return; // absent: the store's own check names it (E_SUPERSEDES), and a delete reports deleted false
  const own = r.worker_id === caller.worker_id && r.namespace === `run/${caller.run_id}` && (r.status || 'unverified') === 'unverified' && (r.source || 'model') === 'model';
  if (!own) throw err('E_ROLE', `a worker may ${verb} only its own unverified rows in its own run namespace; row ${id} is not one`, { id, role: caller.role });
}

async function store(E, caller, args) {
  if (typeof args.text !== 'string' || !args.text.trim()) throw err('E_ARGS', 'memory.store needs non-empty text');
  checkWrite(caller, args);
  const namespace = nsFor(E, caller, args);
  checkReach(E, caller, [namespace], 'write to');
  if (args.supersedes != null) checkOwnRow(E, caller, args.supersedes, 'supersede');
  if (caller.role === 'worker') {
    const n = E.store.p('SELECT COUNT(*) AS n FROM memory_entries WHERE namespace = ? AND worker_id = ?').get(namespace, caller.worker_id).n;
    if (n >= WORKER_ROWS_MAX) throw bad(`this worker already holds ${n} rows in ${namespace}, the most one worker may write`, 'text', { reason: 'quota', max: WORKER_ROWS_MAX });
  }
  // A project namespace outlives the run and every later run reads it, so a write into it is always scrubbed,
  // whatever the run's redact lever says (ADR 0040 §3).
  const s = scrub(redactOn(E, caller) || namespace.startsWith('project/') || namespace.startsWith('summary/'), args);
  // One line of at most 160 bytes: control characters become spaces, whitespace runs collapse, and the bound is on
  // what is stored (after redaction). A title is rendered in the index, so it carries no escape sequence.
  const title = s.title === null ? null : (s.title.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim() || null);
  if (title !== null && Buffer.byteLength(title) > TITLE_MAX) throw bad(`title is over ${TITLE_MAX} bytes`, 'title', { bytes: Buffer.byteLength(title), max: TITLE_MAX });
  if (s.body !== null && Buffer.byteLength(JSON.stringify(s.body)) > BODY_MAX) throw bad(`body is over ${BODY_MAX} bytes once serialised`, 'body', { max: BODY_MAX });
  const { embed, task_id, turn, source, worker_id: harnessWorker, title: _title, body: _body, text: _text, ...rest } = args;
  const worker = caller.role === 'worker';
  const base = {
    ...rest, tags: s.tags, provenance: s.provenance, namespace, worker_id: (!worker && harnessWorker) || E.writtenBy(caller), text: s.text, title, body: s.body, redactions: s.redactions, written_by: E.memoryWriter(caller),
    run_id: caller.run_id, task_id: worker ? derivedTask(E, caller) : (task_id ?? null), turn: worker ? null : (turn ?? null),
    source: source || (caller.role === 'operator' ? 'operator' : 'model'),
  };
  const a = embed === false ? base : await withEmbedding(E, base, 'embedding', 'text', caller);
  const row = E.store.store(a);
  E.noteWrite();
  return row;
}

async function del(E, caller, args) {
  if (!args.id) throw err('E_ARGS', 'memory.delete needs an id');
  if (!validId(args.id)) throw err('E_ARGS', 'memory.delete id must be a row id', { field: 'id' });
  checkOwnRow(E, caller, args.id, 'delete');
  const r = E.store.delete(args.id);
  E.noteWrite();
  return r;
}

async function stats(E, caller) {
  const owner = E.ownerFact();
  // Say plainly whether this store can embed and why not when it cannot. Without it a caller meeting
  // E_MODEL_ABSENT on a write has no way to find out the state of the model.
  if (E.owner) {
    owner.embedder = E.owner.embedInfo || null;
    owner.embedder_error = E.owner.embedError || null;
  }
  return { ...E.store.stats(), owner };
}

// build 12b E2. Starts the load (or finds it started) and answers at once with the owner's own state;
// { reload: true } (alias retry) first clears a failed embedder (owner.resetEmbedder) and loads afresh; { wait: true } waits for the load (bounded by the caller's vector-call limit) and rejects with the
// embedder failure signature when it failed. A failed load is sticky for this owner, so every warm after
// it reports the same cause.
async function warm(E, caller, args = {}) {
  const o = E.owner;
  if ((args.reload || args.retry) && o && o.resetEmbedder) await o.resetEmbedder();
  const p = E.getEmbedder();
  if (args.wait) await p; else p.catch(() => { /* reported by state and error below */ });
  const state = o && o.embedState ? o.embedState() : 'unknown';
  return { state, pid: o && o.embedInfo ? o.embedInfo.pid : null, error: o && o.embedError ? o.embedError : null };
}

module.exports = { leversOf, runAlpha, store, delete: del, stats, warm, nsFor, resolveNamespace, projectOf, withEmbedding, notifyEmbedderFailure, reachOf, checkReach, scrub };
