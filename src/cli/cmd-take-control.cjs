'use strict';
// cmd-take-control.cjs — build step 6a-2, design item 2.
// CLI slice, mode C: reaches the run process over its own control pipe for lease.takeControl, never
// elects. The contract is in src/cli/belay.cjs: run(ctx) -> { code, text, json }, never printing, never
// calling process.exit.
//
// Extended by build step 6e (ADR 0023 decision 9), rebuilt on the park design by 6e-4 (amendment 2): the
// core cannot pause a worker (no process handle, api.md §3), so this file does it — once the lease has
// moved, when the superseded lease's holder role was 'worker', it calls worker.pause (now a park) for
// that worker over its adapter's own pipe. `paused_worker` is that pause receipt, or `{ paused: false,
// worker_id, reason, error, ladder }` naming the rung that failed; when no worker held the superseded
// lease, `paused_worker` is null and `note` names why. The lease has moved either way — that is the
// operator's authority, the pause is its enforcement — so the exit code is 1 only when the lease moved
// but the holder was not parked.
//
// 6a-2 fix round: --run is gone. A lease's run_id is its task's (methods-task.cjs, design item 1), so
// this file no longer resolves a run id to stamp a write with — it opens one core as role operator,
// run_id 'cli' (as every other CLI command does), reads task.get through the same mode-C connection the
// write uses, and reports the task row's run_id, never an argument's.

const C = require('./config.cjs');
const { openCore } = require('../core/index.cjs');
const { callWorkerAdapter, pauseBoundMs } = require('./adapter-pipe.cjs');

function usageError(message) {
  return {
    code: 2,
    text: `belay take-control: ${message}\n\nusage: belay take-control <task-id> [--ttl <ms>] [--data <dir>] [--json]\n`,
    json: { error: message },
  };
}

function parseArgs(argv) {
  let ttlMs;
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--ttl') {
      const v = argv[i += 1];
      if (v === undefined || !/^\d+$/.test(v) || Number(v) <= 0) return { error: '--ttl needs a positive integer number of milliseconds' };
      ttlMs = Number(v);
      continue;
    }
    if (typeof a === 'string' && a.startsWith('-')) return { error: `unknown option ${a}` };
    rest.push(a);
  }
  if (rest.length !== 1) return { error: `belay take-control needs exactly one argument, a task id; got ${rest.length}` };
  return { taskId: rest[0], ttlMs };
}

function renderText(receipt) {
  if (!receipt.taken) return `belay take-control: ${receipt.reason || receipt.error.message}\n`;
  const nl = receipt.new_lease;
  const supersedes = receipt.old_lease ? receipt.old_lease.id : 'none';
  const state = receipt.task ? receipt.task.state : 'unknown';
  let pausePart;
  if (receipt.paused_worker === null) pausePart = `no worker paused (${receipt.note})`;
  else if (receipt.paused_worker.paused) pausePart = `worker ${receipt.paused_worker.worker_id} paused`;
  else pausePart = `worker ${receipt.paused_worker.worker_id} NOT paused: ${receipt.paused_worker.reason}`;
  return `took control of task ${receipt.task_id}: lease ${nl.id} (holder ${nl.holder_role}, expires ${nl.expires_at}), `
    + `superseding ${supersedes}; task state ${state}; ${pausePart}\n`;
}

// build step 6e-4 (ADR 0023 amendment 2 decision 9): a park always fully completes by the time
// `worker.pause` returns (graceful or killed), so the holder was parked exactly when `paused` is true —
// no separate turn-end or background-task check is needed any more (a park's own bg_task stop is
// recorded, never left "unresolved", the way a live interrupt used to be able to time out).
function pauseEstablished(pw) {
  return pw === null || !!pw.paused;
}

// The last run row this data dir knows of, when there is no live owner to ask task.get through — read
// the same way `belay stop` reads its own `last` field: through the ordinary facade (owner-first
// bounded, else copy-then-read; never a write), only via run.list rather than run.get, because there is
// no run id argument here to look one up by. run.list orders by seq desc, so the first row is the most
// recent (command table §1's mode-C rule: name the last run's id and exit reason).
async function lastRunRow(core) {
  try {
    const { runs } = await core.run.list();
    if (!runs || !runs.length) return null;
    const r = runs[0];
    return { id: r.id, epoch: r.epoch, ended_at: r.ended_at, exit_reason: r.exit_reason };
  } catch { return null; }
}

async function run(ctx) {
  const parsed = parseArgs(ctx.argv);
  if (parsed.error) return usageError(parsed.error);
  const { taskId, ttlMs } = parsed;

  const found = C.discover(ctx.cwd);
  const dataDir = C.dataDirOf(found, ctx);

  const core = await openCore({ dataDir, caller: { role: 'operator', run_id: 'cli', pid: process.pid } });
  try {
    let task;
    try {
      task = await core.control('task.get', { task_id: taskId }, { timeoutMs: 5000 });
    } catch (e) {
      if (e.code === 'E_NO_OWNER') {
        const last = await lastRunRow(core);
        const receipt = {
          task_id: taskId, run_id: null, run_id_source: 'none', taken: false,
          error: { code: e.code, message: e.message, detail: e.detail },
          reason: `no live run: ${e.message}`, last,
        };
        return { code: 1, text: renderText(receipt), json: receipt };
      }
      const receipt = {
        task_id: taskId, run_id: null, run_id_source: 'none', taken: false,
        error: { code: e.code || 'E_INTERNAL', message: e.message, detail: e.detail },
      };
      return { code: 1, text: renderText(receipt), json: receipt };
    }
    const runId = task.run_id;

    const t0 = Date.now();
    let took;
    try {
      took = await core.control('lease.takeControl', { task_id: taskId, ...(ttlMs ? { ttl_ms: ttlMs } : {}) }, { timeoutMs: 30000 });
    } catch (e) {
      const receipt = {
        task_id: taskId, run_id: runId, run_id_source: 'task row', taken: false,
        error: { code: e.code || 'E_INTERNAL', message: e.message, detail: e.detail },
      };
      return { code: 1, text: renderText(receipt), json: receipt };
    }
    const ms = Date.now() - t0;
    // A read, through the ordinary facade (owner-first bounded, else copy-then-read): the write already
    // happened, so this is only to name the row the receipt carries. Its own failure is named, never a
    // bare catch (6a-2 fix round, FINDINGS.json note).
    let taskAfter = null, taskError = null;
    try {
      taskAfter = await core.task.get({ task_id: taskId });
    } catch (e) {
      taskError = { code: e.code || 'E_INTERNAL', message: e.message };
    }

    // ADR 0023 decision 9: the lease has moved; now pause the worker it superseded, if any.
    let paused_worker = null;
    let note = null;
    if (!took.old_lease) {
      note = 'no lease was superseded';
    } else if (took.old_lease.holder_role !== 'worker') {
      note = `the superseded lease was held by ${took.old_lease.holder_role}`;
    } else {
      const workerId = took.old_lease.holder;
      const pauseCaller = { role: 'operator', run_id: 'cli', pid: process.pid };
      const pr = await callWorkerAdapter(core, dataDir, {
        workerId, method: 'worker.pause', params: { worker_id: workerId, caller: pauseCaller }, boundMs: pauseBoundMs(),
      });
      const { success, ...prRest } = pr;
      paused_worker = success
        ? { paused: true, ...prRest }
        : { paused: false, worker_id: workerId, reason: prRest.reason, error: prRest.error, ladder: prRest.ladder };
    }

    const receipt = {
      task_id: taskId, run_id: runId, run_id_source: 'task row', taken: true,
      old_lease: took.old_lease, new_lease: took.new_lease, task: taskAfter, task_error: taskError,
      paused_worker, ...(paused_worker === null ? { note } : {}),
      established_by: `lease.takeControl over the owner pipe answered in ${ms} ms`,
    };
    return { code: pauseEstablished(paused_worker) ? 0 : 1, text: renderText(receipt), json: receipt };
  } finally {
    await core.close();
  }
}

module.exports = { run };
