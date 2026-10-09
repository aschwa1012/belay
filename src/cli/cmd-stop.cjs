'use strict';
// cmd-stop.cjs — build step 5c, design item 6. CLI slice,
// mode C: connects to the run's own control pipe and never starts a process or writes a file on any
// path. The contract is in src/cli/belay.cjs: run(ctx) -> { code, text, json }, never printing, never
// calling process.exit.

const fs = require('node:fs');

const C = require('./config.cjs');
const { openCore } = require('../core/index.cjs');

function usageError(message) {
  return {
    code: 2,
    text: `belay stop: ${message}\n\nusage: belay stop <run-id> [--data <dir>] [--json]\n`,
    json: { error: message },
  };
}

// Which of api.md §6's codes a mode-C caller can see here, and the one-sentence reason each becomes.
function reasonFor(e) {
  if (e.code === 'E_NO_OWNER') return `no live run: ${e.message}`;
  if (e.code === 'E_NOT_FOUND') return e.message;
  if (e.code === 'E_TIMEOUT') return "the run's pipe did not answer within 60000 ms";
  return e.message;
}

// The current run row, read the same way status.get does (owner-first bounded read, then
// copy-then-read): never a live open, never a write, so a failed stop still creates nothing.
async function lastRunRow(core) {
  try {
    const g = await core.run.get();
    if (!g || !g.run) return { last: null, last_error: null };
    const r = g.run;
    return {
      last: { id: r.id, epoch: r.epoch, orchestrator_pid: r.orchestrator_pid, started_at: r.started_at, ended_at: r.ended_at, exit_reason: r.exit_reason },
      last_error: null,
    };
  } catch (e) {
    return { last: null, last_error: { code: e.code || 'E_INTERNAL', message: e.message } };
  }
}

function renderText(receipt) {
  if (!receipt.stopped) return `belay stop: ${receipt.reason}\n`;
  const o = receipt.orchestrator;
  const lines = [
    `orchestrator pid ${o.pid}: exit ${o.exit_code != null ? o.exit_code : o.exit_signal}, ${o.ms_to_exit} ms, ${o.graceful ? 'graceful' : 'killed after close'}`,
  ];
  for (const w of receipt.workers) {
    lines.push(`worker ${w.id} pid ${w.pid}: ${w.state}, pid alive ${w.pid_alive}, ${w.killed ? 'killed' : 'not killed'}`);
    // ADR 0039: a kill refused for want of proof names how the operator can end the process by hand.
    if (w.killed && w.killed.manual) lines.push(`  refused (${w.killed.detail}). ${w.killed.manual}`);
  }
  // build step 6f, ADR 0023 amendment 3: a stop leaves a paused run's workers parked; named here
  // since they carry no kill of their own (src/run/stop.cjs's `left_parked`).
  if (Array.isArray(receipt.left_parked) && receipt.left_parked.length) {
    lines.push(`left parked: ${receipt.left_parked.join(', ')}`);
  }
  lines.push('');
  return lines.join('\n');
}

async function run(ctx) {
  if (ctx.argv.length !== 1) {
    return usageError(`belay stop needs exactly one argument, a run id; got ${ctx.argv.length}`);
  }
  const runId = ctx.argv[0];

  const found = C.discover(ctx.cwd);
  const dataDir = C.dataDirOf(found, ctx);

  // Mode C: never created, only stat-ed. A run that never wrote a data dir at all has no lock to dial.
  if (!fs.existsSync(dataDir)) {
    const receipt = {
      run_id: runId, stopped: false, reason: `no live run: the data dir ${dataDir} does not exist`,
      last: null, established_by: 'the data dir was stat-ed',
    };
    return { code: 1, text: renderText(receipt), json: receipt };
  }

  const core = await openCore({ dataDir, caller: { role: 'operator', run_id: runId, pid: process.pid } });
  try {
    const t0 = Date.now();
    let result;
    try {
      result = await core.control('run.stop', { run_id: runId }, { timeoutMs: 60000 });
    } catch (e) {
      const ms = Date.now() - t0;
      const { last, last_error } = await lastRunRow(core);
      // 5c-2 fix round (FINDINGS.json should-fix, lines 212 and 48): the owner's own refusal can carry
      // a `detail` naming who stopped the run first (`run.stop`'s `ended` refusal, src/run/stop.cjs)
      // or which mode-C fact was missing (`Core.control`, src/core/index.cjs) — forwarding it is what
      // makes the second-stop rule (design item 1) actually reach the CLI caller it exists for.
      const receipt = {
        run_id: runId, stopped: false, error: { code: e.code || 'E_INTERNAL', message: e.message, detail: e.detail },
        reason: reasonFor(e), last, last_error, ms,
      };
      return { code: 1, text: renderText(receipt), json: receipt };
    }
    const ms = Date.now() - t0;
    const receipt = { ...result, stopped: true, established_by: `run.stop over the owner pipe answered in ${ms} ms` };
    return { code: 0, text: renderText(receipt), json: receipt };
  } finally {
    await core.close();
  }
}

module.exports = { run };
