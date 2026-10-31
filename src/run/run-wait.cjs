'use strict';
// run-wait.cjs — ADR 0074 decisions 2 and 3. Under a policy, `worker_wait` with no worker ids waits for the run, not for a worker. It returns
// at the first exception (ADR 0073) or at its bound, and every return carries the digest of belay's own steps since the last one
// (run-digest.cjs). A wait that names workers never gets here (wait.cjs). A routine turn end is not an exception under a plan and ends
// nothing; the orchestrator names a worker it kept for itself to watch it.
//
// What the wait returns, and where each thing lands in exactly one place:
//   - an exception wake (E1 to E3, E5 to E8, derived from store rows by policy-wakes.cjs): polled into `pending`, and claimed at the
//     instant of the return with no await between the claim and the reply. A poll that is cancelled after it ran leaves its wakes in
//     `pending` for the next wait; a wake another path (the interactive wake pipe) already claimed is not returned again.
//   - a worker death or a stale record (E4), once per life, from this manager's own records.
//   - the digest: claimed in the same synchronous stretch, so a wait that is cancelled before it claims takes no step, and the steps it did
//     not take are in the next wait's digest. A step that finishes while the digest is being built is in this one or the next, never both.
// The bound is the caller's: the default is POLICY_WAIT_DEFAULT_MS (ADR 0074 Q4, open: unchanged from today's 110 s) and `boundOf` caps it
// under MCP_TOOL_TIMEOUT. Nothing in belay raises it.

const P = require('./process.cjs');
const D = require('./run-digest.cjs');
const PW = require('./policy-wakes.cjs');
const CS = require('./call-signal.cjs');

const POLICY_WAIT_DEFAULT_MS = 110000; // ADR 0074 Q4 (open): kept at today's bound behind this one name
const POLL_MS = Number(process.env.BELAY_RUN_WAIT_POLL_MS) > 0 ? Number(process.env.BELAY_RUN_WAIT_POLL_MS) : 2000;
const MARGIN_MS = 10000; // ADR 0029 decision 5

// ADR 0029 decision 5, shared with wait.cjs: the requested bound, capped at MCP_TOOL_TIMEOUT less 10,000 ms (at least 1,000 ms) when that is set.
function boundOf(timeoutMs, env = process.env) {
  const requested = Math.max(1, Number(timeoutMs) || POLICY_WAIT_DEFAULT_MS);
  const raw = String(env.MCP_TOOL_TIMEOUT || '').trim();
  const envTmo = /^\d+$/.test(raw) ? Number(raw) : 0;
  const limit = envTmo > 0 ? Math.max(1000, envTmo - MARGIN_MS) : Infinity;
  const ms = Math.min(requested, limit);
  const capNote = ms < requested
    ? { timeout_capped: { requested_ms: requested, used_ms: ms, by: `MCP_TOOL_TIMEOUT ${envTmo} ms less a 10,000 ms margin` } }
    : null;
  return { ms, capNote };
}

const realClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((res) => { const t = setTimeout(res, ms); if (t.unref) t.unref(); }),
};

// core: the harness core (task, integration, policy, memory reads). dataDir: where the claims live. armed(): whether the run has a plan.
function createRunWait({ core, runId, dataDir, armed = () => true, signal: lifeSignal = null, clock = realClock, pollMs = POLL_MS, watcher = null, hooks = {} }) {
  const exceptions = watcher || PW.createPolicyWatcher({ core, runId, enabled: true });
  const pending = []; // exception wakes polled and not yet delivered, oldest first
  const reported = new Set(); // worker lives already named in a return

  const deathsOf = (workers) => {
    const out = [];
    for (const w of workers) {
      const event = w.staleSince ? 'stale' : (w.settled && (w.settledState != null ? w.settledState : w.state) === 'dead') ? 'dead' : null;
      const key = `${w.id}:${w.launches || 0}:${event}`;
      if (!event || reported.has(key)) continue;
      out.push({ key, uid: D.deathUid(w.id, event === 'dead' ? 'death' : 'stale', w.turns), exception: 'E4', worker_id: w.id, event, established_by: w.staleSince ? `row state ${w.staleSince.row_state}, held by adapter ${w.staleSince.adapter_pid}` : w.deathEstablishedBy, exit_code: w.exitCode == null ? null : w.exitCode, exit_signal: w.exitSignal == null ? null : w.exitSignal, turn: w.turns });
    }
    return out;
  };

  async function collect(workers) {
    const fresh = await exceptions.poll();
    for (const w of fresh) pending.push(w);
    return deathsOf(workers);
  }

  const busyOf = (workers) => workers.filter((w) => !w.settled && !w.turnEnded).map((w) => ({
    worker_id: w.id, state: w.state, pid_alive: w.pid ? P.pidAlive(w.pid) : false,
    last_event_age_ms: w.lastEventAt ? clock.now() - w.lastEventAt : null, turns: w.turns,
  }));

  // args: { ms, capNote, t0, workers (this manager's records), idleOf (async), signal }
  async function wait({ ms, capNote = null, t0 = clock.now(), workers = [], idleOf = async () => ({}), signal = lifeSignal }) {
    const call = CS.current(); // the MCP call this wait answers: its cancel aborts the wait, and a cancel after the claim releases it
    const aborted = () => !!((signal && signal.aborted) || (call && call.signal.aborted));
    const deadline = t0 + ms;
    let deaths = [];
    for (;;) {
      deaths = await collect(workers);
      if (aborted() || pending.length || deaths.length || clock.now() >= deadline) break;
      await clock.sleep(Math.max(1, Math.min(pollMs, deadline - clock.now())));
    }
    // The rows the digest is built from are read after the exceptions were polled: a step that finished in between is in this digest and its
    // exception, if any, in the next return, each in one place.
    let rows = []; let digestError = null;
    if (!aborted()) {
      try { rows = ((await core.policy.list({ limit: 2000 })) || {}).rows || []; } catch (e) { digestError = (e && e.code) || 'E_INTERNAL'; }
      if (hooks.afterRows) await hooks.afterRows();
    }
    const idle = aborted() ? {} : await idleOf();
    // From here to the reply there is no await: what is claimed is what is returned.
    if (aborted()) return { worker_id: null, event: null, timed_out: false, cancelled: true, waited_ms: clock.now() - t0, watched: [], ...(capNote || {}) };
    deaths = deathsOf(workers);
    const uidOf = (w) => `${w.worker_id}:${w.key}`;
    const wakes = pending.splice(0).filter((w) => D.claimException({ dataDir, runId, uid: uidOf(w) }));
    const fresh = deaths; for (const d of fresh) reported.add(d.key); // named once whoever delivers it
    deaths = fresh.filter((d) => D.claimException({ dataDir, runId, uid: d.uid }));
    let digest = null;
    if (!digestError) {
      try { digest = D.claimDigest({ dataDir, runId, rows, via: 'wait', now: clock.now, hooks }); } catch (e) { digestError = (e && e.code) || 'E_INTERNAL'; }
    }
    // A cancel that arrives after this point means the reply is never sent: undo the claim so the next wait offers all of it again.
    if (call) {
      call.claim = {
        release: () => {
          D.release({ dataDir, runId, digestN: digest ? digest.n : null, uids: [...wakes.map(uidOf), ...deaths.map((d) => d.uid)] });
          pending.unshift(...wakes);
          for (const d of deaths) reported.delete(d.key);
        },
      };
    }
    const list = [
      ...wakes.map((w) => ({ exception: w.exception, task_id: w.task_id, trigger: w.trigger, field: w.field, text: w.text })),
      ...deaths.map(({ key, uid, ...d }) => d),
    ];
    return {
      worker_id: null, event: list.length ? 'exception' : null, timed_out: !list.length, waited_ms: clock.now() - t0, watched: [],
      ...(list.length ? { exceptions: list } : { busy: busyOf(workers) }),
      ...(digest ? { digest: { n: digest.n, text: digest.text, steps: digest.lines.length, dropped: digest.dropped.count } } : {}),
      ...(digestError ? { digest_error: digestError } : {}),
      ...(capNote || {}), ...idle,
    };
  }

  return { wait, active: () => !!armed(), pending: () => pending.slice() };
}

module.exports = { createRunWait, boundOf, POLICY_WAIT_DEFAULT_MS, POLL_MS };
