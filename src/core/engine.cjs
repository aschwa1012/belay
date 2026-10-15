'use strict';
// engine.cjs — one dispatch for every Core method (api.md §3). The same `handle(method, params)` serves
// the pipe and in-process calls, so nothing is reachable over one path and not the other.
//
// Authority (ADR 0010 §4) is decided here and only here, from `params.caller`: the role decides which
// methods exist, and `caller.worker_id` decides which lease a worker may touch. A `caller` field inside
// a method's own arguments is not authority — the in-process facade strips it and substitutes the
// identity `openCore` was given from argv, and over the pipe the client sets it from its own argv.
// Nothing a model says reaches this decision.

const { err } = require('./errors.cjs');
const { ROLES } = require('./schema.cjs');
const { pidAlive, readOwnerLock, pipeName } = require('./lock.cjs');
const memory = require('./methods-memory.cjs');
const run = require('./methods-run.cjs');
const task = require('./methods-task.cjs');
const continuity = require('./continuity.cjs');
const status = require('./status.cjs');
const diff = require('./methods-diff.cjs');
const permission = require('./methods-permission.cjs');
const search = require('./memory-search.cjs');
const memoryIndex = require('./memory-index.cjs');

// A method whose module is built apart: loaded on its first call, so this file does not need the module to
// load. A checkout without it refuses by name instead of throwing a bare require error.
function lazy(file, name) {
  return (E, caller, args) => {
    let mod;
    try { mod = require(file); }
    catch (e) {
      if (e && e.code === 'MODULE_NOT_FOUND' && String(e.message).includes(file.slice(2))) {
        throw err('E_INTERNAL', `${name} is not available: ${file} is missing from this build`, { file, method: name });
      }
      throw e;
    }
    return mod[name](E, caller, args);
  };
}

const ALL = ROLES;
const ORCH = ['orchestrator'];
// `belay run` (build step 5a) attaches and ends the run as role operator: it is the process that
// spawns the orchestrator and is therefore the store owner and control server for the run's
// lifetime (ADR 0009). Build step 6a widened this to
// task.assign too, named below; every other orchestrator-only method is unaffected.
const ORCH_OR_OPERATOR = ['orchestrator', 'operator'];

const METHODS = {
  'memory.store': { roles: ALL, kind: 'write', fn: memory.store },
  // ADR 0040 §2: the read methods live in memory-search.cjs (layered, filtered, hybrid, with the honesty contract).
  'memory.get': { roles: ALL, kind: 'read', fn: search.get },
  'memory.search': { roles: ALL, kind: 'read', fn: search.search },
  'memory.list': { roles: ALL, kind: 'read', fn: search.list },
  'memory.timeline': { roles: ALL, kind: 'read', fn: search.timeline },
  'memory.get_many': { roles: ALL, kind: 'read', fn: search.getMany },
  // ADR 0042 §2: the bounded first-message index; ADR 0043 §1: the knowledge agent's corpus (module built apart).
  'memory.index': { roles: ALL, kind: 'read', fn: memoryIndex.index },
  'memory.corpus': { roles: ALL, kind: 'read', fn: lazy('./memory-corpus.cjs', 'corpus') },
  'memory.setStatus': { roles: ORCH_OR_OPERATOR, kind: 'write', fn: lazy('./methods-memory-status.cjs', 'setStatus') },
  'memory.promote': { roles: ORCH_OR_OPERATOR, kind: 'write', fn: lazy('./methods-memory-promote.cjs', 'promote') },
  // ADR 0047 decision 4: settles the pending notes a hand-back returned; the writer's own, or the orchestrator's or operator's.
  'memory.noteResolve': { roles: ALL, kind: 'write', fn: lazy('./methods-memory-notes.cjs', 'resolve') },
  // ADR 0047 decision 1: run summaries found on demand; with the notes lever on they live in summary/<project>.
  'memory.summaries': { roles: ALL, kind: 'read', fn: lazy('./memory-summaries.cjs', 'summaries') },
  'memory.recordEvent': { roles: ORCH_OR_OPERATOR, kind: 'write', fn: lazy('./methods-ledger.cjs', 'recordEvent') },
  'memory.events': { roles: ALL, kind: 'read', fn: lazy('./methods-ledger.cjs', 'events') },
  'usage.record': { roles: ORCH_OR_OPERATOR, kind: 'write', fn: lazy('./methods-ledger.cjs', 'usageRecord') },
  'usage.list': { roles: ALL, kind: 'read', fn: lazy('./methods-ledger.cjs', 'usageList') },
  'memory.delete': { roles: ALL, kind: 'write', fn: memory.delete },
  'memory.stats': { roles: ALL, kind: 'read', fn: memory.stats },
  // build 12b E2: start the embedder child and its load ahead of first use (the run's warm-up), so the
  // fork stall and the cold load happen before agents talk to the owner. kind 'write' so it reaches the owner.
  'memory.warm': { roles: ALL, kind: 'write', fn: memory.warm },
  // The first-message index's query vector, made by the owner's embedder (the path memory.search uses). kind 'write' only so the call
  // reaches the owner, as memory.warm does; it writes nothing. Harness channel only (the run manager).
  'memory.embedQuery': { roles: ORCH_OR_OPERATOR, kind: 'write', fn: lazy('./methods-embed-query.cjs', 'embedQuery') },

  'status.get': { roles: ALL, kind: 'read', fn: status.get },

  'run.attach': { roles: ORCH_OR_OPERATOR, kind: 'write', fn: run.attach },
  'run.end': { roles: ORCH_OR_OPERATOR, kind: 'write', fn: run.end },
  // build step 6f, ADR 0023 amendment 3 decision 4.1: open to orchestrator and operator, same as
  // run.attach/run.end above — the run process itself writes it (role operator, belay run's own
  // identity), and it is read back through the ordinary run row.
  'run.setPaused': { roles: ORCH_OR_OPERATOR, kind: 'write', fn: run.setPaused },
  'run.get': { roles: ALL, kind: 'read', fn: run.getRun },
  // build step 4a: every run's current row, so a CLI with no run id argument (belay status,
  // belay workers) has a way to find the current run at all.
  'run.list': { roles: ALL, kind: 'read', fn: run.listRuns },

  'worker.write': { roles: ORCH, kind: 'write', fn: run.writeWorker },
  'worker.get': { roles: ALL, kind: 'read', fn: run.getWorker },
  'worker.list': { roles: ALL, kind: 'read', fn: run.listWorkers },
  // build step 6b, ADR 0019 decision 6: operator only, the CLI's `worker rm` (mode W); no MCP tool.
  'worker.forget': { roles: ['operator'], kind: 'write', fn: run.forgetWorker },

  'task.create': { roles: ORCH, kind: 'write', fn: task.create },
  // build step 6a, ADR 0010 §4 amendment 1: opened to the operator as well (see the comment above
  // ORCH_OR_OPERATOR); the MCP adapter's task_assign tool stays orchestrator-only.
  'task.assign': { roles: ORCH_OR_OPERATOR, kind: 'write', fn: task.assign },
  'task.list': { roles: ALL, kind: 'read', fn: task.list },
  'task.get': { roles: ALL, kind: 'read', fn: task.get },
  'task.evaluate': { roles: ORCH, kind: 'write', fn: task.evaluate },

  'lease.renew': { roles: ['worker'], kind: 'write', fn: task.renew },
  'lease.release': { roles: ['worker', 'operator'], kind: 'write', fn: task.release },
  'lease.takeControl': { roles: ['operator'], kind: 'write', fn: task.takeControl },

  'continuity.checkpoint': { roles: ['worker', 'orchestrator'], kind: 'write', fn: continuity.checkpoint },
  'continuity.lastCheckpoint': { roles: ALL, kind: 'read', fn: continuity.lastCheckpoint },
  'continuity.resumeLine': { roles: ALL, kind: 'read', fn: continuity.resumeLine },
  'continuity.resumeDoc': { roles: ALL, kind: 'read', fn: continuity.resumeDoc },

  // build step 4c: rows added, updated, superseded or expired since a mark the caller supplies
  //. A read: no election, no write.
  'store.diff': { roles: ALL, kind: 'read', fn: diff.diff },

  // build step 6d, ADR 0020 decision 2: the permission channel. `wait` is a third kind — dispatched
  // through the write path (index.cjs, since only kind 'read' takes the read path), so a worker with
  // no owner lands E_NO_OWNER having created nothing, and excluded from READ_METHODS/WRITE_METHODS
  // below so the client's "may have committed" write-timeout advice never fires for it.
  'permission.request': { roles: ['worker'], kind: 'write', fn: permission.request },
  'permission.list': { roles: ALL, kind: 'read', fn: permission.list },
  'permission.decide': { roles: ['operator', 'orchestrator', 'worker'], kind: 'write', fn: permission.decide },
  'permission.wait': { roles: ['worker'], kind: 'wait', fn: permission.wait },
};

// The methods that read or write memory rows and are refused when the run's memory is off.
const MEMORY_OFF_REFUSED = new Set(['memory.store', 'memory.delete', 'memory.search', 'memory.get', 'memory.list', 'memory.timeline', 'memory.get_many', 'memory.setStatus', 'memory.promote', 'memory.noteResolve', 'memory.corpus', 'memory.summaries']);

const METHOD_NAMES = Object.keys(METHODS);
const READ_METHODS = new Set(METHOD_NAMES.filter(m => METHODS[m].kind === 'read'));
const WRITE_METHODS = new Set(METHOD_NAMES.filter(m => METHODS[m].kind === 'write'));

function validateCaller(caller) {
  if (!caller || typeof caller !== 'object') throw err('E_ARGS', 'every call needs a caller identity taken from the process arguments');
  if (!ROLES.includes(caller.role)) throw err('E_ARGS', `caller.role must be one of ${ROLES.join(', ')}, and this call carried ${JSON.stringify(caller.role)}`);
  if (typeof caller.run_id !== 'string' || !caller.run_id) throw err('E_ARGS', 'caller.run_id must be the run id this process was launched with');
  if (caller.role === 'worker' && (typeof caller.worker_id !== 'string' || !caller.worker_id)) {
    throw err('E_ARGS', 'a worker-role caller must carry the worker_id it was launched with, because a worker cannot name itself');
  }
  if (caller.channel !== undefined && caller.channel !== 'tool' && caller.channel !== 'harness') {
    throw err('E_ARGS', `caller.channel must be tool or harness, and this call carried ${JSON.stringify(caller.channel)}`);
  }
  if (caller.channel === 'harness' && caller.role !== 'orchestrator' && caller.role !== 'operator') {
    throw err('E_ARGS', 'the harness channel belongs to belay run: the run manager (the orchestrator adapter) and the run-end jobs (the run process)', { role: caller.role });
  }
  return caller;
}

class Engine {
  // `owner` is set only when this engine belongs to the process that holds the lock; `establishedBy`
  // says how the rows behind a read were obtained ('owner', 'copy' or 'none').
  constructor({ dataDir, store, getEmbedder = null, owner = null, establishedBy = 'copy', embedderFailure = null, memoryOffFn = null }) {
    this.dataDir = dataDir;
    this.store = store;
    // A provider, not a loaded model: the embedding library is reached only by a call that needs a
    // vector, and an engine reading a copy of the store has no way to get one at all.
    this._getEmbedder = getEmbedder;
    this.owner = owner;
    // The run's memory-off test for an engine with no owner (a copy-fallback read in the run process; ADR 0034 amendment 1).
    this._memoryOffFn = memoryOffFn;
    this.establishedBy = establishedBy;
    // Why the owner could not be asked for a vector on this read ({ code, message }): set by a copy read that fell
    // back from a wedged or still-loading owner, so a hybrid search reports that cause and not "no embedder".
    this.embedderFailure = embedderFailure;
    // build step 6d: in-process waiters for `permission.wait`, keyed by permission id — meaningful only
    // on the live owner's engine; a copy's engine has an empty map and nothing to resolve.
    this.waiters = new Map();
  }

  // ADR 0034 amendment 1: under on_embedder_failure `off`, once an embedder failure has turned the run's memory off (the owner's
  // `memoryOff()`, set by belay run), the memory methods that read or write rows refuse, and memory.index answers an empty block.
  // The run's own receipts (memory.recordEvent, memory.events) and the ordinary run, task and worker methods are not memory.
  memoryOff(method) {
    const o = this.owner && this.owner.opts;
    const test = o && typeof o.memoryOff === 'function' ? o.memoryOff : this._memoryOffFn;
    if (typeof test !== 'function' || !test()) return null;
    if (method === 'memory.index') return 'empty';
    return MEMORY_OFF_REFUSED.has(method) ? 'refuse' : null;
  }

  // The run's on_embedder_failure mode as the owner's guard has it now, canonical; the default when none is set.
  embedderMode() {
    const o = this.owner && this.owner.opts;
    const raw = o && typeof o.embedderMode === 'function' ? o.embedderMode() : null;
    return raw === 'continue' ? 'keyword' : (raw === 'stop' || !raw) ? 'required' : raw; // the module that owns the mode names stay out of the read path's imports
  }

  addWaiter(id, resolve) {
    if (!this.waiters.has(id)) this.waiters.set(id, new Set());
    this.waiters.get(id).add(resolve);
  }

  removeWaiter(id, resolve) {
    const set = this.waiters.get(id);
    if (!set) return;
    set.delete(resolve);
    if (!set.size) this.waiters.delete(id);
  }

  // Called by permission.decide once its transaction has committed: every waiter registered for this
  // id is woken with the verdict row it just wrote, and the id's entry is cleared.
  resolveWaiters(id, row) {
    const set = this.waiters.get(id);
    if (!set) return;
    this.waiters.delete(id);
    for (const resolve of set) resolve(row);
  }

  // Owner.stop() calls this right after its in-flight-controls wait and before timers are cleared, so
  // no permission.wait outlives the owner: every waiter, for every id, is resolved with a settle
  // marker rather than left to hang past the process that alone could ever answer it.
  settleWaiters() {
    for (const [id, set] of this.waiters) {
      for (const resolve of set) resolve(null);
    }
    this.waiters.clear();
  }

  getEmbedder() {
    if (!this._getEmbedder && this.embedderFailure) {
      return Promise.reject(err(this.embedderFailure.code, `the owner could not be asked for a vector: ${this.embedderFailure.message}`));
    }
    if (!this._getEmbedder) {
      return Promise.reject(err('E_NO_EMBEDDER', 'no owner answered, so this read fell back to a copy of the store and has no embedder; supply a vector with the call'));
    }
    return this._getEmbedder();
  }

  // The identity every written row carries: a worker writes under its worker id, anyone else under its
  // role. api.md §3, memory defaults.
  writtenBy(caller) { return caller.role === 'worker' ? caller.worker_id : caller.role; }

  // ADR 0044 decision 6: the writer a memory row records. The channel is set by the process that built the caller,
  // never by an argument: the run manager's frozen harness caller is `harness`; a tool call is the model's role.
  memoryWriter(caller) {
    if (caller.channel === 'harness') return 'harness';
    return caller.role === 'worker' ? `worker:${caller.worker_id}` : caller.role;
  }

  noteWrite() { if (this.owner && this.owner.noteWrite) this.owner.noteWrite(); }

  ownerFact() {
    if (this.owner) return { pid: process.pid, pipe: this.owner.pipe, alive: true, established_by: 'this process holds the lock (in-process)' };
    const lock = readOwnerLock(this.dataDir);
    if (!lock) return { pid: null, pipe: pipeName(this.dataDir), alive: false, established_by: 'no owner.lock in the data dir' };
    return { pid: lock.pid, pipe: lock.pipe || pipeName(this.dataDir), alive: pidAlive(lock.pid), established_by: 'owner.lock pid check' };
  }

  async handle(method, params) {
    const spec = METHODS[method];
    if (!spec) throw err('E_ARGS', `${method} is not a Core API method`, { method });
    const p = params || {};
    const caller = validateCaller(p.caller);
    if (!spec.roles.includes(caller.role)) {
      throw err('E_ROLE', `${method} is available to ${spec.roles.join(', ')} and this call came from role ${caller.role}`, { method, role: caller.role, allowed: spec.roles });
    }
    const args = { ...p };
    delete args.caller;
    const off = this.memoryOff(method);
    if (off === 'refuse') throw err('E_LEVER_OFF', `${method}: memory is off for this run (on_embedder_failure off, after an embedder failure), so nothing is read or written through it`, { lever: 'on_embedder_failure' });
    if (off === 'empty') return { text: '', bytes: 0, row_ids: [], dropped: 0, over_budget: false, sha256: require('node:crypto').createHash('sha256').update('', 'utf8').digest('hex'), considered: 0, excluded_already_injected: 0, memory_off: true };
    return spec.fn(this, caller, args);
  }
}

module.exports = { Engine, METHODS, METHOD_NAMES, READ_METHODS, WRITE_METHODS, validateCaller };
