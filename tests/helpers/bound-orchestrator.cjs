'use strict';
// bound-orchestrator.cjs — a test's way to act as a run's orchestrator against a CLI-run owner, which serves bound callers (ADR 0045
// decisions 4 and 7): the owner believes no claimed role, so the test does what the run does. It reads the run row (reads elect
// nothing), asks the owner for an orchestrator bind as the operator (checked by its process on the loopback port), claims the bind and
// opens a Core that holds the key. `close()` closes both cores.

const { openCore } = require('../../src/core/index.cjs');
const { claimBind } = require('../../src/core/bind.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// `diagnose` (optional) returns a line about the run's process, for example its stderr tail. A failure names the run row's own
// exit_reason (read from a copy of the store) and that line, so a lost owner is explained by what the run said and not only by its code.
async function describeRun(dataDir, runId, diagnose) {
  const parts = [];
  try {
    const row = require('../cli/stop-helpers.cjs').currentRunRow(dataDir, runId);
    parts.push(row ? `run row: ended_at ${row.ended_at == null ? 'null' : row.ended_at}, exit_reason ${JSON.stringify(row.exit_reason)}` : 'run row: none');
  } catch (e) { parts.push(`run row unreadable: ${e.message}`); }
  try { if (diagnose) parts.push(String(diagnose())); } catch (e) { parts.push(`diagnose failed: ${e.message}`); }
  return parts.join('; ');
}

async function connectBoundOrchestrator(dataDir, runId, { waitMs = 60000, embed, diagnose } = {}) {
  const base = { dataDir, ...(embed === undefined ? {} : { embed }) };
  const operator = await openCore({ ...base, caller: { role: 'operator', run_id: runId, pid: process.pid } });
  const t0 = Date.now();
  let row = null; let last = null;
  while (!row && Date.now() - t0 < waitMs) {
    try { row = (await operator.run.get()).run || null; } catch (e) { row = null; last = e; }
    if (!row) await sleep(100);
  }
  if (!row) { await operator.close(); throw new Error(`the CLI's run row never appeared within ${waitMs} ms${last ? ` (${last.code}: ${last.message})` : ''}`); }
  let opened; let claimed;
  try {
    opened = await operator.bindOpen({ role: 'orchestrator', run_id: runId });
    claimed = await claimBind(opened.pipe, { timeoutMs: 5000 });
  } catch (e) {
    const why = await describeRun(dataDir, runId, diagnose);
    await operator.close();
    e.message = `${e.message} [${why}]`;
    throw e;
  }
  const core = await openCore({ ...base, caller: { ...claimed.caller, pid: process.pid }, key: claimed.key });
  const close = core.close.bind(core);
  core.close = async () => { try { await close(); } finally { await operator.close(); } };
  core.operatorCore = operator;
  return core;
}

module.exports = { connectBoundOrchestrator };
