// fake-core.cjs — a stand-in for src/core/index.cjs and src/run/index.cjs, used only through
// BELAY_FAKE_CORE while the real modules land. It exists to drive the adapter's routing, identity
// pass-through and result envelope without a store, so every row it returns is the shape the
// proof column of ADR 0010 §2 names, and nothing more.
//
// Two conventions belong to the fake alone and never reach the real core: `__error` in a tool's
// arguments makes that call reject with the named code, and `__delay_ms` makes it slow.
//
// Three more are environment variables, for the paths no tool argument can reach because the adapter
// makes those calls itself: BELAY_FAKE_REATTACH makes `run.attach` answer as a reattach that declared
// workers dead, BELAY_FAKE_ATTACH_DELAY_MS makes it slow enough that stdin can end while the run
// manager is still being created, and BELAY_FAKE_SHUTDOWN_THROW makes the run manager's `shutdown`
// reject, which is the one thing that must stop the adapter exiting 0.
'use strict';

class CoreError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'CoreError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wraps every method so the fake's two conventions apply uniformly, and so a caller-identity copy is
// available to assertions through the rows themselves.
function gate(fn) {
  return async (args = {}) => {
    if (args && args.__delay_ms) await sleep(args.__delay_ms);
    if (args && args.__error) {
      // `__detail` names the detail the refusal carries, of any shape; `__no_detail` makes it carry
      // none. Both exist so the envelope's detail branches can be driven over the wire rather than by
      // reaching into the binary, which cannot be required without argv of its own.
      const detail = args.__no_detail ? undefined
        : (Object.prototype.hasOwnProperty.call(args, '__detail') ? args.__detail : { echoed: true });
      throw new CoreError(args.__error, `fake core refused: ${args.__error}`, detail);
    }
    return fn(args || {});
  };
}

const now = () => 1757000000000;
const ID = (p) => `${p}-00000000-0000-4000-8000-000000000000`;

const REATTACH = process.env.BELAY_FAKE_REATTACH === '1';
const ATTACH_DELAY_MS = Number(process.env.BELAY_FAKE_ATTACH_DELAY_MS || 0);
const SHUTDOWN_THROWS = process.env.BELAY_FAKE_SHUTDOWN_THROW === '1';
const DEAD_ON_REATTACH = ['wk-dead-1', 'wk-dead-2'];

async function openCore({ dataDir, caller, embed = true }) {
  if (!caller || !caller.role || !caller.run_id || typeof caller.pid !== 'number') {
    throw new CoreError('E_ARGS', 'caller must carry role, run_id and pid from argv');
  }
  const who = caller.worker_id || caller.role;
  const seen = { opened: true, closed: false, ownerStopped: false };
  const stamp = { written_at: now(), written_by: who };

  const core = {
    // Not part of the contract; the tests read it to prove identity came from argv, not a request.
    __caller: caller,
    __dataDir: dataDir,
    __embed: embed,
    __seen: seen,

    memory: {
      store: gate((a) => ({
        id: ID('mem'), action: 'inserted', namespace: a.namespace || `run/${caller.run_id}`,
        text_hash: 'aa00bb11cc22', worker_id: who, last_writer_id: who,
        created_at: now(), updated_at: now(), ttl_at: null,
      })),
      get: gate((a) => (a.id === 'missing'
        ? { id: a.id, found: false }
        : { id: a.id, namespace: `run/${caller.run_id}`, text: 'a stored fact', type: 'fact', tags: [], provenance: null, worker_id: who, seq: 1, created_at: now(), updated_at: now() })),
      search: gate((a) => ({
        results: [{ id: ID('mem'), namespace: `run/${caller.run_id}`, text: `match for ${a.query}`, worker_id: who, tags: ['t'], provenance: 'test', score: 0.91, near_duplicate: false, seq: 1 }],
        scanned: 1, model: 'fake-embed', dim: 4,
      })),
      list: gate(() => ({ rows: [{ id: ID('mem'), namespace: `run/${caller.run_id}`, text: 'a stored fact', worker_id: who, seq: 1 }] })),
      delete: gate((a) => ({ id: a.id, deleted: a.id !== 'missing', namespace: `run/${caller.run_id}` })),
      stats: gate(() => ({ entries: 1, namespaces: 1, bytes: 128, owner: { pid: process.pid, pipe: 'fake', alive: true, established_by: 'in-process' } })),
    },

    status: {
      get: gate((a) => ({
        verdict: 'alive', data_dir: dataDir, established_by: 'owner', ms: 3, deep: !!a.deep,
        rungs: [
          { rung: 'configured', established: true, by: 'stat', ms: 1, detail: 'data dir is a directory' },
          { rung: 'store-present', established: true, by: 'stat', ms: 1, detail: 'memory.db 4096 bytes' },
          { rung: 'owner-alive', established: true, by: 'pid+ping', ms: 1, detail: 'pid alive, ping answered' },
          { rung: 'run-alive', established: true, by: 'row+pid', ms: 0, detail: 'adapter pid alive' },
          { rung: 'worker-alive', established: true, by: 'pid', ms: 0, detail: 'no workers in starting|running' },
          { rung: 'worker-responsive', established: true, by: 'mtime', ms: 0, detail: 'no workers to check' },
        ],
        run: { id: caller.run_id, epoch: 1, adapter_pid: caller.pid, alive: true },
        workers: [{ id: ID('wk'), substrate: 'claude-code', state: 'running', pid: 4242, pid_alive: true, session_id: ID('sess'), task_id: null, last_event_age_ms: 120, turns: 2, input_tokens: 10, output_tokens: 20, cost_usd: 0.01 }],
      })),
    },

    run: {
      attach: gate(async (a) => {
        if (ATTACH_DELAY_MS > 0) await sleep(ATTACH_DELAY_MS);
        const epoch = REATTACH ? 2 : 1;
        return {
          run: { seq: 1, id: caller.run_id, epoch, orchestrator_pid: a.orchestrator_pid || null, adapter_pid: a.adapter_pid, started_at: now(), ended_at: null, exit_reason: null, ...stamp },
          epoch,
          reattached: REATTACH,
          previous: REATTACH ? { seq: 0, id: caller.run_id, epoch: 1, adapter_pid: 1234, started_at: now(), ended_at: null, ...stamp } : null,
          workers_marked_dead: REATTACH ? DEAD_ON_REATTACH.slice() : [],
        };
      }),
      end: gate((a) => ({ seq: 2, id: caller.run_id, epoch: 1, adapter_pid: caller.pid, started_at: now(), ended_at: now(), exit_reason: a.exit_reason, ...stamp })),
      get: gate(() => ({ run: { seq: 1, id: caller.run_id, epoch: 1, adapter_pid: caller.pid, started_at: now(), ended_at: null, ...stamp }, epochs: [] })),
    },

    worker: {
      write: gate((a) => ({ seq: 3, ...a, run_id: caller.run_id, ...stamp })),
      get: gate((a) => ({ seq: 3, id: a.worker_id, run_id: caller.run_id, substrate: 'claude-code', pid: 4242, state: 'running', pid_alive: true, ...stamp })),
      list: gate(() => ({ workers: [{ seq: 3, id: ID('wk'), run_id: caller.run_id, substrate: 'claude-code', pid: 4242, state: 'running', pid_alive: true, last_event_age_ms: 120, ...stamp }] })),
    },

    task: {
      create: gate((a) => ({ seq: 4, id: a.id || ID('task'), run_id: caller.run_id, spec: a.spec, acceptance: a.acceptance || null, files_owned: a.files_owned || [], state: 'open', results: null, ...stamp })),
      assign: gate((a) => ({
        task: { seq: 5, id: a.task_id, run_id: caller.run_id, spec: 'a task', acceptance: null, files_owned: [], state: 'assigned', results: null, ...stamp },
        old_lease: null,
        new_lease: { seq: 6, id: ID('lease'), task_id: a.task_id, run_id: caller.run_id, holder: a.worker_id, holder_role: 'worker', granted_at: now(), expires_at: now() + (a.ttl_ms || 600000), released_at: null, supersedes: null, ...stamp },
        paused_worker: null,
      })),
      list: gate(() => ({ tasks: [{ seq: 4, id: ID('task'), run_id: caller.run_id, spec: 'a task', acceptance: null, files_owned: [], state: 'assigned', results: null, lease: { id: ID('lease'), holder: ID('wk'), holder_role: 'worker', expires_at: now() + 600000, expired: false }, holder_pid_alive: true, last_checkpoint_id: ID('ckpt'), last_checkpoint_at: now(), ...stamp }] })),
      get: gate((a) => ({ seq: 4, id: a.task_id, run_id: caller.run_id, spec: 'a task', state: 'open', lease: null, holder_pid_alive: null, last_checkpoint_id: null, last_checkpoint_at: null, ...stamp })),
      evaluate: gate((a) => ({ seq: 7, id: a.task_id, run_id: caller.run_id, state: 'done', results: { evaluated_at: now(), executable: true, passed: true, checks: [] }, ...stamp })),
    },

    lease: {
      renew: gate((a) => ({ seq: 8, id: a.lease_id, task_id: ID('task'), run_id: caller.run_id, holder: who, holder_role: caller.role, granted_at: now(), expires_at: now() + 600000, released_at: null, supersedes: null, ...stamp })),
      release: gate((a) => ({ seq: 9, id: ID('task'), run_id: caller.run_id, spec: 'a task', state: 'released', last_checkpoint_id: ID('ckpt'), released_lease_id: a.lease_id, ...stamp })),
      takeControl: gate((a) => ({ old_lease: null, new_lease: { seq: 10, id: ID('lease2'), task_id: a.task_id, holder: 'operator', holder_role: 'operator', expires_at: now() + 600000, ...stamp }, paused_worker: null })),
    },

    continuity: {
      checkpoint: gate((a) => ({
        seq: 11, id: ID('ckpt'), task_id: a.task_id, worker_id: caller.worker_id || a.worker_id || null, run_id: caller.run_id,
        turn: a.turn ?? 1, files_touched: a.files_touched || [], tool_digest: caller.role === 'worker' ? [] : (a.tool_digest || []),
        stated: caller.role === 'worker' ? { summary: a.summary || null, next_step: a.next_step || null, open_questions: a.open_questions || [] } : null,
        source: caller.role === 'worker' ? 'worker' : 'harness', ...stamp,
      })),
      resumeLine: gate((a) => {
        const t = a.task_id || ID('task');
        const text = `task ${t} state assigned lease ${ID('lease')}; next (stated): keep going; memory_search "${t}"`;
        return { text, bytes: Buffer.byteLength(text, 'utf8'), task_id: t, task_state: 'assigned', lease_id: ID('lease'), checkpoint_id: ID('ckpt') };
      }),
      resumeDoc: gate((a) => {
        const text = '# spec\na task\n# acceptance\nnone\n# files owned\nnone\n# lease\nheld\n# last harness checkpoint\nnone\n# last worker-stated checkpoint (unverified)\nkeep going\n# memory\nnone\n';
        return { text, bytes: Buffer.byteLength(text, 'utf8'), sections: ['spec', 'acceptance', 'files owned', 'lease', 'last harness checkpoint', 'last worker-stated checkpoint (unverified)', 'memory'], task_id: a.task_id || ID('task') };
      }),
    },

    // build step 6d, ADR 0020: additive, in the same gate shape as every other method.
    permission: {
      list: gate((a) => ({
        requests: [{ seq: 14, id: ID('perm'), run_id: caller.run_id, worker_id: a.run_id ? null : ID('wk'), adapter_pid: process.pid, tool: 'Bash', input: '{}', input_truncated: 0, input_sha256: 'abc123', state: 'pending', verdict_by: null, reason: null, requested_at: now(), decided_at: null, adapter_alive: true, age_ms: 5, ...stamp }],
      })),
      decide: gate((a) => ({
        request: { seq: 14, id: a.id, run_id: caller.run_id, worker_id: ID('wk'), adapter_pid: process.pid, tool: 'Bash', input: '{}', state: 'pending', requested_at: now(), ...stamp },
        verdict: { seq: 15, id: a.id, state: a.verdict === 'allow' ? 'allowed' : 'denied', verdict_by: `${caller.role}:${caller.pid}`, reason: a.reason || null, decided_at: now(), ...stamp },
        adapter_pid_alive: true,
      })),
    },

    isOwner: () => true,
    ownerInfo: () => ({ pid: process.pid, pipe: 'fake', established_by: 'in-process' }),
    shutdownOwner: async () => { seen.ownerStopped = true; return { stopped: true, pid: process.pid }; },
    close: async () => { seen.closed = true; },
  };
  return core;
}

function createRunManager({ core, dataDir, runId, paths }) {
  const workers = new Map();
  return {
    spawn: gate(async (a) => {
      const id = a.worker_id || ID('wk');
      const row = {
        seq: 12, id, run_id: runId, substrate: a.substrate, pid: 4242, session_id: ID('sess'), adapter_pid: process.pid,
        argv_hash: 'deadbeefcafe', state: 'running', worktree: a.worktree, task_id: a.task_id || null,
        started_at: now(), exited_at: null, exit_code: null, exit_signal: null, turns: 0,
        input_tokens: 0, output_tokens: 0, cost_usd: 0, last_event_at: now(),
        written_at: now(), written_by: "orchestrator", ready_ms: 12, __paths: paths || null, __effort: a.effort === undefined ? null : a.effort,
      };
      workers.set(id, row);
      return row;
    }),
    message: gate(async (a) => ({ worker_id: a.worker_id, channel: 'stdin', bytes: Buffer.byteLength(a.text || '', 'utf8'), pid: 4242, turn: 1 })),
    stop: gate(async (a) => ({ worker_id: a.worker_id, pid: 4242, exit_code: 0, exit_signal: null, ms_to_exit: 21, graceful: a.mode === 'graceful', killed: a.mode === 'kill', session_id: ID('sess') })),
    restart: gate(async (a) => ({
      worker_id: a.worker_id, branch: 'resume', reason: 'session id known and last event 40 s ago, inside the 55 min window',
      old_pid: 4242, new_pid: 4343, session_id: ID('sess'), checkpoint_id: ID('ckpt'),
      first_turn_usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5 },
      first_turn_timed_out: false,
      worker: { seq: 13, id: a.worker_id, run_id: runId, substrate: 'claude-code', pid: 4343, state: 'running', written_at: now(), written_by: 'orchestrator' },
    })),
    list: gate(async () => ({ workers: [...workers.values()].map((w) => ({ id: w.id, pid: w.pid, state: w.state, last_event_at: w.last_event_at, turns: w.turns })) })),
    shutdown: gate(async () => {
      if (SHUTDOWN_THROWS) throw new CoreError('E_INTERNAL', 'fake run manager could not stop its workers');
      const stopped = [...workers.keys()];
      await core.shutdownOwner();
      await core.close();
      return { stopped, ms: 5 };
    }),
    __dataDir: dataDir,
  };
}

module.exports = { openCore, createRunManager, CoreError };
