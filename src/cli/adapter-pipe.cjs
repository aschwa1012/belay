'use strict';
// adapter-pipe.cjs — build step 6c, design item 4, ADR
// 0019 decisions 2-5 and amendment 1. The CLI's ladder to the worker adapter's own pipe for
// worker.stop, worker.restart and worker.message: never elects, never creates a file, never dials with
// nothing to dial (decision 3). Imports only src/core (api.md §1: the CLI must not import src/run).

const { adapterPipeName, pidAlive } = require('../core/lock.cjs');
const { Client } = require('../core/client.cjs');
const { SNAPSHOT_TIMEOUT_MS } = require('../core/proc-identity.cjs');

// ADR 0048: a kill that is not made through a live handle takes one process snapshot, and a caller that arrives while
// one is in flight waits for it and then for its own, so a snapshot wait costs up to 2 x T (T, the snapshot timeout in
// force). A re-take after a signal in the same process is a further wait; the ceiling for one kill is 4 x T (2 x T for the
// first wait, 2 x T for the re-take). By the operator's decision these bounds charge 2 x T once per wait on the path: a kill
// that re-takes under a stall can outrun them, and the caller is then told the pipe did not answer in time. Each bound below names how many
// waits its path has. `snapMs` is T; callers leave it out, and a test that runs the CLI with an override passes it.
const snapWaitMs = (T) => 2 * T;

// Amendment 1 item 2: the bound a verb waits is the sum of the manager method's own nested waits, read
// from src/run/manager.cjs (stop's three waits; restart's own stop plus its 60,000 ms ready window
// plus the first turn; message's 30,000 ms client deadline inside turnStarted), not the one argument
// each method takes. The CLI's own read timeout is that sum plus 5,000 ms.
// build step 6e-5 design item 4 (review 2, adapter-pipe.cjs:14): doStop's own worst case, kept apart from
// `stopBoundMs` below (which now also covers a pause or resume `stop` might wait out) so `restartBoundMs`
// does not inherit that addition — 6e-5 already releases restart's own slot at the running row.
// One snapshot wait: the kill fallback of a graceful stop that did not end in time.
function doStopInternalBoundMs(timeout_ms, T = SNAPSHOT_TIMEOUT_MS) {
  return timeout_ms + Math.max(2000, Math.min(timeout_ms, 10000)) + 5000 + 5000 + snapWaitMs(T);
}
// 6e-5 design item 4 (review 2, adapter-pipe.cjs:14): `stop`'s own operation slot can now wait out a
// pause or a resume in flight before it even starts (lifecycle.cjs `waitFor`); the CLI's bound must cover
// whichever of those two is the longer, on top of doStop's own worst case above.
function stopBoundMs(timeout_ms, T = SNAPSHOT_TIMEOUT_MS) {
  return doStopInternalBoundMs(timeout_ms, T) + Math.max(pauseBoundMs(undefined, undefined, T), resumeBoundMs(T));
}
function restartBoundMs(first_turn_timeout_ms, T = SNAPSHOT_TIMEOUT_MS) {
  // + EXIT_CODE_WAIT_MS (15,000): failNoReady's bounded hold for a pid-established death's exit code
  return doStopInternalBoundMs(10000, T) + 5000 + 60000 + 15000 + first_turn_timeout_ms;
}
function messageBoundMs() {
  return 30000 + 5000;
}
// build step 6e-4 (ADR 0023 amendment 2): a park's own nested waits — the interrupt bound; the descendant
// snapshot; the graceful close; the kill fallback's own wait; the stop's own three internal waits; the
// paused row's write; the receipt's own read; the CLI's margin. ADR 0048: three snapshot waits (pause.cjs: the
// descendants before the close, the stop's kill fallback, and killMany after the exit), 2 x T each.
function pauseBoundMs(interrupt_timeout_ms = 5000, exit_timeout_ms = 10000, T = SNAPSHOT_TIMEOUT_MS) {
  return interrupt_timeout_ms + exit_timeout_ms + Math.max(2000, Math.min(exit_timeout_ms, 10000)) + 5000 + 30000 + 30000 + 5000 + 3 * snapWaitMs(T);
}
// a resume's own nested waits — the resume line's read; the old pid's wait; the ready window; the running
// row's write; the CLI's margin.
// ADR 0048: one snapshot wait for the kill a failed relaunch makes (failNoReady).
function resumeBoundMs(T = SNAPSHOT_TIMEOUT_MS) {
  // + 15000: failNoReady's bounded hold for the exit code (worker.EXIT_CODE_WAIT_MS)
  return 30000 + 5000 + 60000 + 15000 + 30000 + 5000 + snapWaitMs(T);
}

function failure(workerId, ladder, last, reason, error) {
  return { success: false, worker_id: workerId, reason, error: error || null, ladder, last };
}

// callWorkerAdapter(core, dataDir, { workerId, method, params, boundMs }). `params` already carries
// `caller`. Returns `{ success: true, ...the manager's receipt verbatim, worker_id, channel:
// 'adapter-pipe', adapter_pid, pipe, ms, ladder, established_by }` or `{ success: false, worker_id,
// reason, error, ladder, last }`. Five rungs, the first failure ending the climb, each recorded in
// `ladder` as `{ rung, ok, established_by }`.
async function callWorkerAdapter(core, dataDir, { workerId, method, params, boundMs }) {
  const ladder = [];
  let last = null;

  // Rung 1: worker.get (owner-first bounded, else copy-then-read; mode R). E_NOT_FOUND is the reason;
  // a forgotten row is refused here, because the manager cannot see that state's meaning; every other
  // state is the manager's to judge.
  let w;
  try {
    w = await core.worker.get({ worker_id: workerId });
  } catch (e) {
    ladder.push({ rung: 1, ok: false, established_by: `worker.get answered ${e.code || 'E_INTERNAL'}` });
    return failure(workerId, ladder, null, e.message, { code: e.code || 'E_INTERNAL', message: e.message, detail: e.detail });
  }
  last = w;
  if (w.state === 'forgotten') {
    ladder.push({ rung: 1, ok: false, established_by: `worker.get row seq ${w.seq} is forgotten` });
    return failure(workerId, ladder, last, `row seq ${w.seq} is forgotten; a write under the id relaunches it, nothing else does`, null);
  }
  ladder.push({ rung: 1, ok: true, established_by: `worker.get row seq ${w.seq}` });

  // Rung 2: run.list() (the same read) and the row whose id is the worker row's run_id, never an
  // argument and never the first alive run (the 6a lesson).
  let run;
  try {
    const { runs } = await core.run.list();
    run = runs.find((r) => r.id === w.run_id);
  } catch (e) {
    ladder.push({ rung: 2, ok: false, established_by: `run.list answered ${e.code || 'E_INTERNAL'}` });
    return failure(workerId, ladder, last, e.message, { code: e.code || 'E_INTERNAL', message: e.message, detail: e.detail });
  }
  if (!run) {
    ladder.push({ rung: 2, ok: false, established_by: `no run row for ${w.run_id}` });
    return failure(workerId, ladder, last, `no run row for ${w.run_id}`, null);
  }
  if (run.ended_at != null) {
    ladder.push({ rung: 2, ok: false, established_by: `run ${run.id} ended at ${run.ended_at}` });
    return failure(workerId, ladder, last, `run ${run.id} ended at ${run.ended_at} (${run.exit_reason})`, null);
  }
  ladder.push({ rung: 2, ok: true, established_by: `run.list row for ${run.id}, adapter_pid ${run.adapter_pid}` });

  // Rung 3: pidAlive(run.adapter_pid).
  if (!pidAlive(run.adapter_pid)) {
    ladder.push({ rung: 3, ok: false, established_by: `pidAlive(${run.adapter_pid}) is false` });
    return failure(workerId, ladder, last, `adapter pid ${run.adapter_pid} of run ${run.id} is dead; the next run.attach names a new one`, null);
  }
  ladder.push({ rung: 3, ok: true, established_by: `pidAlive(${run.adapter_pid})` });

  // Rung 4: dial the adapter's own pipe. Rung 5: the bounded call. Closed in a `finally` on every path.
  const pipe = adapterPipeName(dataDir, run.adapter_pid);
  const client = new Client(dataDir, {
    pipe, caller: params.caller, elect: false, connectRetries: 1, dialTimeoutMs: 1000, callTimeoutMs: boundMs,
  });
  const t0 = Date.now();
  try {
    try {
      await client.connect();
    } catch (e) {
      ladder.push({ rung: 4, ok: false, established_by: `connect to ${pipe} failed` });
      return failure(workerId, ladder, last, `the adapter's pipe ${pipe} did not answer: ${e.message}`, { code: e.code || 'E_INTERNAL', message: e.message, detail: e.detail });
    }
    ladder.push({ rung: 4, ok: true, established_by: `connected to ${pipe}` });

    let result;
    try {
      result = await client.call(method, params, { timeoutMs: boundMs });
    } catch (e) {
      const reason = e.code === 'E_TIMEOUT'
        ? `the adapter did not answer ${method} within ${boundMs} ms; it may have acted, so re-read the row`
        : e.message;
      ladder.push({ rung: 5, ok: false, established_by: reason });
      return failure(workerId, ladder, last, reason, { code: e.code || 'E_INTERNAL', message: e.message, detail: e.detail });
    }
    const ms = Date.now() - t0;
    const established_by = `${method} over the adapter pipe of pid ${run.adapter_pid} answered in ${ms} ms`;
    ladder.push({ rung: 5, ok: true, established_by });
    // Fix round, should-fix finding: `worker.message`'s own receipt already carries `channel:
    // 'stdin'|'codex-resume'` (the substrate distinction api.md §5 and the text render both need);
    // a literal 'adapter-pipe' here used to overwrite it. `stop` and `restart` carry no `channel` of
    // their own, so they still read 'adapter-pipe' as before — the transport, named where nothing else
    // names it. `established_by` always names the pipe regardless.
    return {
      ...result, success: true, worker_id: workerId, channel: result.channel || 'adapter-pipe',
      adapter_pid: run.adapter_pid, pipe, ms, ladder, established_by,
    };
  } finally {
    await client.close();
  }
}

module.exports = { callWorkerAdapter, stopBoundMs, restartBoundMs, messageBoundMs, pauseBoundMs, resumeBoundMs };
