'use strict';
// lifecycle.cjs — build step 6e-4, design item 1, ADR 0023
// amendment 2 decision 3. One operation slot per worker record (`w.op = null | { name, promise }`): pause,
// resume, restart and stop share it, so no bound ever includes another operation's own wait. The same
// operation already in flight is shared (one promise, one receipt); a different one is either awaited,
// when the caller says it may wait for it, or refused `E_BUSY`. Replaces the three separate in-flight
// promises (`w.stopInFlight`, `w.pauseInFlight`, `w.resumeInFlight`) build steps 6a-6e-3 kept on the record.
// build step 6e-5: `shutdown` moved verbatim
// here from manager.cjs, to close review 2's finding at manager.cjs:475 without crossing the 500-line rule.

const fs = require('node:fs');
const path = require('node:path');
const { fail } = require('./errors.cjs');
const P = require('./process.cjs');
const now = () => Date.now();

// runOp(w, name, fn, { waitFor }). The slot is reserved synchronously, before `fn` ever runs and before
// any `await` — a second call for the same `name` arriving in the same tick sees the reservation already
// in place and shares it, rather than racing to start its own (the exact shape a coalesced `stop` needs
// while it waits out someone else's pause). Cleared in a `finally`, and only when this call's own promise
// is still the one on the record: a slot a later operation has already claimed must never be cleared by
// an earlier one's cleanup running after it lost the race to set `w.op`.
async function runOp(w, name, fn, { waitFor = [] } = {}) {
  if (w.op) {
    if (w.op.name === name) return w.op.promise;
    if (!waitFor.includes(w.op.name)) {
      fail('E_BUSY', `worker ${w.id} is busy with ${w.op.name}; retry when it returns`, { worker_id: w.id, op: w.op.name });
    }
  }
  const waitOn = w.op; // captured before the reservation below; null when nothing was in flight
  const p = (async () => {
    if (waitOn) await waitOn.promise.catch(() => {}); // its own errors are its caller's, not this op's
    return fn();
  })();
  w.op = { name, promise: p };
  try {
    return await p;
  } finally {
    if (w.op && w.op.promise === p) w.op = null;
  }
}

// build step 6e-5 design item 1 (review 2, manager.cjs:475): a graceful adapter exit must not turn every
// parked worker into a stopped one — that defeated ADR 0023 amendment 2 decision 2's cross-adapter resume,
// since a stop's row is 'stopped' and no later adapter can resume a stopped worker. A worker whose record
// is already parked (`state: 'paused'`, no live pid, by construction) is skipped outright: no stop call, no
// row write, named instead in `left_parked`. A worker still mid-park (its own `pause` op in flight) is not
// skipped here — `stop`'s own `waitFor` lets it wait the park out and then stop it, exactly as it already
// does for any other caller's stop.
// build step 6e-6 item 5 (carried item 5, lifecycle.cjs:54): a pause still in flight when shutdown runs
// used not to be recognised here (its row was not yet 'paused'), so shutdown called `stop` on it, which
// waits the park out (`stop`'s own `waitFor`) and then stops the now-parked worker — turning the pause
// caller's own receipt (`paused: true`) into a row that reads 'stopped', the very thing this design item
// exists to prevent. A worker whose current operation is a pause is waited out here instead, and left
// parked (no stop, no row) once it lands there, exactly as an already-parked worker is.
// build step 6e-6 item 4 (carried item 4): a worker whose record has gone stale (another adapter has
// since resumed it) is named under `left_stale`, never `left_parked` — this adapter holds nothing of its
// own to stop or to claim as a park.
// fix round (review of 6e-6, lifecycle.cjs:65): `w.state === 'paused'` alone is not a park — a resume
// whose 'starting' write failed leaves state 'paused' with a live child still attached (pause.cjs's own
// `wasParked` reasoning). Only `w.state === 'paused' && !w.child` (no live child of this adapter's own)
// is dead-by-construction; anything else falls through to `stop`, which then actually kills it.
const parked = (w) => w.state === 'paused' && !w.child;
// build step 6i-2 design item 3 (R4; the tests/cli/pause.test.cjs hang): the review found a late
// worker-row write (the exit-code fill-in a settled record's own "already settled" branch queues,
// exit.cjs) re-electing a store owner inside this process after `core.shutdownOwner()` had already run
// — nothing shuts that new owner down, so its pipe server keeps the process alive (invariant 2).
// Reordered: every worker is stopped first as before, `markClosed()` then flips write-row.cjs's own
// closed flag, every record's own `w.queue` is drained next (so a write already in flight still reaches
// the store), and only then does the poll stop and the owner go — a write queued after this point (a
// late `exit` event's own fill-in) finds the flag already flipped and elects nothing (write-row.cjs).
const MEMORY_DRAIN_MS = 5000;
// 500 ms longer than head-lookup.cjs's TOTAL_MS, to cover the kill of a git that timed out at its own bound.
const HEAD_DRAIN_MS = 5500;
async function drainHeads(workers) {
  let timer = null;
  const bound = new Promise((res) => { timer = setTimeout(res, HEAD_DRAIN_MS); });
  const one = async (w) => {
    await w.queue.catch(() => {});
    // Build 12 a2: the base_sha rev-parse started at record creation has the worktree as its cwd; wait for it too.
    if (w.basePromise) await w.basePromise.catch(() => {});
    if (w.headPromise) { await w.headPromise.catch(() => {}); await w.queue.catch(() => {}); }
  };
  await Promise.race([Promise.all([...workers.values()].map(one)), bound]);
  clearTimeout(timer);
}
// Invariant 1 and ADR 0029: every child this process spawned dies by its exact pid whatever a row write did.
// Reached only when `stop` threw; the kill is the subtree first, then the exact pid, as doStop does.
// Only while the handle proves the pid is still ours: the child has neither exited nor been signalled and the
// record has not settled, so the pid cannot have been reused by a bystander. Returns the receipt or null.
async function killSurvivor(w, e) {
  const pid = w.pid;
  const ours = w.child && w.child.exitCode === null && w.child.signalCode === null && !w.settled;
  if (!ours || !pid || !P.pidAlive(pid)) return null;
  w.treeKill = (await P.killProcess(w.child).catch(() => ({ tree: null }))).tree; // ADR 0039: by the live handle
  const gone = await P.waitPidGone(pid, { timeoutMs: 5000 });
  return { worker_id: w.id, code: (e && e.code) || null, pid, pid_gone_ms: gone, tree_kill: w.treeKill || null };
}
async function shutdown(workers, { stop, core, clearPoll, markClosed, markOwnerGone, onDrained }) {
  const t0 = now();
  const stopped = [];
  const left_parked = [];
  const left_stale = [];
  const stop_failed = [];
  for (const w of [...workers.values()]) {
    if (w.staleSince) { left_stale.push(w.id); continue; }
    if (parked(w)) { left_parked.push(w.id); continue; }
    if (w.op && w.op.name === 'pause') {
      await w.op.promise.catch(() => {});
      if (w.staleSince) { left_stale.push(w.id); continue; }
      if (parked(w)) { left_parked.push(w.id); continue; }
    }
    try {
      await stop({ worker_id: w.id, mode: 'graceful', timeout_ms: 10000 });
      stopped.push(w.id);
    } catch (e) {
      w.lastError = { where: 'shutdown', code: e && e.code, message: e && e.message };
      const k = await killSurvivor(w, e); if (k) stop_failed.push(k); // build 12 A10: a failed stop (its row write threw) must not leave the child alive
    }
  }
  // ADR 0029 amendment 2 item 4: a head follow-up is queued only once git answers, and markClosed turns every
  // later write away. Each worker's own queue is drained, its pending head request awaited, and its queue
  // drained again (the follow-up is on it by then), all inside one HEAD_DRAIN_MS bound, before the flag flips.
  await drainHeads(workers);
  if (markClosed) markClosed();
  await Promise.all([...workers.values()].map((w) => w.queue.catch(() => {})));
  // Review 3, finding F: the turn memory writes (turn-record.cjs queueMemory) are off the turn path; a
  // write already in flight is given at most 5,000 ms to land before the core goes, and any queue still
  // busy after that is named on the record. A write not yet started sees the closed flag and drops itself.
  const gaveUp = [];
  await Promise.all([...workers.values()].filter((w) => w.memoryQueue).map(async (w) => {
    let timer = null;
    const done = await Promise.race([w.memoryQueue.then(() => true, () => true), new Promise((res) => { timer = setTimeout(() => res(false), MEMORY_DRAIN_MS); })]);
    clearTimeout(timer);
    if (!done) { gaveUp.push(w.id); w.lastError = { where: 'shutdown', state: 'memory-queue-gave-up', bound_ms: MEMORY_DRAIN_MS }; }
  }));
  // ADR 0041/0043: the run's end-of-run memory jobs run once every queue has drained and before the owner goes, so
  // their writes cannot re-elect one. They catch their own failures; this await never blocks the shutdown on one.
  if (onDrained) await onDrained().catch(() => {});
  clearPoll();
  // ADR 0029 amendment 2 item 3: stop only an owner this process holds. An adapter that is not the owner
  // would otherwise send the pipe `shutdown` to belay run's own store owner. A core with no isOwner is a
  // test double, which never holds one: the rule fails closed, as belay-mcp.cjs's own shutdown does.
  const holdsOwner = typeof core.isOwner === 'function' && core.isOwner();
  // A write that was already sent may still pair an event with its row until here; past this line none is sent.
  if (markOwnerGone) markOwnerGone();
  if (holdsOwner && typeof core.shutdownOwner === 'function') await core.shutdownOwner().catch(() => {});
  return { stopped, left_parked, left_stale, stop_failed, memory_gave_up: gaveUp, ms: now() - t0 };
}

// build step 6e-5 design item 5 (review 1/2, worker.cjs's `adopt`): the worker row carries no column for
// model, allowed tools or the permission-prompt opt-in, so a cross-adapter relaunch used to fall back to
// this build's bare defaults. The last launch's own argv.json (written by `launch`, manager.cjs) and
// mcp.json name what actually ran; a read or parse failure is recorded on the result, never thrown.
function readLaunchOptions(dir) {
  const out = { model: null, allowedTools: null, tools: null, permissionPrompt: false, permitWaitMs: null, error: null };
  try {
    const argv = JSON.parse(fs.readFileSync(path.join(dir, 'argv.json'), 'utf8')).spec.args;
    const modelAt = argv.indexOf('--model');
    if (modelAt >= 0) out.model = argv[modelAt + 1];
    const toolsAt = argv.indexOf('--allowedTools');
    if (toolsAt >= 0) {
      const tools = [];
      for (let i = toolsAt + 1; i < argv.length && !String(argv[i]).startsWith('--'); i += 1) tools.push(argv[i]);
      out.allowedTools = tools;
    }
    out.permissionPrompt = argv.includes('--permission-prompt-tool');
    const builtinsAt = argv.indexOf('--tools'); // ADR 0024: a narrowed list survives a cross-adapter relaunch
    if (builtinsAt >= 0) out.tools = require('./surface.cjs').narrowTools(String(argv[builtinsAt + 1]).split(','));
  } catch (e) {
    out.error = { where: 'argv.json', code: e && e.code, message: e && e.message };
  }
  try {
    const mcp = JSON.parse(fs.readFileSync(path.join(dir, 'mcp.json'), 'utf8'));
    const server = mcp.mcpServers && Object.values(mcp.mcpServers)[0];
    const pwmAt = server && server.args ? server.args.indexOf('--permit-wait-ms') : -1;
    if (pwmAt >= 0) out.permitWaitMs = Number(server.args[pwmAt + 1]);
  } catch (e) {
    out.error = out.error || { where: 'mcp.json', code: e && e.code, message: e && e.message };
  }
  return out;
}

module.exports = { runOp, shutdown, readLaunchOptions };
