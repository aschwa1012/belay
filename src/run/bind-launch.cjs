'use strict';
// bind-launch.cjs — ADR 0045 decision 2 on the spawning side: every launch of an adapter binds it first. The owner opens a one-shot
// pipe for exactly this identity ({ role, run_id, worker_id? }); its name goes into the adapter's argv as `--bind`; the adapter
// claims it before it answers MCP `initialize`. A bind is single use, so a relaunch (restart, resume) opens a fresh one and revokes
// the last. A core with no bind verbs (a test's fake core) launches unbound; a core that has them and cannot open a bind fails the
// launch with E_BIND, and the launch is never carried on without it.

const fs = require('node:fs');
const { err } = require('../core/errors.cjs');
const L = require('./launch.cjs');

function hasBinds(core) { return !!core && typeof core.bindOpen === 'function'; }

async function open(core, identity, what) {
  try { return await core.bindOpen(identity); }
  catch (e) { throw err('E_BIND', `${what}: the owner would not open a bind (${e.code || 'error'}: ${e.message}); an adapter is launched only with its identity bound`, { identity, cause: e.code || null }); }
}

// A worker launch. Rewrites the worker's mcp.json (Claude Code) and `w.adapterArgs` (Codex) to carry this launch's bind.
async function bindWorker({ core, runId, root, mcpPath }, w) {
  if (!hasBinds(core)) return;
  if (w.bindId) { const old = w.bindId; w.bindId = null; try { await core.bindRevoke(old); } catch { /* the owner is gone, or the bind already closed */ } }
  const b = await open(core, { role: 'worker', run_id: runId, worker_id: w.id }, `worker ${w.id}`);
  w.bindId = b.bind_id;
  const base = L.workerAdapterArgs({ workerId: w.id, runId, dataDir: root, mcpPath, logPath: w.adapterLogPath, permit: w.permissionPrompt, permitWaitMs: w.permitWaitMs, notes: w.notesOn });
  w.adapterArgs = [...base, '--bind', b.pipe];
  if (w.substrate === 'claude-code') {
    const cfg = L.mcpConfig({ workerId: w.id, runId, dataDir: root, mcpPath, logPath: w.adapterLogPath, permit: w.permissionPrompt, permitWaitMs: w.permitWaitMs, notes: w.notesOn, bind: b.pipe });
    fs.writeFileSync(w.mcpJsonPath, JSON.stringify(cfg, null, 2) + '\n');
  }
}

// ADR 0045 decision 2: one launch of a worker at a time, its bind opened first. The bind is an await, and a Codex worker's turn is a
// launch (message): without the slot, two messages could both pass the mid-turn check before either spawned. The slot is taken
// synchronously, before the first await, so the second is refused where it used to be refused.
// A stop that lands while the bind is awaited would read the previous turn's dead pid, kill nothing and return, and the launch would
// then spawn a process the stop never saw. doStop counts its calls on the worker (`stopCalls`); the count is compared once the bind
// is open, in the same tick the process is spawned, and a launch a stop overtook revokes its bind and is refused. A core with no
// bind verbs awaits nothing: the launch stays synchronous, as it was before binds.
async function launchBound(env, w, doLaunch) {
  if (w.launchSlot) throw err('E_SUBSTRATE', `worker ${w.id}: a launch of it is already in progress; one process per turn`, { worker_id: w.id, substrate: w.substrate, state: w.state });
  w.launchSlot = true;
  try {
    if (!hasBinds(env.core)) return await doLaunch();
    const stops = w.stopCalls || 0;
    try {
      await bindWorker(env, w);
      if ((w.stopCalls || 0) !== stops) {
        const spent = w.bindId; w.bindId = null;
        if (spent) { try { await env.core.bindRevoke(spent); } catch { /* the owner is gone, or the bind already closed */ } }
        throw err('E_SUBSTRATE', `worker ${w.id}: a stop arrived while the launch was opening its bind; the launch is abandoned and no process was started`, { worker_id: w.id, substrate: w.substrate, state: w.state, reason: 'stopped_during_launch' });
      }
    } catch (e) {
      // A first launch refused before any process exists leaves the spawn's `starting` row behind: write it `dead`, as every other
      // pre-launch refusal does, before the refusal is handed back. A row a stop already made terminal stays.
      if (w.state === 'starting' && !w.child && env.writeRow) { w.launchFailed = true; await env.writeRow(w, 'dead'); }
      throw e;
    }
    return await doLaunch();
  } finally { w.launchSlot = false; }
}

// The orchestrator's bind, opened by the run process (the owner's own) before the orchestrator is spawned. Returns the pipe name or null.
async function bindOrchestrator(core, runId) {
  if (!hasBinds(core)) return null;
  return (await open(core, { role: 'orchestrator', run_id: runId }, 'the orchestrator')).pipe;
}

module.exports = { bindWorker, bindOrchestrator, launchBound };
