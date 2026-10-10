'use strict';
// index.cjs — `openCore(opts)`, the only door into the store (api.md §1).
//
// openCore opens no file, takes no lock and requires no embedding library: it validates the identity it
// was handed from argv and returns a facade. Mode is chosen per call, by the core and never by the
// caller. Reads ask a live owner with a bounded round trip and fall back to copy-then-read. Writes
// connect to the owner or, for a role permitted to, win the mkdir lock and become the owner in-process
// for the rest of this process's life. A worker-role caller never elects.
//
// Identity is fixed for the life of the process. A `caller` field inside a method's arguments is
// overwritten here before dispatch, so nothing a model says can change who a write is attributed to.

const path = require('node:path');
const { CoreError, err, isTransport } = require('./errors.cjs');
const { pipeName, pidAlive, readOwnerLock, resolveDataDir, lockPath } = require('./lock.cjs');
const fs = require('node:fs');
const { METHODS, METHOD_NAMES, Engine, validateCaller } = require('./engine.cjs');
const { Client } = require('./client.cjs');
const { withCopy } = require('./copy-read.cjs');
const { ping } = require('./ping.cjs');
const unresponsive = require('./unresponsive.cjs');
const { withSemanticFailure } = require('./memory-search.cjs');

const ELECTION_PING_TIMEOUT_MS = 300; // 5a-3: becomeOwner()'s refusal ping
const READ_TIMEOUT_MS = 300;       // api.md §1: the bounded round trip before falling back to a copy
const EMBEDDING_READ_TIMEOUT_MS = 100000; // a call that needs a vector: the first pays a cold load (a load is waited on, never bounded by a fixed 90 s); inside the 120 s MCP tool timeout
const WRITE_TIMEOUT_MS = 30000;
const REPING_BEFORE_LOST_MS = 2000; // E2: a live pid that missed the first ping gets one longer chance (a fork on its loop stalls it 80-365 ms)
const PING_BEFORE_VECTOR_MS = 300; // MF3-1: the liveness ping a vector call sends before waiting its long bound
const EVALUATE_TIMEOUT_MS = 600000; // task.evaluate runs the acceptance commands inside the owner

// 5a-3 fix round (blocking): owner.json is rewritten non-atomically at the moment a loser's connect
// can succeed, so one un-retried read can return null while the owner is live; a few immediate
// re-reads ride out that sub-ms window at no cost to the common case, where the first read succeeds.
function rereadOwnerPid(dataDir, attempts = 5) {
  for (let i = 0; i < attempts; i++) { const lock = readOwnerLock(dataDir); if (lock && Number.isFinite(lock.pid)) return lock.pid; }
  return null;
}

// 5c-2 design item 3: the same ride-out, but for `control`'s missing-vs-unreadable distinction, which
// needs the lock object itself (not just a pid) once the directory is confirmed present.
function rereadOwnerLock(dataDir, attempts = 5) {
  for (let i = 0; i < attempts; i++) { const lock = readOwnerLock(dataDir); if (lock) return lock; }
  return null;
}

// ADR 0040 §2, routing: a keyword search needs no vector, and a supplied vector needs no embedder, so both take
// the ordinary bound and may fall back to the copy. Semantic and hybrid with no vector wait on the owner's embedder.
function readTimeoutFor(method, params) {
  if (method !== 'memory.search' || params.mode === 'keyword') return READ_TIMEOUT_MS;
  if (params.query_embedding || params.query_embedding_b64) return READ_TIMEOUT_MS;
  return EMBEDDING_READ_TIMEOUT_MS;
}

// memory.warm({ wait }) may be given a longer limit for a cold cache (timeout_ms, at most 600,000 ms).
const warmLimit = params => Math.min(Number.isInteger(params.timeout_ms) && params.timeout_ms > 0 ? params.timeout_ms : EMBEDDING_READ_TIMEOUT_MS, 600000);

// The limit a vector call has, whether it goes over the pipe or runs in this process; 0 for any other call.
function vectorLimit(method, params) {
  if (method === 'memory.warm') return params.wait ? warmLimit(params) : 0;
  const t = method === 'memory.search' ? readTimeoutFor(method, params) : method === 'memory.store' ? writeTimeoutFor(method, params) : 0;
  return t === EMBEDDING_READ_TIMEOUT_MS ? t : 0;
}

function writeTimeoutFor(method, params) {
  if (method === 'task.evaluate') return EVALUATE_TIMEOUT_MS;
  if (method === 'memory.store' && !params.embedding && !params.embedding_b64) return EMBEDDING_READ_TIMEOUT_MS;
  if (method === 'memory.warm' && params.wait) return warmLimit(params) + 5000; // the engine's own limit, plus the round trip
  // build step 6d: permission.wait's own deadline is the caller's timeout_ms plus a 5,000 ms margin
  // for the round trip itself, so the client never times out before the engine's own bound would.
  if (method === 'permission.wait') return (params.timeout_ms || 25000) + 5000;
  return WRITE_TIMEOUT_MS;
}

// ADR 0033: the only writes Core re-runs after an owner was lost with the call already sent.
// memory.store converges by dedup inside BEGIN IMMEDIATE (ADR 0002 C4); permission.wait writes nothing.
// A method joins only through a decision record that shows it converges.
const RERUN_SAFE_AFTER_SEND = new Set(['memory.store', 'permission.wait']);
const MIN_RERUN_LEFT_MS = 1000; // a memory.store re-run needs at least this much of its first limit left, or it is not re-run

class Core {
  constructor(opts) {
    this.dataDir = resolveDataDir(opts.dataDir);
    this.caller = Object.freeze({ ...opts.caller });
    this.embed = opts.embed !== false;
    this.ownerOpts = opts.ownerOpts || {};
    this.vectorLimitMs = process.env.BELAY_TEST_MODE === '1' && Number.isInteger(opts.vectorLimitMs) && opts.vectorLimitMs > 0 ? opts.vectorLimitMs : 0; // a shorter in-process vector limit (tests only)
    this.readTimeoutMs = opts.readTimeoutMs || READ_TIMEOUT_MS;
    this.client = null;
    this.owner = null;
    for (const m of METHOD_NAMES) {
      const [group, name] = m.split('.');
      if (!this[group]) this[group] = {};
      this[group][name] = args => this._invoke(m, args);
    }
  }

  // The same dispatch the pipe serves, with this process's identity substituted for whatever the
  // arguments carried.
  handle(method, args) { return this._invoke(method, args); }

  async _invoke(method, args) {
    const spec = METHODS[method];
    if (!spec) throw err('E_ARGS', `${method} is not a Core API method`, { method });
    const params = { ...(args || {}), caller: this.caller };
    if (this.owner && !this.owner.stopped) return this._local(method, params);
    return spec.kind === 'read' ? this._read(method, params) : this._write(method, params);
  }

  // This process IS the owner: the same call limit the pipe gives a client applies (build 12b E2 review 1,
  // S2), so a hung embedder child cannot hold an in-process caller (belay memory store, a re-elected
  // adapter, belay run's warm-up) for the 600 s backstop. The limit ends the CALL; the load continues and
  // a retry joins it. Only a vector call has a limit; every other method returns as before.
  _local(method, params, capMs) {
    const run = this.owner.engine.handle(method, params);
    let limit = method === 'memory.warm' ? vectorLimit(method, params) : (vectorLimit(method, params) && this.vectorLimitMs) || vectorLimit(method, params);
    if (!limit) return run;
    if (capMs !== undefined && capMs < limit) limit = capMs; // a re-run gets only what its first attempt left
    const writes = method === 'memory.store';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const e = err('E_TIMEOUT', method + ' did not finish within ' + limit + ' ms in this process (the owner); its embedder is still loading or embedding and the load continues, so ' + (writes ? 'RE-READ before retrying: the row is written when the load finishes' : 'a retry waits on the same load'), { method, timeout_ms: limit, in_process: true, ...(writes ? { may_have_committed: true } : {}) });
        // A hybrid search still has its keyword half: answer from it, naming the timeout in modes_failed.
        if (method === 'memory.search' && params.mode === 'hybrid') {
          this.owner.engine.handle(method, { ...params, mode: 'keyword' }).then(r => resolve(withSemanticFailure(r, e)), () => reject(e));
        } else reject(e);
      }, limit);
      run.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
    });
  }

  // ---- read: owner first, then copy-then-read ----------------------------
  async _read(method, params) {
    let viaOwner, embedderFailure = null;
    try { viaOwner = await this._tryOwner(method, params); }
    catch (e) {
      // A hybrid search that cannot reach its owner's embedder still has its keyword half: it answers from the
      // copy, and the result names the cause in modes_failed. Every other read keeps the refusal.
      if (!(method === 'memory.search' && params.mode === 'hybrid' && isTransport(e))) throw e;
      embedderFailure = { code: e.code, message: e.message };
      viaOwner = { ok: false };
    }
    if (viaOwner.ok) return viaOwner.value;
    const note = viaOwner.unresponsive ? unresponsive.describe(viaOwner.unresponsive) : null;
    const { Store } = require('./store.cjs');
    // build step 6h design item 6: a data dir with no memory.db has nothing to copy, so `withCopy`'s
    // mkdtemp-then-copy-then-rm is pure overhead (and the throwaway file it built the engine over was
    // itself the cost: creating a fresh on-disk SQLite schema under the OS temp dir, 82-108 ms over the
    // floor per ADR 0018's A12 receipt). No file exists here to be missed by a check-then-create race
    // (invariant 6 is about the live store; a store that was never written has nothing to race), so a
    // plain existsSync is enough to route around `withCopy` entirely: no mkdtemp, no copy, no rmSync.
    if (!fs.existsSync(path.join(this.dataDir, 'memory.db'))) {
      const store = new Store(':memory:');
      try {
        const engine = new Engine({ dataDir: this.dataDir, store, getEmbedder: null, owner: null, establishedBy: 'none', embedderFailure });
        return await engine.handle(method, params);
      } finally { try { store.close(); } catch { /* throwaway */ } }
    }
    return withCopy(this.dataDir, async (dbPath, establishedBy) => {
      const store = new Store(dbPath);
      try {
        const engine = new Engine({ dataDir: this.dataDir, store, getEmbedder: null, owner: null, establishedBy: note ? `${establishedBy}; ${note}` : establishedBy, embedderFailure });
        return await engine.handle(method, params);
      } finally { try { store.close(); } catch { /* throwaway copy */ } }
    });
  }

  // MF3-1 (invariants 4 and 7): liveness for the long vector bound comes from an ANSWER, never from a
  // pid. Before a call that needs a vector waits the long bound, the owner gets the same 300 ms ping
  // status.get uses. Since the embedder moved to its own process a loading owner still answers it, and a
  // wedged one (pid alive, loop blocked) does not: that call fails within about 300 ms with E_OWNER_LOST
  // naming the failed ping, and never falls back silently. No live owner pid: nothing to do here (the
  // caller's ordinary fallback applies).
  async _pingBeforeVector(method, params) {
    if (!vectorLimit(method, params)) return; // the one definition of "needs a vector", warm waits included
    const lock = readOwnerLock(this.dataDir);
    if (!lock || !pidAlive(lock.pid) || lock.listening === false) return;
    const first = await ping(this.dataDir, PING_BEFORE_VECTOR_MS);
    if (first.ok) return;
    // E2: still a bounded request and response (invariant 7), asked twice. A busy owner (a CreateProcess on
    // its loop) answers the second; a wedged one does not, and is then reported lost naming both pings.
    const p = pidAlive(lock.pid) ? await ping(this.dataDir, REPING_BEFORE_LOST_MS) : first;
    if (p.ok) return;
    throw err('E_OWNER_LOST', `the owner (pid ${lock.pid}) is alive but did not answer a ${PING_BEFORE_VECTOR_MS} ms ping (${first.reason}) nor a ${REPING_BEFORE_LOST_MS} ms re-ping (${p.reason}), so its pipe is wedged and ${method} was not attempted`, { method, owner_pid: lock.pid, ping: { ok: false, reason: p.reason, ms: p.ms, timeout_ms: REPING_BEFORE_LOST_MS }, first_ping: { ok: false, reason: first.reason, ms: first.ms, timeout_ms: PING_BEFORE_VECTOR_MS } });
  }

  // The owner answered its ping, so it is loading or embedding: a timeout on the long bound says that.
  _aliveTimeout(method, params, e, timeoutMs) {
    if (!e || e.code !== 'E_TIMEOUT' || readTimeoutFor(method, params) !== EMBEDDING_READ_TIMEOUT_MS) return null;
    const lock = readOwnerLock(this.dataDir);
    if (!lock || !pidAlive(lock.pid)) return null;
    return err('E_TIMEOUT', `the owner (pid ${lock.pid}) answers its pipe but did not answer ${method} within ${timeoutMs} ms; its embedder is still loading or embedding (a load is waited on, never restarted), so retry waits on the same load`, { method, owner_pid: lock.pid, timeout_ms: timeoutMs });
  }

  async _tryOwner(method, params) {
    const timeoutMs = Math.max(this.readTimeoutMs, readTimeoutFor(method, params));
    await this._pingBeforeVector(method, params);
    if (this.client && this.client.connected) {
      try { const value = await this.client.call(method, params, { timeoutMs }); unresponsive.clearPipe(pipeName(this.dataDir)); return { ok: true, value }; }
      catch (e) {
        if (!isTransport(e)) throw e; // a refusal the owner computed is an answer, not a transport fault
        await this._dropClient();
        const alive = this._aliveTimeout(method, params, e, timeoutMs);
        if (alive) throw alive;
        return { ok: false, unresponsive: this._markIfTimeout(e, timeoutMs, undefined, 'answer') };
      }
    }
    // No dial at all unless a lock names a pid that is alive: this is what keeps status.get inside its
    // 100 ms budget on a dead system, and it creates nothing.
    const lock = readOwnerLock(this.dataDir);
    if (!lock || !pidAlive(lock.pid)) return { ok: false };
    // An owner that holds the lock but has not reached `listen` has no pipe to answer on yet. Dialling
    // it costs a failed connect at best and a wait at worst; the copy is available now.
    if (lock.listening === false) return { ok: false };
    // Marked by an earlier timeout in this process: no new dial (each one on a wedged owner is a pending
    // connect that cannot be cancelled), straight to the copy.
    // A read that needs the owner's embedder has no copy to fall back to and is already guarded by
    // _pingBeforeVector's answered ping, so the mark does not apply to it.
    const marked = readTimeoutFor(method, params) === EMBEDDING_READ_TIMEOUT_MS ? null : unresponsive.get(lock.pipe || pipeName(this.dataDir), lock.pid);
    if (marked) return { ok: false, unresponsive: marked };
    const c = new Client(this.dataDir, { caller: this.caller, elect: false, connectRetries: 1, dialTimeoutMs: timeoutMs, callTimeoutMs: timeoutMs });
    try { await c.connect(); } catch (e) { return { ok: false, unresponsive: this._markIfTimeout(e, timeoutMs, lock, 'dial') }; }
    this.client = c;
    try { const value = await c.call(method, params, { timeoutMs }); unresponsive.clearPipe(pipeName(this.dataDir)); return { ok: true, value }; }
    catch (e) {
      if (!isTransport(e)) throw e;
      await this._dropClient();
      const alive = this._aliveTimeout(method, params, e, timeoutMs);
      if (alive) throw alive;
      return { ok: false, unresponsive: this._markIfTimeout(e, timeoutMs, lock, 'answer') };
    }
  }

  // One dial or answer timeout on a read backs the owner off for UNRESPONSIVE_BACKOFF_MS (unresponsive.cjs).
  _markIfTimeout(e, timeoutMs, lock = readOwnerLock(this.dataDir), what = 'answer') {
    if (!e || e.code !== 'E_TIMEOUT' || !lock || !Number.isFinite(lock.pid)) return null;
    return unresponsive.mark(lock.pipe || pipeName(this.dataDir), lock.pid, { what, timeout_ms: timeoutMs });
  }

  // ---- write: connect or elect -------------------------------------------
  async _write(method, params) {
    await this._ensureWriter();
    if (this.owner) return this._local(method, params);
    const timeoutMs = writeTimeoutFor(method, params);
    await this._pingBeforeVector(method, params);
    const t0 = Date.now(); // memory.store: both attempts share one limit, inside the caller's MCP tool timeout
    try { return await this.client.call(method, params, { timeoutMs }); }
    catch (e) {
      // ADR 0033: one re-election on a lost owner, and a re-run only when the call never left
      // (detail.sent === false) or the method converges (RERUN_SAFE_AFTER_SEND). A sent write with no
      // answer may be committed and these tables are append-only, so it is an error, never a second
      // run. A timeout is not retried either.
      if (e.code !== 'E_OWNER_LOST') throw e;
      await this._dropClient();
      const rerun = RERUN_SAFE_AFTER_SEND.has(method);
      if (!(e.detail && e.detail.sent === false) && !rerun) {
        throw err('E_OWNER_LOST', `the owner was lost after ${method} was sent; the owner may already have committed it, so re-read before retrying`, { method, sent: true, may_have_committed: true, outcome: 'unknown' });
      }
      const notSent = !!(e.detail && e.detail.sent === false);
      let left;
      if (method === 'memory.store') {
        left = timeoutMs - (Date.now() - t0);
        if (left < MIN_RERUN_LEFT_MS) {
          if (notSent) throw err('E_OWNER_LOST', `the owner was lost before ${method} was sent and too little of its limit was left to re-run it`, { method, sent: false, rerun: 'skipped', left_ms: left });
          throw err('E_OWNER_LOST', `the owner was lost after ${method} was sent; too little of its limit was left to re-run it, so re-read before retrying`, { method, sent: true, may_have_committed: true, outcome: 'unknown', rerun: 'skipped', left_ms: left });
        }
      }
      await this._ensureWriter();
      let result;
      try {
        result = this.owner ? await this._local(method, params, left) : await this.client.call(method, params, { timeoutMs: left === undefined ? timeoutMs : left });
      } catch (e2) {
        // The re-run was itself sent and lost: the same unknown outcome, in the same shape.
        if (e2.code === 'E_OWNER_LOST' && e2.detail && e2.detail.sent === true) {
          throw err('E_OWNER_LOST', e2.message, { ...e2.detail, method, sent: true, may_have_committed: true, outcome: 'unknown' });
        }
        throw e2;
      }
      if (method === 'memory.store' && result && typeof result === 'object' && !(e.detail && e.detail.sent === false)) {
        return { ...result, rerun_after_owner_lost: { first_attempt: 'outcome unknown' } };
      }
      return result;
    }
  }

  async _ensureWriter() {
    if (this.owner && !this.owner.stopped) return;
    if (this.owner) this.owner = null;
    if (this.client && this.client.connected) return;
    await this._dropClient();
    const elect = this.caller.role !== 'worker';
    const c = new Client(this.dataDir, {
      caller: this.caller,
      elect,
      ownerOpts: { embed: this.embed, ...this.ownerOpts },
      callTimeoutMs: WRITE_TIMEOUT_MS,
    });
    await c.connect(); // a worker with no owner lands here as E_NO_OWNER, having created nothing
    this.client = c;
    if (c.owner) this.owner = c.owner;
  }

  async _dropClient() {
    if (this.client) { const c = this.client; this.client = null; await c.close(); }
  }

  // ---- lifecycle ----------------------------------------------------------
  // 5a-2: election before any write. A caller that must know who owns the data dir before it writes
  // anything at all — `belay run`, so a refused run never opens an epoch it cannot correctly close —
  // calls this instead of letting the first ordinary write elect on its behalf.
  async becomeOwner() {
    if (this.caller.role === 'worker') throw err('E_ROLE', 'a worker never elects the store owner', { role: this.caller.role });
    await this._ensureWriter();
    if (this.isOwner()) return { owner: true, pid: process.pid, established_by: 'won the lock' };
    // 5a-3: a bare connect succeeds on Windows even against a wedged owner, so ownerInfo() alone is
    // not the bounded fact invariant 7 requires — ping it instead.
    //
    // 5a-4 item 5: the old wording named one sentence for every unsuccessful ping, including one that
    // never connected at all (ENOENT, a closed pipe, an unparseable reply) — a claim the ping never
    // established. `ping()` (src/core/ping.cjs) always names what actually happened in `code`
    // (`E_TIMEOUT`, `E_OWNER_LOST`, `E_NO_OWNER`, or the socket's own error code); this reports that
    // code instead of asserting a connection.
    const pinged = await ping(this.dataDir, ELECTION_PING_TIMEOUT_MS);
    const established_by = pinged.ok
      ? `a bounded ping answered in ${pinged.ms} ms`
      : `a ping to the lock holder's pipe failed: ${pinged.code}`;
    // 5a-3 fix round: a ping that answered names its own pid, a fact this call just established;
    // only a ping that did not answer falls back to a (retried) read of the lock file.
    const pid = pinged.ok && pinged.result && Number.isFinite(pinged.result.pid) ? pinged.result.pid : rereadOwnerPid(this.dataDir);
    return { owner: false, pid, established_by };
  }

  // 5c design item 2: mode C. Never elects, never creates a file, never dials with nothing to dial:
  // read the lock and reject E_NO_OWNER naming which fact is missing before touching the network.
  // Otherwise a short-lived client (elect: false) carries the caller identity across, exactly as
  // shutdownOwner()'s remote path does, and is closed whatever the call does.
  async control(method, params, { timeoutMs = 60000 } = {}) {
    let lock = readOwnerLock(this.dataDir);
    if (!lock) {
      // 5c-2 design item 3: readOwnerLock returns null both when there is no owner.lock at all and
      // when the directory exists but owner.json is absent or mid-write (an election in progress).
      // becomeOwner() rides that second window out with rereadOwnerPid; control did not, and reported
      // the filesystem fact "no owner.lock exists" even while the directory sat on disk.
      if (!fs.existsSync(lockPath(this.dataDir))) {
        throw err('E_NO_OWNER', `no owner.lock exists at ${this.dataDir}`, { data_dir: this.dataDir, method });
      }
      lock = rereadOwnerLock(this.dataDir);
      if (!lock) {
        throw err('E_NO_OWNER', `owner.lock exists at ${this.dataDir} but names no readable owner (an election may be in progress)`,
          { data_dir: this.dataDir, method, lock_dir_present: true });
      }
    }
    if (!pidAlive(lock.pid)) throw err('E_NO_OWNER', `the lock names pid ${lock.pid}, which is dead`, { data_dir: this.dataDir, pid: lock.pid, method });
    if (lock.listening === false) throw err('E_NO_OWNER', `the owner at pid ${lock.pid} is not listening yet`, { data_dir: this.dataDir, pid: lock.pid, method });
    const c = new Client(this.dataDir, { caller: this.caller, elect: false, connectRetries: 1, dialTimeoutMs: 1000, callTimeoutMs: timeoutMs });
    try { await c.connect(); }
    catch (e) { throw err('E_NO_OWNER', `connecting to the owner's pipe for ${method} failed: ${e.message}`, { data_dir: this.dataDir, pid: lock.pid, method }); }
    try { return await c.call(method, { ...params, caller: this.caller }, { timeoutMs }); }
    finally { await c.close(); }
  }

  isOwner() { return !!(this.owner && !this.owner.stopped); }

  ownerInfo() {
    if (this.isOwner()) return { pid: process.pid, pipe: this.owner.pipe, alive: true, established_by: 'this process holds the lock' };
    const lock = readOwnerLock(this.dataDir);
    if (!lock) return null;
    return { pid: lock.pid, pipe: lock.pipe || pipeName(this.dataDir), alive: pidAlive(lock.pid), established_by: 'owner.lock pid check' };
  }

  async close() { await this._dropClient(); }

  // The only way to stop an owner (ADR 0002 §5): in-process stop() or the pipe's shutdown method.
  // Never a signal, because a Windows terminate skips the owner's handlers.
  async shutdownOwner() {
    if (this.owner) { const o = this.owner; this.owner = null; const r = await o.stop(); await this._dropClient(); return { ...r, stopped: 'in-process' }; }
    const lock = readOwnerLock(this.dataDir);
    if (!lock || !pidAlive(lock.pid)) { await this._dropClient(); return { stopped: 'none', reason: 'no live owner holds the lock' }; }
    if (!this.client || !this.client.connected) {
      const c = new Client(this.dataDir, { caller: this.caller, elect: false, connectRetries: 1, dialTimeoutMs: 1000 });
      try { await c.connect(); } catch { return { stopped: 'none', reason: 'the lock names a live pid but its pipe did not answer' }; }
      this.client = c;
    }
    const r = await this.client.shutdown();
    this.client = null;
    return r;
  }
}

async function openCore(opts = {}) {
  if (!opts.dataDir || typeof opts.dataDir !== 'string') throw err('E_ARGS', 'openCore needs a dataDir path');
  validateCaller(opts.caller);
  return new Core(opts);
}

module.exports = { openCore, CoreError, pipeName, pidAlive, METHOD_NAMES, readTimeoutFor };
