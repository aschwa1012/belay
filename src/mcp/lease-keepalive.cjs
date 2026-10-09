// lease-keepalive.cjs — ADR 0026: the worker adapter renews its worker's lease while the worker is
// alive and working. The adapter already carries the worker's identity from its own argv (invariant 3),
// so `call` is the worker's own core call and the renewal is that worker's own `lease.renew`.
//
// It renews only on derived liveness (invariant 4): the worker row says `running`, its pid answers a
// pid check, and its last event is younger than the lease is long. A paused, parked, stopped, dead or
// silent worker is not renewed, so its lease runs out as it does today. The proof of a renewal is the
// renewed lease row (invariant 5), and every tick logs one line naming its action and its reason.
//
// It writes nothing to stdout, which is the MCP channel. Its timer is unref'd, so it never keeps the
// adapter process alive.
'use strict';

const DEFAULT_TICK_MS = 60000;

// tickMs is a positive integer or it is the default; anything else (NaN from an unset variable, zero,
// a fraction) must not become a hot loop.
const tickOf = (v) => (Number.isInteger(v) && v > 0 ? v : DEFAULT_TICK_MS);

function createKeepalive({
  call, workerId, log, now = Date.now, pidAlive, tickMs = DEFAULT_TICK_MS,
  setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  const alive = pidAlive || require('../core/lock.cjs').pidAlive;
  const every = tickOf(tickMs);
  // A lease's length, remembered the first time it is seen. Renewal moves expires_at and leaves
  // granted_at, so expires_at − granted_at read after a renewal is longer than the lease was granted.
  const lengths = new Map();
  let timer = null;
  let stopped = true;
  let halted = false;
  let inFlight = false;

  const emit = (entry) => {
    try { if (log) log('##', `lease-keepalive ${JSON.stringify(entry)}`); } catch { /* a log that cannot be written must not stop the tick */ }
    return entry;
  };

  // The lease's length is the ttl_ms its row records (every lease row carries it, and renew keeps it).
  // Nothing is derived from granted_at: renew moves expires_at and leaves granted_at, so their
  // difference grows with every renewal. A lease row written before the column existed has no ttl_ms;
  // for that one the length is the time remaining when this process first sees it (never longer than it
  // was granted for), remembered for as long as this process lives.
  function lengthOf(lease, t) {
    const n = Number(lease.ttl_ms);
    if (Number.isInteger(n) && n > 0) return n;
    if (!lengths.has(lease.id)) lengths.set(lease.id, Number(lease.expires_at) - t);
    return lengths.get(lease.id);
  }

  async function tickOne(lease, worker, t) {
    const skip = (reason) => emit({ at: t, lease_id: lease.id, action: 'skip', reason, expires_at: lease.expires_at });
    if (!worker || worker.state !== 'running') return skip('not-running');
    if (worker.pid == null || !alive(worker.pid)) return skip('pid-dead');
    const L = lengthOf(lease, t);
    if (worker.last_event_age_ms == null || Number(worker.last_event_age_ms) >= L) return skip('silent');
    if (Number(lease.expires_at) - t > L / 2) return skip('not-due');
    if (halted) return skip('stopped');
    try {
      const row = await call('lease.renew', { lease_id: lease.id, ttl_ms: L });
      return emit({ at: t, lease_id: lease.id, action: 'renewed', reason: 'due', expires_at: row && row.expires_at });
    } catch (e) {
      return emit({ at: t, lease_id: lease.id, action: 'skip', reason: `refused ${(e && e.code) || 'error'}`, expires_at: lease.expires_at });
    }
  }

  async function tick() {
    if (inFlight) return [];
    inFlight = true;
    try {
      const t = now();
      let tasks;
      try { tasks = ((await call('task.list', {})) || {}).tasks || []; } catch (e) {
        return [emit({ at: t, lease_id: null, action: 'skip', reason: `task.list failed ${(e && e.code) || 'error'}`, expires_at: null })];
      }
      const held = tasks.map((x) => x.lease).filter((l) => l && l.holder === workerId && l.holder_role === 'worker'
        && l.released_at == null && l.expires_at != null && Number(l.expires_at) > t);
      if (held.length === 0) return [emit({ at: t, lease_id: null, action: 'skip', reason: 'no-lease', expires_at: null })];
      let worker = null;
      try { worker = await call('worker.get', { worker_id: workerId }); } catch { worker = null; }
      const out = [];
      for (const lease of held) out.push(await tickOne(lease, worker, t));
      return out;
    } catch (e) {
      return [emit({ at: null, lease_id: null, action: 'skip', reason: `error ${(e && e.message) || e}`, expires_at: null })];
    } finally {
      inFlight = false;
    }
  }

  function arm() {
    if (stopped) return;
    timer = setTimer(() => { arm(); tick().catch(() => {}); }, every);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    halted = false;
    arm();
  }

  function stop() {
    stopped = true;
    halted = true;
    if (timer !== null) { try { clearTimer(timer); } catch { /* already cleared */ } timer = null; }
  }

  return { start, stop, tick };
}

module.exports = { createKeepalive };
