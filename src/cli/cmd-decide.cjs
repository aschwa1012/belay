'use strict';
// cmd-decide.cjs — build step 6d, design item 5, ADR
// 0020 decision 4. CLI slice, mode C: `belay approve <id>` and `belay deny <id> [reason...]`, the
// shape of cmd-take-control.cjs. The contract is in src/cli/belay.cjs: run(ctx) -> { code, text, json },
// never printing, never calling process.exit.

const fs = require('node:fs');
const C = require('./config.cjs');
const { openCore } = require('../core/index.cjs');

function usageError(command, message) {
  const usage = command === 'approve'
    ? 'usage: belay approve <request-id> [--data <dir>] [--json]\n'
    : 'usage: belay deny <request-id> [reason...] [--data <dir>] [--json]\n       a reason word that starts with - goes after --: belay deny <request-id> -- <reason...>\n';
  return { code: 2, text: `belay ${command}: ${message}\n\n${usage}`, json: { error: message } };
}

function renderText(receipt, command) {
  if (!receipt.decided) return `belay ${command}: ${receipt.reason}\n`;
  const reasonPart = receipt.verdict.reason ? ` (${receipt.verdict.reason})` : '';
  const alive = receipt.adapter_pid_alive ? 'alive' : 'dead';
  const moved = receipt.worker_after_moved
    ? `moved: last event advanced within ${receipt.worker_after_waited_ms} ms`
    : `did not move within 2,000 ms`;
  return `request ${receipt.id} (${receipt.request.tool} by worker ${receipt.worker_id}): ${receipt.verdict.state}${reasonPart}; `
    + `adapter pid ${receipt.request.adapter_pid} ${alive}; worker ${moved} (${receipt.established_by})\n`;
}

// Poll worker.get every 200 ms for up to 2,000 ms until last_event_at advances past the verdict's
// decided_at, the shape of cmd-worker.cjs's waitForTerminalRow.
async function waitWorkerAfter(core, workerId, decidedAt) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const t0 = Date.now();
  let error = null;
  for (;;) {
    let row = null;
    try { row = await core.worker.get({ worker_id: workerId }); } catch (e) { error = e.message; }
    if (row && row.last_event_at != null && row.last_event_at > decidedAt) {
      return { moved: true, waited_ms: Date.now() - t0, error };
    }
    if (Date.now() - t0 >= 2000) return { moved: false, waited_ms: Date.now() - t0, error };
    await sleep(200);
  }
}

async function run(ctx) {
  const verdict = ctx.command === 'approve' ? 'allow' : 'deny';
  const positionals = [];
  for (const [i, a] of ctx.argv.entries()) {
    const literal = ctx.literal != null && i >= ctx.literal && i > 0; // a reason word after `--` is text; the request id never is
    if (!literal && typeof a === 'string' && a.startsWith('-')) return usageError(ctx.command, `unknown option ${a}`);
    positionals.push(a);
  }
  if (ctx.command === 'approve' && positionals.length !== 1) {
    return usageError(ctx.command, `belay approve needs exactly one argument, a request id; got ${positionals.length}`);
  }
  if (ctx.command === 'deny' && positionals.length < 1) {
    return usageError(ctx.command, 'belay deny needs at least one argument, a request id');
  }
  const id = positionals[0];
  const reason = ctx.command === 'deny' ? (positionals.slice(1).join(' ') || null) : null;

  const found = C.discover(ctx.cwd);
  const dataDir = C.dataDirOf(found, ctx);

  if (!fs.existsSync(dataDir)) {
    const receipt = { id, verdict, decided: false, reason: `no such data dir: ${dataDir}`, error: null };
    return { code: 1, text: renderText(receipt, ctx.command), json: receipt };
  }

  const core = await openCore({ dataDir, caller: { role: 'operator', run_id: 'cli', pid: process.pid } });
  try {
    const t0 = Date.now();
    let result;
    try {
      result = await core.control('permission.decide', { id, verdict, reason }, { timeoutMs: 30000 });
    } catch (e) {
      if (e.code === 'E_NO_OWNER') {
        const last = await lastRunRow(core);
        const receipt = { id, verdict, decided: false, reason: `no live run: ${e.message}`, error: { code: e.code, message: e.message, detail: e.detail }, last };
        return { code: 1, text: renderText(receipt, ctx.command), json: receipt };
      }
      const receipt = { id, verdict, decided: false, error: { code: e.code || 'E_INTERNAL', message: e.message, detail: e.detail }, reason: e.message };
      return { code: 1, text: renderText(receipt, ctx.command), json: receipt };
    }
    const ms = Date.now() - t0;

    const after = await waitWorkerAfter(core, result.request.worker_id, result.verdict.decided_at);
    // The core's own shape (request, verdict row, adapter_pid_alive) kept as it answered, plus what
    // the CLI adds: id, decided, the worker and run id from the request row (never an argument), and
    // worker_after — never a `verdict` string field that would shadow the core's verdict row.
    const receipt = {
      ...result, id, decided: true, worker_id: result.request.worker_id, run_id: result.request.run_id,
      worker_after: after, worker_after_moved: after.moved, worker_after_waited_ms: after.waited_ms,
      worker_after_error: after.error,
      established_by: `permission.decide over the owner pipe answered in ${ms} ms`,
    };
    return { code: 0, text: renderText(receipt, ctx.command), json: receipt };
  } finally {
    await core.close();
  }
}

// The last run row this data dir knows of, read the same way cmd-take-control.cjs reads it.
async function lastRunRow(core) {
  try {
    const { runs } = await core.run.list();
    if (!runs || !runs.length) return null;
    const r = runs[0];
    return { id: r.id, epoch: r.epoch, ended_at: r.ended_at, exit_reason: r.exit_reason };
  } catch { return null; }
}

module.exports = { run };
