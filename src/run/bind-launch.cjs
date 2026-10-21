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

async function open(core, identity, what, opts) {
  try { return await core.bindOpen(identity, opts); }
  catch (e) { throw err('E_BIND', `${what}: the owner would not open a bind (${e.code || 'error'}: ${e.message}); an adapter is launched only with its identity bound`, { identity, cause: e.code || null }); }
}

// Revoke the bind a launch holds and clear it from the worker. A bind that outlives a failed launch is a live key: if another
// process claimed the public bind pipe first, the genuine adapter found no listener and the launch failed, and that process still
// holds a key for this worker's identity until the owner is told. Every launch failure ends here. Returns what happened, for the
// error's detail: { bind_id, revoked }. `revoked` is false when the owner was gone (its keys died with it) or the revoke was refused.
async function revokeBind(core, w) {
  const id = w.bindId;
  if (!id) return { bind_id: null, revoked: false };
  w.bindId = null;
  if (!hasBinds(core)) return { bind_id: id, revoked: false };
  try { await core.bindRevoke(id); return { bind_id: id, revoked: true }; }
  catch { return { bind_id: id, revoked: false }; }
}

// A worker launch. Rewrites the worker's mcp.json (Claude Code) and `w.adapterArgs` (Codex) to carry this launch's bind.
async function bindWorker({ core, runId, root, mcpPath }, w) {
  if (!hasBinds(core)) return;
  if (w.bindId) { const old = w.bindId; w.bindId = null; try { await core.bindRevoke(old); } catch { /* the owner is gone, or the bind already closed */ } }
  const b = await open(core, { role: 'worker', run_id: runId, worker_id: w.id }, `worker ${w.id}`);
  w.bindId = b.bind_id;
  try {
    const base = L.workerAdapterArgs({ workerId: w.id, runId, dataDir: root, mcpPath, logPath: w.adapterLogPath, permit: w.permissionPrompt, permitWaitMs: w.permitWaitMs, notes: w.notesOn });
    w.adapterArgs = [...base, '--bind', b.pipe];
    if (w.substrate === 'claude-code') {
      const cfg = L.mcpConfig({ workerId: w.id, runId, dataDir: root, mcpPath, logPath: w.adapterLogPath, permit: w.permissionPrompt, permitWaitMs: w.permitWaitMs, notes: w.notesOn, bind: b.pipe });
      fs.writeFileSync(w.mcpJsonPath, JSON.stringify(cfg, null, 2) + '\n');
    }
  } catch (e) { await revokeBind(core, w); throw e; } // the config never reached the adapter, so nothing will claim it honestly
}

// A launch whose child could not be put in the spawn register was ended before the worker took its handle (pid-identity.cjs registerSpawn),
// so no exit listener will ever settle the row the spawn wrote as `starting`. A first launch settles it `dead` before the refusal is handed
// back, as every other pre-launch refusal does. A relaunch keeps the terminal row the worker already had. The refusal stays the error.
async function settleUnregistered(env, w, e) {
  if (!(e && e.detail && e.detail.reason === 'spawn_register') || w.state !== 'starting' || w.child || !env.writeRow) return;
  w.launchFailed = true;
  try { await env.writeRow(w, 'dead'); } catch { /* the registration refusal is the error to report */ }
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
    if (!hasBinds(env.core)) {
      try { return await doLaunch(); } catch (e) { await settleUnregistered(env, w, e); throw e; }
    }
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
    try { return await doLaunch(); }
    catch (e) {
      await revokeBind(env.core, w); // a launch that threw (a refused check, a spawn error) leaves no key behind
      await settleUnregistered(env, w, e);
      throw e;
    }
  } finally { w.launchSlot = false; }
}

// The orchestrator's bind, opened by the run process (the owner's own) before the orchestrator is spawned. Returns the pipe name or null.
// `interactive`: Claude Code starts the MCP server only once the human has answered the trust dialog (measured: ide-leak/receipts/trust,
// no "MCP server connected" line 12 s into an unanswered dialog), so that bind does not expire; the owner revokes it when it stops.
async function bindOrchestrator(core, runId, { interactive = false } = {}) {
  if (!hasBinds(core)) return null;
  return (await open(core, { role: 'orchestrator', run_id: runId }, 'the orchestrator', interactive ? { noExpiry: true } : {})).pipe;
}

module.exports = { bindWorker, bindOrchestrator, launchBound, revokeBind };
