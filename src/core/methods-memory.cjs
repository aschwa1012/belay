'use strict';
// methods-memory.cjs — the six memory methods (api.md §3, ADR 0002 §4, ADR 0003). Identity on a written
// row comes from `caller` and nothing else: a worker writes under its worker id, anyone else under its
// role. `namespace` defaults to `run/<run_id>`.

const { err } = require('./errors.cjs');
const rows = require('./rows.cjs');
const { SOURCES } = require('./memory-rows.cjs');
const { redact, redactDeep } = require('./redact.cjs');

const nsFor = (caller, args) => args.namespace || `run/${caller.run_id}`;

// ADR 0034 decision 2: an error out of the embedder phase goes to the owner's onEmbedderFailure hook (set by
// `belay run`, which decides by detail.embedder === true whether it is an embedder failure), then is rethrown.
function notifyEmbedderFailure(E, caller, call, error) {
  const h = E.owner && E.owner.opts && E.owner.opts.onEmbedderFailure;
  if (typeof h !== 'function') return;
  try { Promise.resolve(h({ caller, by: E.writtenBy(caller), call, error })).catch(() => {}); } catch { /* the hook is the run's, never the caller's */ }
}

async function withEmbedding(E, args, field, textField, caller) {
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
    notifyEmbedderFailure(E, caller, field === 'embedding' ? 'memory.store' : 'memory.search', e);
    throw e;
  }
}

const TITLE_MAX = 160;
const BODY_MAX = 8192;
// Fields only the core sets (ADR 0040 §2): the run comes from argv, status from memory.setStatus.
const CORE_SET = ['run_id', 'status', 'status_receipt', 'status_by', 'status_at', 'redactions', 'text_hash', 'last_writer_id'];
// Harness provenance: the orchestrator and the operator may pass these; from a worker they are refused (invariant 3).
const HARNESS_FIELDS = ['task_id', 'turn', 'source'];

// The run's `memory.redact` lever, read from the run row of the caller's run (run.attach recorded it). Redaction
// is on unless that row says `redact: false`; no row, no lever and an unreadable lever all mean on, because a
// write is never allowed to skip the scrub for want of knowing (ADR 0040 §3).
function redactOn(E, caller) {
  let raw = null;
  try { const run = rows.current(E.store, 'run', caller.run_id); raw = run ? run.memory_levers : null; } catch { return true; }
  if (raw == null) return true;
  try { const o = typeof raw === 'string' ? JSON.parse(raw) : raw; return !(o && o.redact === false); } catch { return true; }
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
    for (const k of HARNESS_FIELDS) if (args[k] !== undefined) throw bad(`${k} is a harness field and a worker cannot set it`, k, { role: caller.role });
  }
  if (args.task_id != null && (typeof args.task_id !== 'string' || !args.task_id)) throw bad('task_id must be a non-empty string', 'task_id');
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
  if (!on) return { text: args.text, title: args.title ?? null, body: args.body ?? null, redactions: { disabled: 1 } };
  const counts = {};
  const add = r => { for (const [k, n] of Object.entries(r)) counts[k] = (counts[k] || 0) + n; };
  const t = redact(args.text); add(t.redactions);
  let title = null, body = null;
  if (args.title != null) { const r = redact(args.title); add(r.redactions); title = r.text; }
  if (args.body != null) { const r = redactDeep(args.body); add(r.redactions); body = r.value; }
  if (!t.text.trim()) throw bad('the text is empty after redaction', 'text', { reason: 'empty after redaction', redactions: counts });
  return { text: t.text, title, body, redactions: Object.keys(counts).length ? counts : null };
}

async function store(E, caller, args) {
  if (typeof args.text !== 'string' || !args.text.trim()) throw err('E_ARGS', 'memory.store needs non-empty text');
  checkWrite(caller, args);
  const s = scrub(redactOn(E, caller), args);
  // One line of at most 160 bytes: whitespace runs collapse, and the bound is on what is stored (after redaction).
  const title = s.title === null ? null : (s.title.replace(/\s+/g, ' ').trim() || null);
  if (title !== null && Buffer.byteLength(title) > TITLE_MAX) throw bad(`title is over ${TITLE_MAX} bytes`, 'title', { bytes: Buffer.byteLength(title), max: TITLE_MAX });
  if (s.body !== null && Buffer.byteLength(JSON.stringify(s.body)) > BODY_MAX) throw bad(`body is over ${BODY_MAX} bytes once serialised`, 'body', { max: BODY_MAX });
  const { embed, task_id, turn, source, title: _title, body: _body, text: _text, ...rest } = args;
  const worker = caller.role === 'worker';
  const base = {
    ...rest, namespace: nsFor(caller, args), worker_id: E.writtenBy(caller), text: s.text, title, body: s.body, redactions: s.redactions,
    run_id: caller.run_id, task_id: worker ? derivedTask(E, caller) : (task_id ?? null), turn: worker ? null : (turn ?? null),
    source: source || (caller.role === 'operator' ? 'operator' : 'model'),
  };
  const a = embed === false ? base : await withEmbedding(E, base, 'embedding', 'text', caller);
  const row = E.store.store(a);
  E.noteWrite();
  return row;
}

async function get(E, caller, args) {
  if (!args.id) throw err('E_ARGS', 'memory.get needs an id');
  // memory.get is a read method (engine.cjs), and invariant 6 says reading never writes: without the
  // false here, retrieve() stamps accessed_at on the live store, moving memory.db's mtime and leaving
  // the owner's idle-TRUNCATE flag set so the checkpoint never re-runs.
  const row = E.store.retrieve(args.id, false);
  return row ? { ...row, found: true } : { id: args.id, found: false };
}

async function search(E, caller, args) {
  if (!args.query_embedding && typeof args.query !== 'string') {
    throw err('E_ARGS', 'memory.search needs a query string or a query_embedding');
  }
  const a = await withEmbedding(E, { ...args, namespace: nsFor(caller, args) }, 'query_embedding', 'query', caller);
  return E.store.search(a);
}

async function list(E, caller, args) {
  return { rows: E.store.list({ ...args, namespace: nsFor(caller, args) }) };
}

async function del(E, caller, args) {
  if (!args.id) throw err('E_ARGS', 'memory.delete needs an id');
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

module.exports = { store, get, search, list, delete: del, stats, warm, nsFor };
