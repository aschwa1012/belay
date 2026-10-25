'use strict';
require('../helpers/tmp.cjs'); // every test process gets its own spawn register and tmp cleanup (tests/helpers/tmp.cjs), however it is run
// A small in-memory stand-in for the core methods src/run calls, so the run module can be tested
// before src/core lands. Only the seven methods the contract says the run manager uses:
// worker.write, worker.get, task.assign, continuity.checkpoint, continuity.resumeLine,
// continuity.resumeDoc, memory.store. Every call is recorded so a test can assert on the writes
// rather than on a return value alone (invariant 5: no success without effect).

const crypto = require('node:crypto');

class FakeCoreError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'CoreError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

// The same liveness question the real core asks (src/core/methods-run.cjs): signal 0 lands, and
// EPERM means the process exists under another owner.
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !!(e && e.code === 'EPERM');
  }
}

function createFakeCore({ runId = 'run-fake', resumeLineText = null, failing = {} } = {}) {
  const calls = [];
  const workerRows = new Map(); // id -> array of rows, highest index is current
  const checkpoints = [];
  const memories = [];
  const leases = new Map();
  let seq = 0;

  const record = (method, args, result) => {
    calls.push({ method, args, result, at: Date.now() });
    return result;
  };
  const maybeFail = (method) => {
    if (failing[method]) throw new FakeCoreError(failing[method], `fake core is configured to fail ${method}`);
  };

  const core = {
    calls,
    workerRows,
    checkpoints,
    memories,
    leases,
    currentWorker: (id) => {
      const rows = workerRows.get(id);
      return rows && rows.length ? rows[rows.length - 1] : null;
    },
    rowsFor: (id) => (workerRows.get(id) || []).slice(),
    callsTo: (method) => calls.filter((c) => c.method === method),

    worker: {
      async write(r) {
        maybeFail('worker.write');
        if (!r || !r.id) throw new FakeCoreError('E_ARGS', 'worker.write needs an id');
        // Mirrors writeWorker: the call's own started_at must be an integer; an inherited value is never checked.
        if (r.started_at != null && !Number.isInteger(r.started_at)) {
          throw new FakeCoreError('E_ARGS', `worker.write needs started_at for worker ${r.id} as an integer`, { worker_id: r.id });
        }
        // The real core refuses this and the fake must too, or it hides the one bug it exists to
        // catch: contract §2, `running` with a dead pid is E_WORKER_NOT_LIVE. build step 6e-4, ADR 0023
        // amendment 2 decision 5: `paused` no longer needs a live pid — a park's own row is written from
        // the exit handler, after the pid has already gone. Mirrors src/core/methods-run.cjs writeWorker.
        if (r.state === 'running' && !alive(r.pid)) {
          throw new FakeCoreError(
            'E_WORKER_NOT_LIVE',
            `worker ${r.id} cannot be written as ${r.state} because pid ${r.pid} is not alive`,
            { worker_id: r.id, pid: r.pid == null ? null : r.pid }
          );
        }
        // Mirrors writeWorker: release_leases on a dead worker that holds no lease writes nothing (ADR 0026 amendment 2).
        const cur = core.currentWorker(r.id);
        if (r.release_leases && cur && cur.state === 'dead' && ![...leases.values()].some((l) => l.holder === r.id && !l.released_at)) {
          return record('worker.write', r, { skipped: true, reason: 'nothing_to_release', current_seq: cur.seq });
        }
        const written = { ...r, seq: ++seq, written_at: Date.now(), written_by: 'orchestrator' };
        if (!workerRows.has(r.id)) workerRows.set(r.id, []);
        workerRows.get(r.id).push(written);
        return record('worker.write', r, written);
      },
      async list() { return { workers: [...workerRows.keys()].map((id) => core.currentWorker(id)) }; },
      async get({ worker_id }) {
        maybeFail('worker.get');
        const cur = core.currentWorker(worker_id);
        if (!cur) throw new FakeCoreError('E_NOT_FOUND', 'no such worker', { worker_id });
        return record('worker.get', { worker_id }, { ...cur, pid_alive: alive(cur.pid) });
      },
    },

    task: {
      // Enough of the task row for what src/run reads back: the last checkpoint written against it.
      async get({ task_id }) {
        maybeFail('task.get');
        const mine = checkpoints.filter((c) => c.task_id === task_id);
        const out = {
          id: task_id, run_id: runId, state: leases.has(task_id) ? 'assigned' : 'open',
          last_checkpoint_id: mine.length ? mine[mine.length - 1].id : null,
        };
        return record('task.get', { task_id }, out);
      },
      // task.ensureHold: the relaunch check. 'task.ensureHold' in `failing` refuses it with that code, as the core's overlap and
      // run-not-live refusals do; the fake holds everything otherwise.
      async ensureHold({ task_id, worker_id }) {
        maybeFail('task.ensureHold');
        return record('task.ensureHold', { task_id, worker_id }, { task_id, run_id: runId, held: true, reason: 'run_live', rehomed: false });
      },
      async assign({ task_id, worker_id, ttl_ms = 600000, check_only = false }) {
        // 'task.assign:check' fails the check_only call (ADR 0030 decision 4) and writes nothing;
        // 'task.assign' fails only the real assign, the race the write-dead path still covers.
        if (check_only) {
          maybeFail('task.assign:check');
          return record('task.assign', { task_id, check_only: true }, { assignable: true, task_id });
        }
        maybeFail('task.assign');
        const lease = {
          id: crypto.randomUUID(), task_id, run_id: runId, holder: worker_id,
          holder_role: 'worker', granted_at: Date.now(), expires_at: Date.now() + ttl_ms,
          released_at: null, supersedes: (leases.get(task_id) || {}).id || null,
        };
        leases.set(task_id, lease);
        const out = {
          task: { id: task_id, run_id: runId, state: 'assigned' },
          old_lease: null, new_lease: lease, paused_worker: null,
        };
        return record('task.assign', { task_id, worker_id }, out);
      },
    },

    continuity: {
      async checkpoint(a) {
        maybeFail('continuity.checkpoint');
        const cp = {
          id: crypto.randomUUID(), seq: ++seq, task_id: a.task_id || null, worker_id: a.worker_id || null,
          run_id: runId, turn: a.turn ?? null, files_touched: a.files_touched || [],
          tool_digest: a.tool_digest || [], stated: null, source: 'harness', written_at: Date.now(),
          written_by: 'orchestrator',
        };
        checkpoints.push(cp);
        return record('continuity.checkpoint', a, cp);
      },
      async resumeLine(a) {
        maybeFail('continuity.resumeLine');
        const lease = a.task_id ? leases.get(a.task_id) : null;
        const text =
          resumeLineText ||
          `task ${a.task_id || a.worker_id} state assigned lease ${lease ? lease.id : 'none'}; next step: (stated) none yet; memory_search "${a.task_id || a.worker_id}"`;
        return record('continuity.resumeLine', a, {
          text, bytes: Buffer.byteLength(text, 'utf8'), task_id: a.task_id || null,
          task_state: 'assigned', lease_id: lease ? lease.id : null,
          checkpoint_id: checkpoints.length ? checkpoints[checkpoints.length - 1].id : null,
        });
      },
      async resumeDoc(a) {
        maybeFail('continuity.resumeDoc');
        const text = `# resume\n\n## spec\nfake spec for ${a.task_id || a.worker_id}\n\n## acceptance\nnone\n`;
        return record('continuity.resumeDoc', a, {
          text, bytes: Buffer.byteLength(text, 'utf8'), sections: ['spec', 'acceptance'],
        });
      },
    },

    memory: {
      async store(a) {
        maybeFail('memory.store');
        const e = {
          id: crypto.randomUUID(), action: 'inserted', namespace: 'run/' + runId,
          text: a.text, tags: a.tags || [], provenance: a.provenance || null, type: a.type || null,
          updated_at: Date.now(),
        };
        memories.push(e);
        return record('memory.store', a, e);
      },
    },

    isOwner: () => true,

    async shutdownOwner() {
      return record('shutdownOwner', {}, { stopped: true });
    },
  };
  return core;
}

module.exports = { createFakeCore, FakeCoreError };
