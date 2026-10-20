'use strict';
// owner.cjs — the one process that holds a connection to a database file (ADR 0002 §1). Lifted from
// prototypes/memstore/owner.cjs: mkdir lock with the owner's pid, NDJSON over a named pipe, heartbeat
// row, TTL sweep, passive checkpoints with a TRUNCATE once idle, canary-checked embedder, and the
// base64-float32 wire encoding for vectors.
//
// Changed on lift: the pipe carries the `belay-` prefix; every Core method reaches the same
// Engine.handle the in-process facade uses, so nothing is served over one path and not the other; the
// pipe `shutdown` stops serving without calling process.exit, because this owner usually lives inside
// a long-running orchestrator adapter that must survive its own store owner being retired.

const net = require('node:net');
const path = require('node:path');
const { Store } = require('./store.cjs');
const { Engine } = require('./engine.cjs');
const { BindRegistry } = require('./bind.cjs');
const OperatorCheck = require('./operator-check.cjs');
const { err } = require('./errors.cjs');
const lockApi = require('./lock.cjs'); // markListening is called through it, so a test can make it fail
const { pipeName, acquireLock, releaseLock, resolveDataDir } = lockApi;

const RETIRE_POLL_MS = 500; // a retired owner re-checks its clients' pids this often
const UNIDENTIFIED_GRACE_MS = 5000; // a connection that has sent nothing counts as attached for this long
const MAX_LINE_BYTES = 1024 * 1024; // a peer that never sends a newline must not grow this buffer forever

function floatsFromB64(b64) {
  const buf = Buffer.from(b64, 'base64');
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength >> 2));
}

function decodeWire(p) {
  if (!p) return p;
  let out = p;
  if (typeof out.embedding_b64 === 'string') { out = { ...out, embedding: floatsFromB64(out.embedding_b64) }; delete out.embedding_b64; }
  if (typeof out.query_embedding_b64 === 'string') { out = { ...out, query_embedding: floatsFromB64(out.query_embedding_b64) }; delete out.query_embedding_b64; }
  if (Array.isArray(out.query_embeddings)) out = { ...out, query_embeddings: out.query_embeddings.map((q) => (q && typeof q.vector_b64 === 'string' ? { ...q, vector: floatsFromB64(q.vector_b64), vector_b64: undefined } : q)) };
  return out;
}

class Owner {
  constructor(dataDir, opts = {}) {
    // idleMs: once no write has landed for this long, one wal_checkpoint(TRUNCATE) reclaims the WAL,
    // which C3 measured reaching 30 MB under continuous writes because a passive checkpoint cannot
    // complete while a connection is reading. The periodic checkpoint stays PASSIVE so it never stalls.
    this.dataDir = resolveDataDir(dataDir);
    this.opts = { synchronous: 'NORMAL', sweepMs: 5000, heartbeatMs: 1000, checkpointMs: 10000, idleMs: 3000, idleCheckMs: 1000, embed: true, exitOnShutdown: false, ...opts };
    this.pipe = pipeName(this.dataDir);
    // ADR 0045 decision 7: `claimed` (the default) believes an unkeyed request's caller, as ADR 0012 decision 3 always did;
    // `bound` serves an unkeyed request only as `anonymous` (the reads open to every role) and refuses its writes E_UNBOUND
    // unless opts.operatorCheck vouches for the connection. A keyed request is bound in either mode: its caller is the bind's.
    this.mode = this.opts.mode === 'bound' ? 'bound' : 'claimed';
    this.binds = new BindRegistry(this.dataDir, { ttlMs: this.opts.bindTtlMs });
    this.startedAt = Date.now();
    // ADR 0045 decision 4: a `bound` owner vouches for an operator by the operator's process (operator-check.cjs), unless the caller
    // brought its own check. Where the peer cannot be examined (not Windows) it has no check and fails closed.
    if (this.mode === 'bound' && typeof this.opts.operatorCheck !== 'function' && OperatorCheck.SUPPORTED) {
      this.opts.operatorCheck = OperatorCheck.create({ startedAt: this.startedAt, spawned: () => this._spawnedProcesses(), deps: this.opts.operatorCheckDeps });
    }
    this.conns = new Set();
    this.counters = { calls: 0, errors: 0 };
    this.lastWriteAt = Date.now();
    this.idleTruncated = false;
    this.stopped = false;
    // 5c: `run.stop`, a pipe-level method dispatched to a control this owner was built with, never to
    // the engine. `inFlightControls` tracks each call plus its flushed reply so `stop()` can wait.
    this.controls = opts.controls || {};
    this.inFlightControls = new Set();
  }

  // The lock is published before the pipe exists, and it has to be: a stale-lock takeover needs a pid to
  // check, and a lock directory with no metadata is only treated as a race in progress for one second.
  // So the metadata says `listening: false` until `listen` has actually succeeded. Between those two
  // moments a client that read the lock would otherwise dial a pipe that is not there — on Windows a
  // connect to a missing pipe fails fast, but nothing in the lock said why, and the caller could not
  // tell a starting owner from a wedged one. Now it can, and it falls back to a copy or waits instead.
  async start() {
    const lock = acquireLock(this.dataDir, { pipe: this.pipe, listening: false, mode: this.mode });
    if (!lock.won) {
      throw err('E_LOCKED', `the owner lock at ${this.dataDir} is held by pid ${lock.holder && lock.holder.pid}, which is alive`, { holder: lock.holder || null });
    }
    this.lockDir = lock.lockDir;
    try {
      this.store = new Store(path.join(this.dataDir, 'memory.db'), { synchronous: this.opts.synchronous, stamp: true });
      this.store.heartbeat(process.pid, this.pipe, this.startedAt);
      this.engine = new Engine({ dataDir: this.dataDir, store: this.store, getEmbedder: () => this.getEmbedder(), owner: this, establishedBy: 'owner' });
      await this._listen();
      if (this.mode === 'bound') { this.tcpServer = await require('./owner-tcp.cjs').listenTcp(this); this.tcpPort = this.tcpServer.address().port; }
      // An owner no reader can see as listening is never dialled, so serving on would hold the lock
      // for nothing. Not marked means not started: the whole start is undone and the caller told.
      if (!lockApi.markListening(this.lockDir, Date.now(), this.tcpPort ? { tcp_port: this.tcpPort } : {})) {
        throw err('E_INTERNAL', `the owner at ${this.dataDir} could not publish that its pipe is listening, so it gave up the lock rather than hold it unreachable`, { data_dir: this.dataDir, lock_dir: this.lockDir, cause: 'listening marker not written' });
      }
      this.listening = true;
    } catch (e) {
      // stop() undoes whatever got this far, each step guarded on its own: timers, the pipe server,
      // the store and, last, the lock.
      try { await this.stop(); } catch { /* the start's own error is the one to report */ }
      throw e;
    }
    return { pid: process.pid, pipe: this.pipe, db: this.store.dbPath, embedder: this.embedInfo || null };
  }

  // The embedder loads on the first call that actually needs a vector, never at start.
  //
  // ADR 0003 §3 has the owner refuse to start when the model file is absent. That was written when this
  // owner served only the memory store; it now serves the run, worker, task, lease and checkpoint
  // tables too, and api.md §3 names an embedder on memory.store and memory.search alone. Refusing to
  // start made a missing model file fail task.create, which no line of the contract permits. The
  // failure is now scoped to the calls that need a vector: those raise E_MODEL_ABSENT or
  // E_MODEL_CHANGED and everything else is unaffected. ADR 0003 §3 needs amending to match, which is
  // the lead's call and is flagged in the handover, not resolved here.
  //
  // Lazy for a second reason: no read path may reach the embedding library at all (ADR 0005 §9,
  // api.md §4), which tests/core/import-graph.test.cjs asserts against require.cache.
  getEmbedder() {
    if (this.opts.embed === false) {
      return Promise.reject(err('E_NO_EMBEDDER', 'this owner was started with embedding disabled, so it cannot turn text into a vector; supply one with the call'));
    }
    // One attempt per owner, and its outcome is sticky: a model that is absent or wrong stays that way
    // for this process, so every later call gets the same answer instead of a different one.
    if (!this._embedderPromise) this._embedderPromise = this._loadEmbedder();
    return this._embedderPromise;
  }

  // 'idle' (never asked), 'loading', 'ready' or 'failed': facts of this owner, for memory.warm.
  embedState() {
    if (this.embedError) return 'failed'; // first: a child that died after a good load leaves this.embedder set
    if (this.embedder) return 'ready';
    return this._embedderPromise ? 'loading' : 'idle';
  }

  // memory.warm({ retry: true }): the one supported way past a sticky failure. A failed or dead embedder is
  // closed by its exact pid and the single load attempt is forgotten, so the next getEmbedder() loads afresh;
  // a loading or healthy one is left alone (no restart of a load in progress).
  async resetEmbedder() {
    if (this.embedState() !== 'failed') return false;
    const old = this.embedderObj;
    this._embedderPromise = null; this.embedError = null; this.embedInfo = null; this.embedder = null; this.embedderObj = null;
    if (old) { try { await old.close(); } catch { /* best effort */ } }
    return true;
  }

  async _loadEmbedder() {
    const { Embedder } = require('./embedder.cjs');
    const I = require('./embed-identity.cjs');
    const stored = {};
    for (const r of this.store.db.prepare(`SELECT key, value FROM meta WHERE key IN (${I.META_KEYS.map(() => '?').join(',')})`).all(...I.META_KEYS)) stored[r.key] = r.value;
    const hasIdentity = Object.keys(stored).length > 0;
    let e, info;
    try {
      // ADR 0027 decision 6, in order: the store's recorded model, else the model of the rows already
      // embedded, else the caller's, else the default.
      const rowModels = this.store.db.prepare('SELECT DISTINCT embedding_model FROM namespace_models').all().map(r => r.embedding_model);
      e = new Embedder({ ...this.opts.embedOpts, model: I.chooseModel(stored, this.opts.embedOpts && this.opts.embedOpts.model, rowModels) });
      this.embedderObj = e; // so stop() can end its process even while the load is in flight
      // SF1: a child that dies after a good load is recorded here, sticky, and stats stop reporting it.
      e.onHung = (x) => { this.embedError = { code: x.code, message: x.message, cause: 'timeout' }; this.embedInfo = null; }; // an op timed out: failed until reload
      e.onExit = (why) => { this.embedError = { code: 'E_MODEL_ABSENT', message: why, cause: 'dead' }; this.embedInfo = null; };
      info = await e.load(hasIdentity ? stored : null);
      // Decision 5: the whole identity is written once, in one transaction, on the first load or on the
      // adoption of the exact legacy shape; a passing canary under a moved library records the new library.
      if (!hasIdentity || info.adopted_canary) I.writeMeta(this.store.db, I.identityRows(info));
      else if (info.library_changed) I.writeMeta(this.store.db, [['embedding_library', info.library]]);
      // canary_vector is 1024 floats: keep it out of the identity that stats and ping report.
      const { canary_vector: _canary, ...visible } = info;
      this.embedInfo = { ...visible, pid: e.pid };
      this.embedder = e;
    } catch (loadError) {
      // SF2: anything that throws, before or after the child loaded, closes the child and is recorded
      // with a code; nothing half-published stays behind.
      if (e) { try { await e.close(); } catch { /* best effort */ } }
      const coded = loadError && loadError.name === 'CoreError' ? loadError : err('E_INTERNAL', `the embedder could not be brought up: ${loadError && loadError.message}`, { raw_code: loadError && loadError.code !== undefined ? String(loadError.code) : null });
      // Every embedder failure says so and why (api.md §6); the first load error is the sticky answer.
      const { EMBEDDER_CAUSES } = require('./embedder.cjs');
      const given = coded.detail && coded.detail.cause;
      const cause = EMBEDDER_CAUSES.includes(given) ? given : (coded.code === 'E_MODEL_ABSENT' ? 'absent' : coded.code === 'E_MODEL_CHANGED' ? 'canary' : 'load_failed');
      coded.detail = { ...(coded.detail || {}), embedder: true, cause };
      this.embedError = { code: coded.code, message: coded.message, cause };
      this.embedInfo = null; this.embedder = null;
      throw coded;
    }
    if (info.library_changed) {
      process.stderr.write(`belay owner ${process.pid}: the embedding library moved from ${info.library_changed.from} to ${info.library_changed.to}; the canary still matches, so the store is kept and now records ${info.library_changed.to}\n`);
    }
    return e;
  }

  _listen() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer(c => this._conn(c));
      this.server.once('error', reject);
      this.server.listen(this.pipe, () => {
        this.timers = [
          setInterval(() => { try { this.store.heartbeat(process.pid, this.pipe, this.startedAt); } catch { /* closing */ } }, this.opts.heartbeatMs),
          setInterval(() => { try { this.store.sweep(); } catch { /* closing */ } }, this.opts.sweepMs),
          setInterval(() => { try { this.store.checkpointWal('PASSIVE'); } catch { /* closing */ } }, this.opts.checkpointMs),
          setInterval(() => { try { this._idleCheckpoint(); } catch { /* closing */ } }, this.opts.idleCheckMs),
        ];
        for (const t of this.timers) t.unref();
        resolve();
      });
    });
  }

  // ADR 0045 decision 4 (c): the processes belay spawned that an operator cannot be, from the store's worker rows. A row that names its
  // process's creation time matches on pid and creation time; one that does not is counted only while it is a worker's latest
  // row and claims life, so a dead row's recycled pid never refuses the operator. `opts.spawnedProcesses()` adds the run's own
  // (the headless orchestrator, known only to the run process).
  _spawnedProcesses() {
    const out = [];
    try {
      const live = require('./methods-run.cjs').LIFE_CLAIMING_STATES;
      const db = this.store.db;
      for (const r of db.prepare('SELECT DISTINCT pid, pid_created FROM worker WHERE pid IS NOT NULL AND pid_created IS NOT NULL').all()) out.push({ pid: r.pid, created: r.pid_created, kind: 'worker' });
      for (const r of db.prepare('SELECT w.pid, w.state FROM worker w JOIN (SELECT id, MAX(seq) m FROM worker GROUP BY id) x ON w.id = x.id AND w.seq = x.m WHERE w.pid IS NOT NULL AND w.pid_created IS NULL').all()) if (live.has(r.state)) out.push({ pid: r.pid, created: null, kind: 'worker' });
    } catch { /* a store that cannot be read has no workers to name; the chain rule still stands */ }
    if (typeof this.opts.spawnedProcesses === 'function') { try { out.push(...this.opts.spawnedProcesses()); } catch { /* the run's own list is best effort */ } }
    return out;
  }

  noteWrite() { this.lastWriteAt = Date.now(); this.idleTruncated = false; }

  _idleCheckpoint() {
    if (Date.now() - this.lastWriteAt < this.opts.idleMs || this.idleTruncated) return;
    this.store.checkpointWal('TRUNCATE');
    this.idleTruncated = true;
  }

  // ---- retiring (ADR 0051) ------------------------------------------------------------------------------------------------
  // The clients attached to this owner right now, each named by what establishes it: an open connection (the operating system
  // closes it when its process dies) whose last caller either named no pid or named one that answers a pid check. A connection
  // that has never sent a request counts only while it is young: a ping or a client about to call, not a socket that connected
  // and said nothing. In-process users of this owner (the Core that elected it) hold no connection and are not listed.
  attached() {
    const out = [];
    const t = Date.now();
    for (const c of this.conns) {
      if (c.destroyed) continue;
      const pid = c.belayCaller && Number.isInteger(c.belayCaller.pid) ? c.belayCaller.pid : null;
      if (!c.belayCaller) { if (t - c.belayOpenedAt < UNIDENTIFIED_GRACE_MS) out.push({ pid: null, via: 'open connection, no request yet' }); continue; }
      if (pid === null) out.push({ pid: null, role: c.belayCaller.role || null, via: 'open connection, caller named no pid' });
      else if (lockApi.pidAlive(pid)) out.push({ pid, role: c.belayCaller.role || null, via: 'open connection, pid check answers' });
    }
    return out;
  }

  // Release this owner for its own process: stop now when no other client is attached (the same stop() as ever), else keep
  // serving and stop when the last one is gone. Resolves at once with what was done; the stop that follows a deferral is
  // registered in retire.cjs so the process stays alive for it. Never a signal: the stop is stop().
  async retire() {
    if (this.stopped) return { pid: process.pid, pipe: this.pipe, already: true, deferred: false };
    const now = this.attached();
    if (!now.length) return { ...(await this.stop()), deferred: false };
    if (!this.retiring) {
      this.retiring = true;
      const retire = require('./retire.cjs');
      retire.register(new Promise((resolve) => {
        const check = () => {
          if (this.stopped) { clearInterval(timer); return resolve(); }
          if (this.attached().length) return;
          clearInterval(timer);
          this.stop().then(resolve, resolve);
        };
        // The interval catches a client whose process died without its connection closing; a close wakes the check at once.
        const timer = setInterval(check, RETIRE_POLL_MS);
        this._retireCheck = check;
      }));
    }
    return { pid: process.pid, pipe: this.pipe, already: false, deferred: true, attached: now };
  }

  _conn(c) {
    this.conns.add(c);
    c.belayOpenedAt = Date.now();
    let buf = '';
    c.on('data', d => {
      buf += d.toString('utf8');
      if (buf.length > MAX_LINE_BYTES) { buf = ''; c.destroy(); return; }
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) this._dispatch(c, line);
      }
    });
    const gone = () => { this.conns.delete(c); if (this._retireCheck) this._retireCheck(); };
    c.on('close', gone);
    c.on('error', gone);
  }

  _dispatch(c, line) {
    let req;
    try { req = JSON.parse(line); }
    catch { if (!c.destroyed) c.write(JSON.stringify({ id: null, error: { code: 'E_ARGS', message: 'the request line was not valid JSON' } }) + '\n'); return; }
    this.counters.calls++;
    // A claimed owner with an unkeyed request is the path every existing client takes: it stays synchronous and unchanged.
    if (req.key === undefined && this.mode !== 'bound') return this._serve(c, req);
    let admitted;
    try { admitted = this._admit(c, req); } catch (e) { admitted = { code: e.code || 'E_INTERNAL', message: e.message, detail: e.detail }; }
    Promise.resolve(admitted)
      .then((refusal) => (refusal ? this._refuse(c, req, refusal) : this._serve(c, req)))
      .catch((e) => this._refuse(c, req, { code: e.code || 'E_INTERNAL', message: e.message, detail: e.detail }));
  }

  _refuse(c, req, { code, message, detail }) {
    this.counters.errors++;
    if (!c.destroyed) c.write(JSON.stringify({ id: req.id, error: { code, message, detail } }) + '\n');
  }

  _admit(c, req) { return require('./owner-admit.cjs').admit(this, c, req); } // ADR 0045 decisions 2 and 3

  // ADR 0045 decision 2: open, read or revoke a bind (owner-admit.cjs).
  bindCall(method, params, caller) { return require('./owner-admit.cjs').bindCall(this, method, params, caller); }

  _serve(c, req) {
    // What the retirement check needs about this client; liveness is then a pid check, never the client's word (ADR 0051).
    const who = req.params && req.params.caller;
    if (who && typeof who === 'object') c.belayCaller = { pid: Number.isInteger(who.pid) ? who.pid : null, role: typeof who.role === 'string' ? who.role : null };

    if (req.method === 'ping') {
      const result = { pid: process.pid, pipe: this.pipe, uptime_ms: Date.now() - this.startedAt, calls: this.counters.calls, embedder: this.embedInfo || null, ...(c.belayVerified === undefined ? {} : { operator_verified: c.belayVerified }) };
      if (!c.destroyed) c.write(JSON.stringify({ id: req.id, result }) + '\n');
      return;
    }
    if (req.method === 'shutdown') {
      // Stopping the store is an act of authority, not a courtesy: api.md §6 accepts `shutdown` only
      // from an orchestrator or an operator. Without this gate any worker adapter — every one of which
      // holds a pipe client — could retire the owner out from under the whole run. The trust here is
      // exactly the trust ADR 0012 §3 names: the role is the one the client sent, and what bounds it is
      // that a worker's argv, and so its adapter's role, is set by the harness that spawned it.
      const role = req.params && req.params.caller && req.params.caller.role;
      if (role !== 'orchestrator' && role !== 'operator') {
        this.counters.errors++;
        if (!c.destroyed) {
          c.write(JSON.stringify({
            id: req.id,
            error: {
              code: 'E_ROLE',
              message: `shutdown is available to orchestrator, operator and this call came from role ${JSON.stringify(role === undefined ? null : role)}`,
              detail: { method: 'shutdown', role: role === undefined ? null : role, allowed: ['orchestrator', 'operator'] },
            },
          }) + '\n');
        }
        return;
      }
      // Answer first, then stop: the caller's proof that the owner is going down is the reply itself.
      const payload = JSON.stringify({ id: req.id, result: { stopping: true, pid: process.pid, pipe: this.pipe } }) + '\n';
      const go = () => this.stop().then(() => { if (this.opts.exitOnShutdown) process.exit(0); }, () => { });
      if (c.destroyed) go(); else c.write(payload, go);
      return;
    }
    // ADR 0045 decision 2: the bind verbs are the owner's own, never the engine's (api.md §1).
    if (req.method === 'bind.open' || req.method === 'bind.status' || req.method === 'bind.revoke') {
      const params = req.params || {};
      Promise.resolve().then(() => this.bindCall(req.method, params, params.caller)).then(
        (result) => { if (!c.destroyed) c.write(JSON.stringify({ id: req.id, result }) + '\n'); },
        (e) => this._refuse(c, req, { code: e.code || 'E_INTERNAL', message: e.message, detail: e.detail }));
      return;
    }
    // build step 6f, ADR 0023 amendment 3 decision 4: run.pause and run.resume join run.stop as the
    // three run controls this owner dispatches to whichever control it was constructed with, never to
    // the engine (api.md §1). Same operator-only gate, same E_NOT_FOUND when this owner is not a belay
    // run process (src/core/owner.cjs item 4).
    if (req.method === 'run.stop' || req.method === 'run.pause' || req.method === 'run.resume') {
      this._dispatchRunControl(req.method, c, req);
      return;
    }

    Promise.resolve()
      .then(() => this.engine.handle(req.method, decodeWire(req.params || {})))
      .then(result => { if (!c.destroyed) c.write(JSON.stringify({ id: req.id, result }) + '\n'); })
      .catch(e => {
        this.counters.errors++;
        if (c.destroyed) return;
        c.write(JSON.stringify({ id: req.id, error: { code: e.code || 'E_INTERNAL', message: e.message, detail: e.detail } }) + '\n');
      });
  }

  // 5c: `run.stop` ahead of the engine, after `ping` and `shutdown` — operator only (the shape
  // `shutdown` refuses on), then E_NOT_FOUND if no control is registered, else the control is called
  // and its flushed reply tracked in `inFlightControls` so `stop()` can await it.
  // build step 6f, ADR 0023 amendment 3 decision 4: generalised from `_dispatchRunStop` to serve
  // `run.pause` and `run.resume` too — same gate, same E_NOT_FOUND wording naming the method actually
  // called, same `controls` map keyed by method name.
  //
  // 5c-2 design item 2: a refusal's own write is tracked in `inFlightControls` exactly as the
  // dispatched path is (round-1 finding: an E_ROLE or E_NOT_FOUND refusal racing an owner shutdown was
  // dropped rather than flushed, because `fail` started the write but never added it to the set).
  _dispatchRunControl(method, c, req) {
    const write = (payload) => new Promise((resolve) => { if (c.destroyed) resolve(); else c.write(payload, resolve); });
    const fail = (code, message, detail) => {
      this.counters.errors++;
      const p = write(JSON.stringify({ id: req.id, error: { code, message, detail } }) + '\n');
      this.inFlightControls.add(p);
      p.then(() => this.inFlightControls.delete(p));
      return p;
    };
    const role = req.params && req.params.caller && req.params.caller.role;
    if (role !== 'operator') {
      return fail('E_ROLE', `${method} is available to operator and this call came from role ${JSON.stringify(role === undefined ? null : role)}`,
        { method, role: role === undefined ? null : role, allowed: ['operator'] });
    }
    const control = this.controls[method];
    if (typeof control !== 'function') {
      return fail('E_NOT_FOUND', `this owner (pid ${process.pid}) registers no ${method} control: it is not a belay run process`,
        { method, controls: Object.keys(this.controls) });
    }
    const dispatched = Promise.resolve()
      .then(() => control(decodeWire(req.params)))
      .then((result) => write(JSON.stringify({ id: req.id, result }) + '\n'))
      .catch((e) => {
        this.counters.errors++;
        return write(JSON.stringify({ id: req.id, error: { code: e.code || 'E_INTERNAL', message: e.message, detail: e.detail } }) + '\n');
      });
    this.inFlightControls.add(dispatched);
    dispatched.then(() => this.inFlightControls.delete(dispatched));
  }

  // Fix round for 6f (diff-scope): a private-method compatibility shim. `tests/core/control.test.cjs`
  // is not owned by this build step and calls `_dispatchRunStop` by name to drive the race it tests; the
  // generalisation above renamed it to `_dispatchRunControl(method, c, req)`, so this one-line delegate
  // keeps that unowned, unmodified test passing rather than editing a file outside the owned set.
  _dispatchRunStop(c, req) { return this._dispatchRunControl('run.stop', c, req); }

  // 5a-4 item 1: the whole teardown finishes even when one step throws. Timers, connections, the
  // server, the store and the lock are each guarded on their own, in this order, so a failure in one
  // never skips the ones after it — a caller that sees this reject still finds no owner.lock on disk
  // and no server left listening. Only the first error is kept; it is rethrown at the end, after
  // `stopped` is already true and the lock is already released, because api.md §1 makes this the only
  // way to stop an owner and a rejection must not leave that promise half-kept.
  async stop() {
    if (this.stopped) return { pid: process.pid, pipe: this.pipe, already: true };
    this.stopped = true;
    let firstError = null;
    const record = (e) => { if (!firstError) firstError = e; };
    // 5c: never destroy a connection whose run.stop reply is not yet flushed; bounded at 5,000 ms so
    // a control that never settles cannot strand shutdownOwner() forever.
    if (this.inFlightControls.size) {
      const pending = [...this.inFlightControls];
      await new Promise((resolve) => {
        let settled = false;
        const done = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } };
        const timer = setTimeout(done, 5000);
        Promise.allSettled(pending).then(done);
      });
    }
    // build step 6d, ADR 0020 decision 2: no permission.wait may outlive this owner. Settled here,
    // before the timers are cleared and the connections destroyed, so every registered waiter resolves
    // (a settle marker, never a verdict) before the socket it would have answered over is torn down.
    try { if (this.engine) this.engine.settleWaiters(); } catch (e) { record(e); }
    try { this.binds.close(); } catch (e) { record(e); } // ADR 0045: an owner takes its keys with it
    try { for (const t of this.timers || []) clearInterval(t); } catch (e) { record(e); }
    // MF1: the embedder child process ends with the owner, even mid-load or mid-embed: `close` over IPC,
    // at most 2,000 ms of grace, then a kill by its exact pid (embedder.cjs close()).
    try { if (this.embedderObj) await this.embedderObj.close(); } catch (e) { record(e); }
    try { for (const c of this.conns) c.destroy(); this.conns.clear(); } catch (e) { record(e); }
    await new Promise((resolve) => {
      if (!this.tcpServer) return resolve();
      try { this.tcpServer.close(() => resolve()); } catch (e) { record(e); resolve(); }
    });
    await new Promise((resolve) => {
      if (!this.server) return resolve();
      try { this.server.close((closeErr) => { if (closeErr) record(closeErr); resolve(); }); }
      catch (e) { record(e); resolve(); }
    });
    try { if (this.store) this.store.close(); } catch (e) { record(e); }
    try { if (this.lockDir) releaseLock(this.lockDir); } catch (e) { record(e); }
    if (firstError) throw firstError;
    return { pid: process.pid, pipe: this.pipe, already: false };
  }
}

module.exports = { Owner, decodeWire, floatsFromB64 };
