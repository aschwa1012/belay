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
const { NOTE_REVIEW_DRAIN_MS } = require('../core/spawn-bounds.cjs');

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
const PAIRED_DRAIN_MS = 2000; // paired events already sent when the owner is about to go
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
// Each worker's memory queue, bounded by one MEMORY_DRAIN_MS per worker. Returns the ids that had not finished. The queue is
// re-read until it stops changing, because a job on it appends the next link from inside the first. With `turns` the worker's own
// `queue` is awaited first: a turn_end is queued there at the moment it is parsed (worker.cjs), and onTurnEnd creates the memory
// queue only after its waiters and its row, so a close that follows the turn at once would otherwise find no memory queue yet.
async function settleQueues(w, turns) {
  if (turns) await w.queue.catch(() => {});
  for (let q; q !== w.memoryQueue;) { q = w.memoryQueue; if (q) await q.catch(() => {}); }
  return true;
}
async function drainMemoryQueues(workers, turns = false, boundMs = MEMORY_DRAIN_MS) {
  const gaveUp = [];
  await Promise.all([...workers.values()].filter((w) => turns || w.memoryQueue).map(async (w) => {
    let timer = null;
    const done = await Promise.race([settleQueues(w, turns), new Promise((res) => { timer = setTimeout(() => res(false), boundMs); })]);
    clearTimeout(timer);
    if (!done) { gaveUp.push(w.id); w.lastError = { where: 'shutdown', state: 'memory-queue-gave-up', bound_ms: boundMs }; }
  }));
  return gaveUp;
}
async function shutdown(workers, { stop, core, clearPoll, markClosed, markOwnerGone, onDrained, beforeStop, queuesFirst, markClosing, drainBudgetMs }) {
  // Wave 4: a review job in flight finishes before any worker is stopped. A turn's memory queue is awaited first (bounded), because
  // the queue is what creates the review job: draining jobs before it would find none and let the job spawn after the stop loop.
  let queuesGaveUp = null;
  // Only when the run expects review jobs (queuesFirst): any other run keeps its queues' one wait, after the flag flips.
  // ONE budget (NOTE_REVIEW_DRAIN_MS) covers the turn queues, the first job drain and the second: `belay run` gives the adapter that much and
  // no more (run-close.cjs). The second drain keeps a floor of the budget so the receipts of jobs stopped below can still be written.
  const budget = typeof drainBudgetMs === 'number' ? drainBudgetMs : NOTE_REVIEW_DRAIN_MS;
  const floor = Math.min(2000, Math.floor(budget / 4));
  const tBudget = now();
  const left = (keep) => Math.max(0, budget - keep - (now() - tBudget));
  if (beforeStop) {
    if (queuesFirst && queuesFirst()) queuesGaveUp = await drainMemoryQueues(workers, true, Math.min(MEMORY_DRAIN_MS, left(floor))).catch(() => []);
    await Promise.resolve().then(() => beforeStop(left(floor))).catch(() => {});
    if (markClosing) markClosing(); // no review job starts past here; one already spawning is stopped below
  }
  const t0 = now();
  const stopped = [];
  const left_parked = [];
  const left_stale = [];
  const stop_failed = [];
  const seen = new Set();
  const stopOne = async (w) => {
    seen.add(w.id);
    if (w.staleSince) { left_stale.push(w.id); return; }
    if (parked(w)) { left_parked.push(w.id); return; }
    if (w.op && w.op.name === 'pause') {
      await w.op.promise.catch(() => {});
      if (w.staleSince) { left_stale.push(w.id); return; }
      if (parked(w)) { left_parked.push(w.id); return; }
    }
    try {
      await stop({ worker_id: w.id, mode: 'graceful', timeout_ms: 10000 });
      stopped.push(w.id);
    } catch (e) {
      w.lastError = { where: 'shutdown', code: e && e.code, message: e && e.message };
      const k = await killSurvivor(w, e); if (k) stop_failed.push(k); // build 12 A10: a failed stop (its row write threw) must not leave the child alive
    }
  };
  for (const w of [...workers.values()]) await stopOne(w);
  // A worker that joined the map while the loop ran (a review job whose spawn was already under way) is stopped too, until none is new.
  for (let extra = [...workers.values()].filter((w) => !seen.has(w.id)); extra.length; extra = [...workers.values()].filter((w) => !seen.has(w.id))) for (const w of extra) await stopOne(w);
  // Jobs stopped above write their receipts now, while the store is still open (and before the owner is marked gone).
  if (beforeStop) await Promise.resolve().then(() => beforeStop(left(0))).catch(() => {});
  // ADR 0029 amendment 2 item 4: a head follow-up is queued only once git answers, and markClosed turns every
  // later write away. Each worker's own queue is drained, its pending head request awaited, and its queue
  // drained again (the follow-up is on it by then), all inside one HEAD_DRAIN_MS bound, before the flag flips.
  await drainHeads(workers);
  if (markClosed) markClosed();
  await Promise.all([...workers.values()].map((w) => w.queue.catch(() => {})));
  // Review 3, finding F: the turn memory writes (turn-record.cjs queueMemory) are off the turn path; a
  // write already in flight is given at most 5,000 ms to land before the core goes, and any queue still
  // busy after that is named on the record. A write not yet started sees the closed flag and drops itself;
  // the event for a write already sent is kept until the owner goes (below).
  // A queue that already used its bound before the review drain is named, not waited on a second time.
  const gaveUp = queuesGaveUp ? [...queuesGaveUp] : [];
  gaveUp.push(...await drainMemoryQueues(new Map([...workers].filter(([, w]) => !gaveUp.includes(w.id)))));
  // ADR 0041/0043: the run's end-of-run memory jobs run once every queue has drained and before the owner goes, so
  // their writes cannot re-elect one. They catch their own failures; this await never blocks the shutdown on one.
  if (onDrained) await onDrained().catch(() => {});
  clearPoll();
  // ADR 0029 amendment 2 item 3: stop only an owner this process holds. An adapter that is not the owner
  // would otherwise send the pipe `shutdown` to belay run's own store owner. A core with no isOwner is a
  // test double, which never holds one: the rule fails closed, as belay-mcp.cjs's own shutdown does.
  const holdsOwner = typeof core.isOwner === 'function' && core.isOwner();
  // An event for a row already sent is kept until here; past this line none is sent. Those already sent get
  // PAIRED_DRAIN_MS to land, and a macrotask, before the owner goes: a write begun after it would elect another.
  let pairedGaveUp = 0;
  if (markOwnerGone) {
    const inflight = [...(markOwnerGone() || [])];
    if (inflight.length) {
      let timer = null;
      const done = await Promise.race([Promise.allSettled(inflight).then(() => true), new Promise((res) => { timer = setTimeout(() => res(false), PAIRED_DRAIN_MS); })]);
      clearTimeout(timer);
      if (!done) pairedGaveUp = inflight.length;
    }
    await new Promise((res) => setImmediate(res));
  }
  if (holdsOwner && typeof core.shutdownOwner === 'function') await core.shutdownOwner().catch(() => {});
  return { stopped, left_parked, left_stale, stop_failed, memory_gave_up: gaveUp, paired_gave_up: pairedGaveUp, ms: now() - t0 };
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

module.exports = { runOp, shutdown, readLaunchOptions, killSurvivor };
