'use strict';
// cmd-task.cjs — build step 6a-2, design item 2. CLI
// slice, mode C: `task assign` reaches the run process over its own control pipe for task.assign, never
// elects. The contract is in src/cli/belay.cjs: run(ctx) -> { code, text, json }, never printing, never
// calling process.exit. One subcommand this step: `assign`; an unknown subcommand is a usage error
// naming it.
//
// 6a-2 fix round: --run is gone. A lease's run_id is its task's (methods-task.cjs, design item 1), so
// this file no longer resolves a run id to stamp a write with — it opens one core as role operator,
// run_id 'cli' (as every other CLI command does), reads task.get through the same mode-C connection the
// write uses, and reports the task row's run_id, never an argument's.

const C = require('./config.cjs');
const { openCore } = require('../core/index.cjs');

function usageError(message) {
  return {
    code: 2,
    text: `belay task: ${message}\n\nusage: belay task assign <task-id> <worker-id> [--ttl <ms>] [--data <dir>] [--json]\n`,
    json: { error: message },
  };
}

function parseAssignArgs(argv) {
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
  if (rest.length !== 2) return { error: `belay task assign needs exactly two arguments, a task id and a worker id; got ${rest.length}` };
  return { taskId: rest[0], workerId: rest[1], ttlMs };
}

function renderText(receipt) {
  if (!receipt.assigned) return `belay task assign: ${receipt.reason || receipt.error.message}\n`;
  const l = receipt.new_lease;
  return `assigned task ${receipt.task.id} to ${l.holder}: lease ${l.id}, expires ${l.expires_at}; task state ${receipt.task.state}\n`;
}

// The last run row this data dir knows of, when there is no live owner to ask task.get through — same
// shape and reasoning as cmd-take-control.cjs's lastRunRow (command table §1's mode-C rule: name the
// last run's id and exit reason).
async function lastRunRow(core) {
  try {
    const { runs } = await core.run.list();
    if (!runs || !runs.length) return null;
    const r = runs[0];
    return { id: r.id, epoch: r.epoch, ended_at: r.ended_at, exit_reason: r.exit_reason };
  } catch { return null; }
}

async function runAssign(ctx) {
  const parsed = parseAssignArgs(ctx.argv);
  if (parsed.error) return usageError(parsed.error);
  const { taskId, workerId, ttlMs } = parsed;

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
          assigned: false, task_id: taskId, worker_id: workerId, run_id: null, run_id_source: 'none',
          error: { code: e.code, message: e.message, detail: e.detail },
          reason: `no live run: ${e.message}`, last,
        };
        return { code: 1, text: renderText(receipt), json: receipt };
      }
      const receipt = {
        assigned: false, task_id: taskId, worker_id: workerId, run_id: null, run_id_source: 'none',
        error: { code: e.code || 'E_INTERNAL', message: e.message, detail: e.detail },
      };
      return { code: 1, text: renderText(receipt), json: receipt };
    }
    const runId = task.run_id;

    const t0 = Date.now();
    let result;
    try {
      result = await core.control('task.assign', { task_id: taskId, worker_id: workerId, ...(ttlMs ? { ttl_ms: ttlMs } : {}) }, { timeoutMs: 30000 });
    } catch (e) {
      const receipt = {
        assigned: false, task_id: taskId, worker_id: workerId, run_id: runId, run_id_source: 'task row',
        error: { code: e.code || 'E_INTERNAL', message: e.message, detail: e.detail },
      };
      return { code: 1, text: renderText(receipt), json: receipt };
    }
    const ms = Date.now() - t0;
    const receipt = {
      assigned: true, run_id: runId, run_id_source: 'task row',
      task: result.task, old_lease: result.old_lease, new_lease: result.new_lease, paused_worker: result.paused_worker,
      established_by: `task.assign over the owner pipe answered in ${ms} ms`,
    };
    return { code: 0, text: renderText(receipt), json: receipt };
  } finally {
    await core.close();
  }
}

async function run(ctx) {
  const sub = ctx.argv[0];
  if (sub !== 'assign') {
    return usageError(sub === undefined ? 'needs a subcommand: assign' : `unknown subcommand ${sub}; the only one this step has is assign`);
  }
  return runAssign({ ...ctx, argv: ctx.argv.slice(1) });
}

module.exports = { run };
